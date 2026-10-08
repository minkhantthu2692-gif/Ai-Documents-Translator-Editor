/**
 * Shared HTTP plumbing for the provider adapters.
 *
 * Rules:
 *  - one place decides what a status code *means* (retryable rate limit vs
 *    dead key vs broken model), so the key pool never has to guess;
 *  - the secret is only ever placed in a header and is scrubbed from every
 *    message we build, which is what makes "no key in logs/network URLs" a
 *    property of the code rather than a promise;
 *  - every request carries a timeout and an abort signal.
 */

import { ProviderError, type ProviderErrorKind } from './types'
import { parseRateLimitHeaders } from './rateLimit'

export const DEFAULT_TIMEOUT_MS = 45_000

export interface HttpResponse {
  status: number
  headers: Headers
  body: unknown
  raw: string
  latencyMs: number
}

export interface JsonRequestOptions {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  /** Secrets that must never surface in an error message. */
  secrets?: string[]
}

/** Replaces every occurrence of a secret with a fixed mask. */
export function redactSecret(text: string, secrets: Array<string | null | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue
    out = out.split(secret).join('••••')
  }
  return out
}

function messageFrom(body: unknown, raw: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const error = record.error ?? record.details
    if (error && typeof error === 'object') {
      const inner = error as Record<string, unknown>
      for (const key of ['message', 'title', 'detail']) {
        if (typeof inner[key] === 'string' && inner[key]) return inner[key] as string
      }
    }
    for (const key of ['message', 'error_description']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string
    }
  }
  return raw.slice(0, 400)
}

/**
 * Body-text signals that mean "burst throttling" or "the allowance is gone".
 *
 * Providers answer **429 for both**, so the status code alone cannot tell them
 * apart — and the difference matters: a burst backs off for seconds, a spent
 * daily allowance must park the key for the rest of the window and surface
 * `QUOTA_EXHAUSTED` instead of retrying against a wall for thirty attempts.
 */
const DAILY_QUOTA_HINT =
  /per[-\s]?day|\/ ?day\b|\bdaily\b|per[-\s]?24 hours|insufficient_quota|exceeded your current/i
const RATE_LIMIT_HINT =
  /per[-\s]?(minute|second|hour)|\/ ?(min|sec)\b|rate limit|too many requests|try again in/i
const QUOTA_HINT = /quota|resource_exhausted|limit reached|usage limit/i

/** True when the provider means the *allowance* ran out, not a burst. */
function looksLikeQuota(text: string): boolean {
  // Daily first: "… requests per day …" and "Rate limit reached: free-models-
  // per-day" both describe a daily cap even though they mention other words.
  if (DAILY_QUOTA_HINT.test(text)) return true
  // A message that describes a short window ("per minute", "try again in 4s")
  // is a burst, even when it mentions the word "quota".
  if (RATE_LIMIT_HINT.test(text)) return false
  return QUOTA_HINT.test(text)
}

export function statusToKind(status: number, bodyText: string): ProviderErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'model_missing'
  if (status === 429) return looksLikeQuota(bodyText) ? 'quota' : 'rate_limit'
  if (status === 400 || status === 422) return 'bad_request'
  if (status === 408 || status === 425 || status >= 500) return 'server'
  if (status >= 400) return 'unknown'
  return 'unknown'
}

/**
 * Performs a JSON request. Rejects with a `ProviderError` carrying the
 * normalised kind plus whatever rate-limit headers accompanied the failure.
 */
export async function requestJson(url: string, options: JsonRequestOptions): Promise<HttpResponse> {
  const secrets = options.secrets ?? []
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('timeout', 'TimeoutError')),
    timeoutMs,
  )
  const onOuterAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    const message = redactSecret(error instanceof Error ? error.message : String(error), secrets)
    throw new ProviderError('network', `Network request failed: ${message}`, { cause: error })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }

  const raw = await response.text().catch(() => '')
  const latencyMs = Date.now() - started
  let body: unknown = null
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
  }

  const rate = parseRateLimitHeaders(response.headers, Date.now())
  if (!response.ok) {
    const providerMessage = redactSecret(messageFrom(body, raw), secrets)
    const kind = statusToKind(response.status, `${providerMessage} ${raw.slice(0, 400)}`)
    throw new ProviderError(kind, `HTTP ${response.status}: ${providerMessage}`.slice(0, 500), {
      status: response.status,
      retryAfterMs: rate.retryAfterMs,
      rate,
    })
  }

  return { status: response.status, headers: response.headers, body, raw, latencyMs }
}

/** Reads `usage` in the shape shared by OpenAI-compatible responses. */
export function usageOf(body: unknown): { tokensIn: number; tokensOut: number } {
  if (!body || typeof body !== 'object') return { tokensIn: 0, tokensOut: 0 }
  const usage = (body as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object') return { tokensIn: 0, tokensOut: 0 }
  const record = usage as Record<string, unknown>
  const prompt = Number(record.prompt_tokens ?? record.input_tokens ?? 0)
  const completion = Number(record.completion_tokens ?? record.output_tokens ?? 0)
  return {
    tokensIn: Number.isFinite(prompt) ? prompt : 0,
    tokensOut: Number.isFinite(completion) ? completion : 0,
  }
}

/** Extracts the assistant text from an OpenAI-style chat completion body. */
export function textFromChatBody(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const choices = (body as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0] as Record<string, unknown>
  const message = first.message ?? first.delta
  if (!message || typeof message !== 'object') return ''
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const text = (part as Record<string, unknown>).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}
