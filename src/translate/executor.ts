/**
 * Rotation executor — "send this exact call, on whichever key can take it".
 *
 * Guarantees the Phase 3 acceptance criteria rest on:
 *  - a 429 on key A rotates to key B **and re-runs the same call**, so a batch
 *    is either fully delivered or still pending — never half-applied;
 *  - 401/403 marks the key invalid instead of retrying it forever;
 *  - when every key is cooling the loop parks on `availableAt()` (the
 *    WAITING_RATE_LIMIT countdown) and resumes by itself;
 *  - a missing model walks the fallback chain, then gives up with
 *    MODEL_UNAVAILABLE instead of burning quota.
 *
 * Pure async code with injected transport/sleep — the 429-storm tests drive it
 * on a virtual clock.
 */

import { ProviderError, RETRYABLE_KINDS, type ProviderErrorKind } from '@/providers/types'
import type { RateLimitInfo } from '@/providers/rateLimit'
import type { KeyPool, KeyLease } from './keyPool'
import type { TranslateCall } from '@/providers/types'

export interface TransportOk {
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  rate: RateLimitInfo
}

export interface TransportInput {
  call: TranslateCall
  lease: KeyLease
  model: string
  signal?: AbortSignal
}

export type BatchTransport = (input: TransportInput) => Promise<TransportOk>

export type WaitingReason = 'ALL_KEYS_COOLING_DOWN' | 'QUOTA_EXHAUSTED'

export interface ExecutorHooks {
  /** Called every time the executor parks until `until` (auto-resume). */
  onWaiting?: (until: number, reason: WaitingReason) => void
  /** Called after each failed attempt (before the next key/model is chosen). */
  onRetry?: (info: {
    keyId: string
    kind: ProviderErrorKind
    detail: string
    model: string
  }) => void
  /** Called when the model chain advances (404 from the provider). */
  onModelFallback?: (model: string) => void
  /** Called when a lease is taken, so the UI can show the masked key. */
  onLease?: (lease: KeyLease, model: string) => void
}

export interface ExecutorOptions {
  pool: KeyPool
  /** Ordered model chain: selected model first, then fallbacks. */
  models: string[]
  transport: BatchTransport
  tokenEstimate?: number
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Consecutive failures tolerated before the run fails hard. */
  maxConsecutiveFailures?: number
  hooks?: ExecutorHooks
}

export interface ExecutorResult {
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  rate: RateLimitInfo
  keyId: string
  maskedKey: string
  model: string
  /** Attempts spent (1 = first key, first model). */
  attempts: number
  /** Round trips that needed a retry of any kind. */
  retries: number
}

/** Abortable sleep; the default clock used by the executor. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof DOMException && error.name === 'AbortError'
}

function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out/i.test(message)) {
    return new ProviderError('timeout', message, { cause: error })
  }
  if (/abort/i.test(message)) return new ProviderError('network', message, { cause: error })
  return new ProviderError('network', message, { cause: error })
}

/**
 * Runs one logical request to completion, rotating over keys and models.
 * Rejects only when the call can no longer make progress (dead keys, bad
 * request, model chain exhausted, failure budget spent) or on abort.
 */
export async function executeWithRotation(
  makeCall: () => TranslateCall,
  options: ExecutorOptions,
): Promise<ExecutorResult> {
  const {
    pool,
    transport,
    tokenEstimate = 0,
    signal,
    now = () => Date.now(),
    sleep = defaultSleep,
    maxConsecutiveFailures = 30,
    hooks = {},
  } = options

  const models = options.models.filter((model) => model.length > 0)
  if (models.length === 0) {
    throw new ProviderError('model_missing', 'No model configured for this run')
  }

  let modelIndex = 0
  let attempts = 0
  let retries = 0
  let consecutiveFailures = 0
  let lastError: ProviderError | null = null

  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    const lease = pool.pick(tokenEstimate, now())
    if (lease) {
      const model = models[Math.min(modelIndex, models.length - 1)]
      attempts += 1
      hooks.onLease?.(lease, model)
      try {
        const outcome = await transport({ call: makeCall(), lease, model, signal })
        pool.reportSuccess(lease.keyId, {
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          rate: outcome.rate,
          now: now(),
        })
        return {
          text: outcome.text,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          latencyMs: outcome.latencyMs,
          rate: outcome.rate,
          keyId: lease.keyId,
          maskedKey: lease.masked,
          model,
          attempts,
          retries,
        }
      } catch (error) {
        if (isAbort(error, signal)) throw error
        const providerError = asProviderError(error)
        lastError = providerError
        consecutiveFailures += 1
        retries += 1
        hooks.onRetry?.({
          keyId: lease.keyId,
          kind: providerError.kind,
          detail: providerError.message,
          model,
        })

        switch (providerError.kind) {
          case 'unauthorized':
          case 'forbidden':
            pool.markInvalid(lease.keyId, providerError.message, now())
            break
          case 'rate_limit':
            pool.reportRateLimit(lease.keyId, {
              retryAfterMs: providerError.retryAfterMs,
              quota: false,
              rate: providerError.rate,
              now: now(),
            })
            break
          case 'quota':
            pool.reportRateLimit(lease.keyId, {
              retryAfterMs: providerError.retryAfterMs,
              quota: true,
              rate: providerError.rate,
              now: now(),
            })
            break
          case 'server':
          case 'network':
          case 'timeout':
            pool.reportTransient(lease.keyId, now())
            break
          case 'model_missing':
            if (modelIndex < models.length - 1) {
              modelIndex += 1
              hooks.onModelFallback?.(models[modelIndex])
              break
            }
            // The whole chain answered 404 — retrying the last known-missing
            // model only burns quota, so surface MODEL_UNAVAILABLE now.
            throw providerError
          case 'bad_request':
          case 'unknown':
            // Not the key's fault — retrying on another key would waste quota.
            throw providerError
          default:
            break
        }

        if (consecutiveFailures >= maxConsecutiveFailures) {
          throw (
            lastError ??
            new ProviderError('server', 'Too many consecutive failures without a success')
          )
        }
        continue
      }
    }

    // No key right now: wait for the earliest cooldown/bucket reset.
    const until = pool.availableAt(tokenEstimate, now())
    if (until === null) {
      const reason = pool.exhaustionReason(now())
      if (reason === 'NO_API_KEY') {
        throw new ProviderError('unauthorized', 'No API key is configured for this provider')
      }
      if (reason === 'INVALID_KEY') {
        throw new ProviderError('unauthorized', 'Every configured key was rejected')
      }
      // Unknown deadline (e.g. bucket windows already rolled over) — back off a
      // little instead of spinning.
      const fallbackUntil = now() + 5_000
      const waitingReason: WaitingReason =
        reason === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'ALL_KEYS_COOLING_DOWN'
      hooks.onWaiting?.(fallbackUntil, waitingReason)
      await sleep(Math.max(0, fallbackUntil - now()), signal)
      continue
    }

    const reason: WaitingReason =
      pool.exhaustionReason(now()) === 'QUOTA_EXHAUSTED'
        ? 'QUOTA_EXHAUSTED'
        : 'ALL_KEYS_COOLING_DOWN'
    consecutiveFailures = 0
    hooks.onWaiting?.(until, reason)
    const waitMs = Math.max(0, until - now())
    await sleep(waitMs, signal)
  }
}

/** True when an error is worth rotating to another key/model. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return true
  return RETRYABLE_KINDS.includes(error.kind) || error.kind === 'model_missing'
}
