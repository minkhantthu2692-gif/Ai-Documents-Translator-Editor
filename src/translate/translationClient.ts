/**
 * Typed transport to the translation worker.
 *
 * One `run` message → one terminal message (`result` / `failed` / `cancelled`)
 * correlated by an id; `tick`, `waiting` and `resumed` messages are forwarded
 * to the caller's hooks in between so the translate page can render live
 * progress and the rate-limit countdown.
 *
 * The main thread never sees a plaintext key: sealed rows go down, masked
 * snapshots come back.
 */

import TranslationWorker from '@/workers/translation.worker?worker'
import type { ReasonCode } from '@/core/reasonCodes'
import type {
  RunnerHooks,
  RunnerOutcome,
  RunnerRequest,
  RunnerSession,
  TranslateRunner,
  WorkerToMain,
} from './protocol'

/** The run cannot continue (dead keys, bad request, model gone, network). */
export class TranslationRunError extends Error {
  readonly reasonCode: ReasonCode

  constructor(reasonCode: ReasonCode, message: string) {
    super(message)
    this.name = 'TranslationRunError'
    this.reasonCode = reasonCode
  }
}

/** The caller cancelled (or the worker was closed mid-flight). */
export class TranslationRunCancelled extends Error {
  constructor(message = 'translation cancelled') {
    super(message)
    this.name = 'TranslationRunCancelled'
  }
}

interface Pending {
  resolve: (outcome: RunnerOutcome) => void
  reject: (error: Error) => void
  hooks?: RunnerHooks | undefined
}

class WorkerRunner implements TranslateRunner {
  private worker: Worker | null = null
  private sequence = 0
  private readonly pending = new Map<string, Pending>()

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new TranslationWorker()
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.onMessage(event.data)
    worker.onerror = () => {
      for (const [id, entry] of this.pending) {
        entry.reject(new TranslationRunError('NETWORK_OFFLINE', 'translation worker crashed'))
        this.pending.delete(id)
      }
      worker.terminate()
      this.worker = null
    }
    this.worker = worker
    return worker
  }

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}${this.sequence}`
  }

  private onMessage(message: WorkerToMain): void {
    if (message.kind === 'tick' || message.kind === 'waiting' || message.kind === 'resumed') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      if (message.kind === 'tick') entry.hooks?.onTick?.(message)
      else if (message.kind === 'waiting') entry.hooks?.onWaiting?.(message)
      else entry.hooks?.onResumed?.()
      return
    }

    if (message.kind === 'opened') {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.keyCount === 0) {
        // Rows exist (startTranslate rejects an empty set) but none could be
        // opened — a locked vault or a lost device key. Failing here beats
        // limping into a run where every batch dies with NO_API_KEY.
        entry?.reject(
          new TranslationRunError(
            'KEYS_LOCKED',
            'The stored API keys could not be opened (vault passphrase not in memory, or keys restored from another device)',
          ),
        )
        return
      }
      entry?.resolve({
        result: emptyResult(message.id),
        states: [],
        seenPage: [],
        seenDocument: [],
      })
      return
    }

    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    entry.hooks?.onStates?.(message.states)

    if (message.kind === 'result') {
      entry.resolve({
        result: message.result,
        states: message.states,
        seenPage: message.seenPage,
        seenDocument: message.seenDocument,
      })
      return
    }
    if (message.kind === 'cancelled') {
      entry.reject(new TranslationRunCancelled())
      return
    }
    entry.reject(new TranslationRunError(message.reasonCode, message.message))
  }

  async open(session: RunnerSession): Promise<void> {
    const worker = this.ensureWorker()
    const id = this.nextId('open')
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
      })
      worker.postMessage({
        kind: 'open',
        id,
        sessionId: session.sessionId,
        config: session.config,
        models: session.models,
        limits: session.limits,
        keys: session.keys,
        passphrase: session.passphrase ?? null,
        deviceSecret: session.deviceSecret ?? null,
      })
    })
  }

  async run(request: RunnerRequest, hooks?: RunnerHooks): Promise<RunnerOutcome> {
    const worker = this.ensureWorker()
    const id = this.nextId('run')
    return new Promise<RunnerOutcome>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, hooks })
      worker.postMessage({
        kind: 'run',
        id,
        sessionId: request.sessionId,
        config: request.config,
        models: request.models,
        limits: request.limits,
        batch: request.batch,
        glossary: request.glossary,
        context: request.context,
        seenPage: request.seenPage,
        seenDocument: request.seenDocument,
      })
    })
  }

  cancel(id: string): void {
    this.worker?.postMessage({ kind: 'cancel', id })
  }

  cancelAll(): void {
    const ids = [...this.pending.keys()]
    for (const id of ids) this.cancel(id)
  }

  close(): void {
    this.worker?.postMessage({ kind: 'close' })
    for (const [id, entry] of this.pending) {
      entry.reject(new TranslationRunCancelled('translation session closed'))
      this.pending.delete(id)
    }
    this.worker?.terminate()
    this.worker = null
  }
}

function emptyResult(batchId: string): RunnerOutcome['result'] {
  return {
    batchId,
    lines: [],
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    keyId: null,
    model: '',
    latencyMs: 0,
  }
}

export const translationRunner = new WorkerRunner()
