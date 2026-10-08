/**
 * Translation worker — the only place provider keys are opened and provider
 * HTTP calls are made.
 *
 * Responsibilities:
 *  - unseal the API keys once per session (WebCrypto, PBKDF2) and keep the
 *    plaintext in this thread only — device-bound rows use the device secret
 *    shipped over postMessage, because workers cannot read localStorage;
 *  - own the key pool: rotation, token buckets, cooldowns, backoff;
 *  - run the batch engine (prompts → request → strict validation → retry
 *    ladder → terminology/glossary post-processing);
 *  - stream `tick` / `waiting` / `resumed` messages so the main thread can
 *    render live progress and the WAITING_RATE_LIMIT countdown.
 *
 * The main thread owns Dexie: results come back here as plain data and are
 * persisted there, immediately after every batch.
 */

/// <reference lib="webworker" />

import { decodeSealed, openText } from '@/core/crypto'
import { computeBudget } from '@/translate/budget'
import { defaultSleep, type BatchTransport } from '@/translate/executor'
import { runBatch } from '@/translate/engine'
import { KeyPool, type KeySeed, type PersistedKeyState } from '@/translate/keyPool'
import type {
  MainToWorker,
  OpenMessage,
  RunnerSession,
  RunMessage,
  WorkerToMain,
  WaitingReason,
} from '@/translate/protocol'
import { resetTokenScale } from '@/translate/tokenEstimate'
import { getAdapter } from '@/providers'
import { ProviderError } from '@/providers/types'
import type { ReasonCode } from '@/core/reasonCodes'

const scope = self as unknown as DedicatedWorkerGlobalScope

let session: RunnerSession | null = null
let pool: KeyPool | null = null
const controllers = new Map<string, AbortController>()

function post(message: WorkerToMain): void {
  scope.postMessage(message)
}

