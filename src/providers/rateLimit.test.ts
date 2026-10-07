/**
 * Rate-limit header parsing acceptance tests: every provider spells its limits
 * differently, so the parser is pinned to the shapes the key pool consumes.
 * All timestamps are relative to one fixed `now` — no clock is involved.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_RATE_LIMIT,
  emptyRateLimit,
  mergeRateLimit,
  parseDurationMs,
  parseRateLimitHeaders,
  parseResetAt,
  parseRetryAfterMs,
  type RateLimitInfo,
} from './rateLimit'

const NOW = 1_700_000_000_000 // 2023-11-14T22:13:20Z

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

function info(partial: Partial<RateLimitInfo>): RateLimitInfo {
  return { ...emptyRateLimit(), ...partial }
}

describe('parseRetryAfterMs', () => {
  it('treats a plain number as delta-seconds', () => {
    expect(parseRetryAfterMs('45', NOW)).toBe(45_000)
    expect(parseRetryAfterMs('  45  ', NOW)).toBe(45_000)
    expect(parseRetryAfterMs('0', NOW)).toBe(0)
  })

  it('reads an epoch-looking number as a timestamp', () => {
    expect(parseRetryAfterMs('1700000045', NOW)).toBe(45_000)
    // A deadline already in the past clamps to zero instead of going negative.
    expect(parseRetryAfterMs('1699999995', NOW)).toBe(0)
  })

  it('reads an HTTP-date as a deadline', () => {
    expect(parseRetryAfterMs('Tue, 14 Nov 2023 22:14:20 GMT', NOW)).toBe(60_000)
    expect(parseRetryAfterMs('Tue, 14 Nov 2023 22:13:10 GMT', NOW)).toBe(0)
  })

  it('reads provider durations', () => {
    expect(parseRetryAfterMs('1s', NOW)).toBe(1_000)
    expect(parseRetryAfterMs('1m30s', NOW)).toBe(90_000)
    expect(parseRetryAfterMs('PT1M30S', NOW)).toBe(90_000)
    expect(parseRetryAfterMs('2h5m', NOW)).toBe(7_500_000)
  })

  it('returns null for an absent or unusable value', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull()
    expect(parseRetryAfterMs('', NOW)).toBeNull()
    expect(parseRetryAfterMs('   ', NOW)).toBeNull()
  })
})

describe('parseDurationMs', () => {
  it('parses the bare-number, parts and ISO shapes', () => {
    expect(parseDurationMs('90')).toBe(90_000)
    expect(parseDurationMs('90s')).toBe(90_000)
    expect(parseDurationMs('1m30s')).toBe(90_000)
    expect(parseDurationMs('2h5m')).toBe(7_500_000)
    expect(parseDurationMs('PT1M30S')).toBe(90_000)
    expect(parseDurationMs('0.5s')).toBe(500)
  })

  it('rejects values that are not durations', () => {
    expect(parseDurationMs('soon')).toBeNull()
    expect(parseDurationMs('0')).toBe(0)
    expect(parseDurationMs('PT')).toBeNull()
  })
})

describe('parseResetAt', () => {
  it('reads unix seconds as an absolute timestamp', () => {
    expect(parseResetAt('1700000100', NOW)).toBe(1_700_000_100_000)
    expect(parseResetAt('1700000100.5', NOW)).toBe(1_700_000_100_500)
  })

  it('reads unix milliseconds as an absolute timestamp', () => {
    expect(parseResetAt('1700000000000', NOW)).toBe(NOW)
  })

  it('reads a small number as delta-seconds from now', () => {
    expect(parseResetAt('42', NOW)).toBe(NOW + 42_000)
    expect(parseResetAt('0', NOW)).toBe(NOW)
  })

  it('reads durations relative to now', () => {
    expect(parseResetAt('42s', NOW)).toBe(NOW + 42_000)
    expect(parseResetAt('1m30s', NOW)).toBe(NOW + 90_000)
    expect(parseResetAt('PT1M30S', NOW)).toBe(NOW + 90_000)
  })

  it('reads an HTTP-date verbatim', () => {
    expect(parseResetAt('Tue, 14 Nov 2023 22:14:20 GMT', NOW)).toBe(NOW + 60_000)
  })

  it('returns null for an absent or unusable value', () => {
    expect(parseResetAt(null, NOW)).toBeNull()
    expect(parseResetAt('', NOW)).toBeNull()
    expect(parseResetAt('whenever', NOW)).toBeNull()
  })
})

describe('parseRateLimitHeaders', () => {
  it('returns EMPTY_RATE_LIMIT when no headers are present', () => {
    expect(parseRateLimitHeaders(new Headers(), NOW)).toEqual(EMPTY_RATE_LIMIT)
  })

  it('parses the OpenRouter request bucket', () => {
    const parsed = parseRateLimitHeaders(
      headers({
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '59',
        'x-ratelimit-reset-requests': '1700000060',
        'x-ratelimit-limit-tokens': '100000',
        'x-ratelimit-remaining-tokens': '99500',
      }),
      NOW,
    )
    expect(parsed).toEqual({
      limit: 60,
      remaining: 59,
      resetAt: 1_700_000_060_000,
      retryAfterMs: null,
      tokensLimit: 100_000,
      tokensRemaining: 99_500,
    })
  })

  it('parses the unsuffixed x-ratelimit and google x-rate-limit spellings', () => {
    expect(
      parseRateLimitHeaders(
        headers({
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': '12',
          'x-ratelimit-reset': '45',
        }),
        NOW,
      ),
    ).toMatchObject({ limit: 30, remaining: 12, resetAt: NOW + 45_000 })

    expect(
      parseRateLimitHeaders(
        headers({
          'x-rate-limit-limit': '30',
          'x-rate-limit-remaining': '12',
          'x-rate-limit-reset': '45',
        }),
        NOW,
      ),
    ).toMatchObject({ limit: 30, remaining: 12, resetAt: NOW + 45_000 })
  })

  it('parses Retry-After and lets it override the reset hint', () => {
    const parsed = parseRateLimitHeaders(
      headers({
        'retry-after': '30',
        'x-ratelimit-reset': '45',
        'x-ratelimit-remaining-requests': '0',
      }),
      NOW,
    )
    expect(parsed.retryAfterMs).toBe(30_000)
    // The mandated wait is the authoritative deadline, so resetAt follows it.
    expect(parsed.resetAt).toBe(NOW + 30_000)
    expect(parsed.remaining).toBe(0)
  })

  it('keeps the reset hint when Retry-After is absent', () => {
    const parsed = parseRateLimitHeaders(headers({ 'x-ratelimit-reset': '45' }), NOW)
    expect(parsed.retryAfterMs).toBeNull()
    expect(parsed.resetAt).toBe(NOW + 45_000)
  })

  it('nulls out values that are not numbers', () => {
    const parsed = parseRateLimitHeaders(
      headers({
        'x-ratelimit-limit-requests': 'not-a-number',
        'x-ratelimit-remaining-requests': '17',
      }),
      NOW,
    )
    expect(parsed.limit).toBeNull()
    expect(parsed.remaining).toBe(17)
  })
})

describe('mergeRateLimit', () => {
  it('keeps the first read where it has a value and falls back to the second', () => {
    const first = info({ limit: 60, remaining: 0, tokensRemaining: 900 })
    const second = info({ limit: 30, remaining: 25, resetAt: NOW + 1_000, tokensLimit: 40_000 })

    expect(mergeRateLimit(first, second)).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: NOW + 1_000,
      retryAfterMs: null,
      tokensLimit: 40_000,
      tokensRemaining: 900,
    })
  })

  it('prefers an explicit zero over a null', () => {
    expect(mergeRateLimit(info({ remaining: 0 }), info({ remaining: 9 })).remaining).toBe(0)
  })

  it('returns EMPTY_RATE_LIMIT when both sides are empty', () => {
    expect(mergeRateLimit(EMPTY_RATE_LIMIT, emptyRateLimit())).toEqual(EMPTY_RATE_LIMIT)
  })
})

describe('emptyRateLimit', () => {
  it('returns a fresh copy so callers can mutate their own instance', () => {
    const a = emptyRateLimit()
    a.remaining = 5
    expect(emptyRateLimit()).toEqual(EMPTY_RATE_LIMIT)
    expect(EMPTY_RATE_LIMIT.remaining).toBeNull()
  })
})
