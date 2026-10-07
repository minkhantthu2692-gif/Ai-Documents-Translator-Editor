/**
 * Rate-limit header parsing.
 *
 * Every provider exposes limits differently; this module normalises them into
 * one shape the key pool can reason about. Values are treated as *hints*: a
 * bucket falls back to the model config estimate when a header is missing, and
 * the longest trustworthy cooldown wins.
 */

export interface RateLimitInfo {
  /** Requests allowed in the current window (null = header absent). */
  limit: number | null
  /** Requests left in the current window. */
  remaining: number | null
  /** Epoch ms when the window resets. */
  resetAt: number | null
  /** Server-mandated wait in ms (`Retry-After`). */
  retryAfterMs: number | null
  /** Token ceiling / remaining for the window, when exposed. */
  tokensLimit: number | null
  tokensRemaining: number | null
}

export const EMPTY_RATE_LIMIT: RateLimitInfo = {
  limit: null,
  remaining: null,
  resetAt: null,
  retryAfterMs: null,
  tokensLimit: null,
  tokensRemaining: null,
}

export function emptyRateLimit(): RateLimitInfo {
  return { ...EMPTY_RATE_LIMIT }
}

/** First header value, case-insensitive (Headers is already case-insensitive). */
function header(headers: Headers, ...names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null && value !== '') return value
  }
  return null
}

function number(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Parses `Retry-After`: delta-seconds, an HTTP-date, or a provider duration
 * (`"1s"`, `"10m30s"`, `"PT1M30S"`). Returns milliseconds from `now`.
 */
export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null || value === '') return null
  const trimmed = value.trim()

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    // A plain number that looks like an epoch is a timestamp, not a delta.
    if (seconds > 1_000_000_000) return Math.max(0, seconds * 1000 - now)
    return seconds * 1000
  }

  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return Math.max(0, date - now)

  const duration = parseDurationMs(trimmed)
  return duration
}

/**
 * Parses a reset hint into an absolute epoch ms.
 *
 * Accepted shapes:
 *  - `unix seconds` (OpenRouter `x-ratelimit-reset`)
 *  - `unix milliseconds`
 *  - delta seconds (`42`)
 *  - duration (`42s`, `1m30s`, `PT1M30S`)
 *  - HTTP-date
 */
export function parseResetAt(value: string | null, now: number): number | null {
  if (value === null || value === '') return null
  const trimmed = value.trim()

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    // ~1.7e9 is a unix-seconds timestamp, ~1.7e12 a unix-milliseconds one.
    if (numeric > 1e11) return Math.round(numeric)
    if (numeric > 1e9) return numeric * 1000
    return now + numeric * 1000
  }

  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return date

  const duration = parseDurationMs(trimmed)
  return duration === null ? null : now + duration
}

/** `90`, `90s`, `1m30s`, `2h5m`, `PT1M30S` → milliseconds. */
export function parseDurationMs(value: string): number | null {
  const iso = /^P(?:\d+D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/i.exec(value.trim())
  if (iso && (iso[1] || iso[2] || iso[3])) {
    const hours = Number(iso[1] ?? 0)
    const minutes = Number(iso[2] ?? 0)
    const seconds = Number(iso[3] ?? 0)
    return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000)
  }

  const parts = /^((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)$/i.exec(value.trim())
  if (parts && parts[1]) {
    const body = parts[1]
    const hours = Number(/(\d+)h/i.exec(body)?.[1] ?? 0)
    const minutes = Number(/(\d+)m/i.exec(body)?.[1] ?? 0)
    const seconds = Number(/(\d+(?:\.\d+)?)s/i.exec(body)?.[1] ?? 0)
    const total = (hours * 60 + minutes) * 60 + seconds
    if (total > 0) return Math.round(total * 1000)
  }

  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000
  return null
}

/**
 * Generic parser covering the `x-ratelimit-*` family used by OpenRouter, Groq
 * and the Gemini API (with and without a resource suffix).
 */
export function parseRateLimitHeaders(headers: Headers, now: number): RateLimitInfo {
  const retryAfter = parseRetryAfterMs(header(headers, 'retry-after'), now)

  const limit = number(
    header(headers, 'x-ratelimit-limit-requests', 'x-ratelimit-limit', 'x-rate-limit-limit'),
  )
  const remaining = number(
    header(
      headers,
      'x-ratelimit-remaining-requests',
      'x-ratelimit-remaining',
      'x-rate-limit-remaining',
    ),
  )
  const resetAt = parseResetAt(
    header(headers, 'x-ratelimit-reset-requests', 'x-ratelimit-reset', 'x-rate-limit-reset'),
    now,
  )
  const tokensLimit = number(header(headers, 'x-ratelimit-limit-tokens', 'x-ratelimit-limit-tpm'))
  const tokensRemaining = number(
    header(headers, 'x-ratelimit-remaining-tokens', 'x-ratelimit-remaining-tpm'),
  )

  return {
    limit,
    remaining,
    resetAt: retryAfter !== null ? now + retryAfter : resetAt,
    retryAfterMs: retryAfter,
    tokensLimit,
    tokensRemaining,
  }
}

/** Merges two reads, keeping the most informative value of each field. */
export function mergeRateLimit(a: RateLimitInfo, b: RateLimitInfo): RateLimitInfo {
  return {
    limit: a.limit ?? b.limit,
    remaining: a.remaining ?? b.remaining,
    resetAt: a.resetAt ?? b.resetAt,
    retryAfterMs: a.retryAfterMs ?? b.retryAfterMs,
    tokensLimit: a.tokensLimit ?? b.tokensLimit,
    tokensRemaining: a.tokensRemaining ?? b.tokensRemaining,
  }
}