function poolStates(): PersistedKeyState[] {
  return pool ? pool.persistedAll() : []
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Maps a terminal failure onto the reason code the Status Panel explains. */
function reasonFor(error: unknown): { reasonCode: ReasonCode; message: string } {
  if (error instanceof ProviderError) {
    const message = error.message
    switch (error.kind) {
      case 'unauthorized':
        return {
          reasonCode: /no api key/i.test(message) ? 'NO_API_KEY' : 'INVALID_KEY',
          message,
        }
      case 'forbidden':
        return { reasonCode: 'INVALID_KEY', message }
      case 'quota':
        return { reasonCode: 'QUOTA_EXHAUSTED', message }
      case 'rate_limit':
        return { reasonCode: 'ALL_KEYS_COOLING_DOWN', message }
      case 'server':
        return { reasonCode: 'ALL_KEYS_COOLING_DOWN', message }
      case 'network':
      case 'timeout':
        return { reasonCode: 'NETWORK_OFFLINE', message }
      case 'model_missing':
        return { reasonCode: 'MODEL_UNAVAILABLE', message }
      case 'bad_request':
      case 'unknown':
      default:
        return { reasonCode: 'BAD_JSON_RESPONSE', message }
    }
  }
  return {
    reasonCode: 'BAD_JSON_RESPONSE',
    message: error instanceof Error ? error.message : String(error),
  }
}

async function seedFromRow(
  row: OpenMessage['keys'][number],
  passphrase?: string | null,
  deviceSecret?: string | null,
): Promise<KeySeed> {
  let secret: string | null = null
  try {
    // Workers cannot read localStorage (Storage is Window-only), so
    // device-bound rows open with the device secret the main thread ships
    // in the open message — passphrase still wins when one is set.
    secret = await openText(decodeSealed(row.cipher), passphrase ?? deviceSecret ?? undefined)
  } catch {
    // A key sealed with a passphrase we do not have is simply unusable here.
    secret = null
  }
  const persisted: Partial<PersistedKeyState> = {
    id: row.id,
    enabled: row.enabled !== false,
    status: row.status,
    statusDetail: row.statusDetail,
    cooldownUntil: row.cooldownUntil ?? 0,
    cooldownReason: row.cooldownReason ?? null,
    lastCheckedAt: row.lastCheckedAt,
    requests: row.requests ?? 0,
    tokensIn: row.tokensIn ?? 0,
    tokensOut: row.tokensOut ?? 0,
    lastUsedAt: row.lastUsedAt ?? 0,
    ...(row.buckets ? { buckets: row.buckets } : {}),
  }
  return {
    id: row.id,
    provider: row.provider,
    nickname: row.label,
    lastFour: row.lastFour,
    enabled: row.enabled !== false,
    secret,
    persisted,
  }
}

async function handleOpen(message: OpenMessage): Promise<void> {
  const nextPool = new KeyPool({ strategy: message.config.strategy })
  nextPool.configureLimits(message.limits)
  const seeds = await Promise.all(
    message.keys.map((row) =>
      seedFromRow(row, message.passphrase ?? null, message.deviceSecret ?? null),
    ),
  )
  nextPool.setKeys(seeds)
  pool = nextPool
  // A new session starts from the static script weights; the first few
  // responses re-calibrate them against this provider's real tokenizer.
  resetTokenScale()
  session = {
    sessionId: message.sessionId,
    config: message.config,
    models: message.models,
    limits: message.limits,
    keys: message.keys,
  }
  post({ kind: 'opened', id: message.id, keyCount: seeds.filter((seed) => seed.secret).length })
}

async function handleRun(message: RunMessage): Promise<void> {
  const activePool = pool
  const activeSession = session
  if (!activePool || !activeSession) {
    post({
      kind: 'failed',
      id: message.id,
      reasonCode: 'PROVIDER_NOT_CONFIGURED',
      message: 'No translation session is open',
      states: [],
    })
    return
  }

  const controller = new AbortController()
  controllers.set(message.id, controller)
  const adapter = getAdapter(message.config.provider)
  // One profile for the whole chain: the narrowest window wins, so a batch
  // sized for the selected model also fits whatever fallback answers instead.
  const budget = computeBudget({
    provider: message.config.provider,
    models: message.models,
    quality: message.config.quality,
    sourceLang: message.config.sourceLang,
    targetLang: message.config.targetLang,
    terminologyScope: message.config.terminologyScope,
    glossary: message.glossary,
  })
  let waiting = false

  const transport: BatchTransport = async (input) => {
    const result = await adapter.translate(
      input.lease.secret,
      { ...input.call, model: input.model },
      {
        signal: input.signal,
        baseUrl: message.config.baseUrl || undefined,
      },
    )
    post({
      kind: 'tick',
      id: message.id,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      model: input.model,
      keyId: input.lease.keyId,
      maskedKey: input.lease.masked,
      requests: 1,
    })
    return {
      text: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      rate: result.rate,
    }
  }

  try {
    const seenPage = new Set(message.seenPage)
    const seenDocument = new Set(message.seenDocument)
    const result = await runBatch(message.batch, {
      pool: activePool,
      models: message.models,
      transport,
      quality: message.config.quality,
      sourceLang: message.config.sourceLang,
      targetLang: message.config.targetLang,
      terminologyScope: message.config.terminologyScope,
      glossary: message.glossary,
      budget,
      // The provider's `usage` is the ground truth for how expensive this
      // script really is — let it correct the estimator for the rest of the run.
      calibrate: true,
      context: message.context,
      signal: controller.signal,
      sleep: defaultSleep,
      seenPage,
      seenDocument,
      hooks: {
        onWaiting: (until: number, reason: WaitingReason) => {
          waiting = true
          post({ kind: 'waiting', id: message.id, until, reason })
        },
        onLease: () => {
          if (waiting) {
            waiting = false
            post({ kind: 'resumed', id: message.id, at: Date.now() })
          }
        },
        onModelFallback: () => {
          /* the result carries the model that actually answered */
        },
      },
    })
    post({
      kind: 'result',
      id: message.id,
      result,
      states: poolStates(),
      seenPage: [...seenPage],
      seenDocument: [...seenDocument],
    })
  } catch (error) {
    if (controller.signal.aborted || isAbort(error)) {
      post({ kind: 'cancelled', id: message.id, states: poolStates() })
    } else {
      const { reasonCode, message: text } = reasonFor(error)
      post({ kind: 'failed', id: message.id, reasonCode, message: text, states: poolStates() })
    }
  } finally {
    controllers.delete(message.id)
  }
}

async function handle(message: MainToWorker): Promise<void> {
  switch (message.kind) {
    case 'open':
      await handleOpen(message)
      return
    case 'run':
      await handleRun(message)
      return
    case 'cancel': {
      controllers.get(message.id)?.abort()
      return
    }
    case 'close': {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      pool = null
      session = null
      return
    }
    default:
      return
  }
}

scope.addEventListener('message', (event: MessageEvent<MainToWorker>) => {
  void handle(event.data)
})
