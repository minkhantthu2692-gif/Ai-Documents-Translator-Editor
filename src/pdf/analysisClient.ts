/**
 * Typed transport to the analysis worker.
 *
 * One request → one terminal event, correlated by a generated request id;
 * `progress` events are forwarded to the caller's callback in between. The
 * main thread owns Dexie and the UI — this class only moves bytes and data.
 *
 * Every call accepts an `AbortSignal`: aborting posts a `cancel` message and
 * the promise settles with `AnalysisCancelled` once the worker confirms, so a
 * stale probe or extraction never leaves a dangling promise behind.
 */

import AnalysisWorker from '@/workers/analysis.worker?worker'
import type { ReasonCode } from '@/core/reasonCodes'
import type { ExtractedPage, ProbeResult } from '@/pdf/pdfExtract'
import type { SkipContext } from '@/pdf/skipRules'
import type { AnalysisEvent, AnalysisPayload, AnalysisRequest } from '@/workers/protocol'

/** A request failed for a reason the Status Panel can explain. */
export class AnalysisError extends Error {
  readonly reasonCode: ReasonCode

  constructor(reasonCode: ReasonCode, message: string) {
    super(message)
    this.name = 'AnalysisError'
    this.reasonCode = reasonCode
  }
}

/** The caller aborted, or the worker superseded the request. */
export class AnalysisCancelled extends Error {
  constructor(message = 'analysis cancelled') {
    super(message)
    this.name = 'AnalysisCancelled'
  }
}

export type OpenOutcome =
  { status: 'opened'; pageCount: number } | { status: 'password'; reason: 'missing' | 'incorrect' }

interface PendingRequest {
  resolve: (event: AnalysisEvent) => void
  reject: (error: Error) => void
  onProgress?: ((done: number, total: number) => void) | undefined
}

export interface ProgressHandler {
  onProgress?: ((done: number, total: number) => void) | undefined
}

const TERMINAL_KINDS = new Set<AnalysisEvent['kind']>([
  'opened',
  'passwordRequired',
  'probeResult',
  'extractResult',
  'renderResult',
  'closed',
  'cancelled',
  'error',
])

function unexpected(event: AnalysisEvent): Error {
  return new AnalysisError('PDF_CORRUPTED', `unexpected reply: ${event.kind}`)
}

const renderKey = (fileId: string, pageIndex: number): string => `${fileId}#${pageIndex}`

class AnalysisClient {
  private worker: Worker | null = null
  private sequence = 0
  private readonly pending = new Map<string, PendingRequest>()
  /** `fileId#pageIndex` → request id of the render currently being produced. */
  private readonly renderInFlight = new Map<string, string>()

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new AnalysisWorker()
    worker.onmessage = (event: MessageEvent<AnalysisEvent>) => {
      this.onEvent(event.data)
    }
    worker.onerror = (event: ErrorEvent) => {
      // A worker-level crash must not leave callers waiting forever.
      const error = new AnalysisError('PDF_CORRUPTED', event.message || 'analysis worker failed')
      for (const [id, entry] of [...this.pending]) {
        this.pending.delete(id)
        entry.reject(error)
      }
    }
    this.worker = worker
    return worker
  }

  private onEvent(event: AnalysisEvent): void {
    if (event.kind === 'progress') {
      this.pending.get(event.id)?.onProgress?.(event.done, event.total)
      return
    }
    if (!TERMINAL_KINDS.has(event.kind)) return
    const entry = this.pending.get(event.id)
    if (!entry) return
    this.pending.delete(event.id)
    if (event.kind === 'error') {
      entry.reject(new AnalysisError(event.reasonCode, event.message))
      return
    }
    if (event.kind === 'cancelled') {
      entry.reject(new AnalysisCancelled())
      return
    }
    entry.resolve(event)
  }

  private nextId(): string {
    this.sequence += 1
    return `req-${this.sequence}-${Date.now().toString(36)}`
  }

  /**
   * Sends one request and settles with its terminal event (never with
   * `progress`, `cancelled` or `error` — those become rejections).
   */
  private send(
    message: AnalysisPayload,
    options: { transfer?: Transferable[]; signal?: AbortSignal } & ProgressHandler = {},
    id = this.nextId(),
  ): Promise<AnalysisEvent> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(new AnalysisCancelled())

    const worker = this.ensureWorker()
    const payload = { ...message, id }

    return new Promise<AnalysisEvent>((resolve, reject) => {
      const onAbort = (): void => {
        worker.postMessage({ kind: 'cancel', id } satisfies AnalysisRequest)
      }
      const settle = (finish: () => void): void => {
        signal?.removeEventListener('abort', onAbort)
        finish()
      }

      this.pending.set(id, {
        resolve: (event) => settle(() => resolve(event)),
        reject: (error) => settle(() => reject(error)),
        onProgress: options.onProgress,
      })

      signal?.addEventListener('abort', onAbort, { once: true })
      worker.postMessage(payload, options.transfer ?? [])
    })
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Opens a document from raw bytes (the buffer is transferred, so the caller
   * must re-read the file to open it again).
   */
  async open(
    fileId: string,
    bytes: ArrayBuffer,
    options: { password?: string; signal?: AbortSignal } = {},
  ): Promise<OpenOutcome> {
    const event = await this.send(
      {
        kind: 'open',
        fileId,
        bytes,
        ...(options.password ? { password: options.password } : {}),
      },
      { transfer: [bytes], ...(options.signal ? { signal: options.signal } : {}) },
    )
    if (event.kind === 'passwordRequired') {
      return { status: 'password', reason: event.reason }
    }
    if (event.kind === 'opened') return { status: 'opened', pageCount: event.pageCount }
    throw unexpected(event)
  }

  async probe(
    fileId: string,
    options: { signal?: AbortSignal } & ProgressHandler = {},
  ): Promise<ProbeResult> {
    const event = await this.send({ kind: 'probe', fileId }, options)
    if (event.kind === 'probeResult') return event.result
    throw unexpected(event)
  }

  async extract(
    fileId: string,
    pageIndexes: number[],
    options: {
      ctx?: SkipContext
      headerTexts?: string[]
      footerTexts?: string[]
      convertZawgyi?: boolean
      signal?: AbortSignal
    } & ProgressHandler = {},
  ): Promise<ExtractedPage[]> {
    const event = await this.send(
      {
        kind: 'extract',
        fileId,
        pageIndexes,
        ...(options.ctx ? { ctx: options.ctx } : {}),
        ...(options.headerTexts ? { headerTexts: options.headerTexts } : {}),
        ...(options.footerTexts ? { footerTexts: options.footerTexts } : {}),
        ...(options.convertZawgyi !== undefined ? { convertZawgyi: options.convertZawgyi } : {}),
      },
      options,
    )
    if (event.kind === 'extractResult') return event.pages
    throw unexpected(event)
  }

  async render(
    fileId: string,
    pageIndex: number,
    scale: number,
    mode: 'thumbnail' | 'background',
    options: { signal?: AbortSignal } = {},
  ): Promise<Blob> {
    const key = renderKey(fileId, pageIndex)
    const id = this.nextId()
    this.renderInFlight.set(key, id)
    try {
      const event = await this.send({ kind: 'render', fileId, pageIndex, scale, mode }, options, id)
      if (event.kind === 'renderResult') return event.blob
      throw unexpected(event)
    } finally {
      if (this.renderInFlight.get(key) === id) this.renderInFlight.delete(key)
    }
  }

  /**
   * Drops a queued/in-flight render whose result the UI no longer wants (the
   * page scrolled out of the prefetch window). The worker reports it back as
   * `cancelled`, which settles the matching promise.
   */
  cancelRender(fileId: string, pageIndex: number): void {
    const id = this.renderInFlight.get(renderKey(fileId, pageIndex))
    if (!id || !this.worker) return
    this.worker.postMessage({ kind: 'cancel', id } satisfies AnalysisRequest)
  }

  async close(fileId: string): Promise<void> {
    const event = await this.send({ kind: 'close', fileId })
    if (event.kind !== 'closed') throw unexpected(event)
  }

  /** Drops every pending promise and the worker (app teardown / tests). */
  dispose(): void {
    if (!this.worker) return
    this.worker.terminate()
    this.worker = null
    const error = new AnalysisCancelled('analysis client disposed')
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      entry.reject(error)
    }
  }
}

export const analysisClient = new AnalysisClient()
