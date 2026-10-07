/**
 * Key-pool acceptance tests.
 *
 * Everything runs on an injected clock and an injected jitter source, so the
 * cooldown/backoff arithmetic is asserted exactly — no timers, no `Date.now()`.
 */
import { describe, expect, it } from 'vitest'
import type { ApiKeyRepository } from '@/db/repo-apiKeys'
import { estimateTokens, KeyPool, type KeyPoolOptions, type KeySeed } from './keyPool'

/** The exact argument `apiKeyRepo.applyPoolState` persists (type-level proof). */
type ApplyPoolStateArg = Parameters<ApiKeyRepository['applyPoolState']>[0]

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function seed(id: string, overrides: Partial<KeySeed> = {}): KeySeed {
  return {
    id,
    provider: 'openrouter',
    nickname: id,
    lastFour: '1234',
    enabled: true,
    secret: `sk-${id}`,
    ...overrides,
  }
}

interface Harness {
  pool: KeyPool
  clock: { now: number }
}

function harness(options: KeyPoolOptions = {}): Harness {
  const clock = { now: T0 }
  const pool = new KeyPool({
    now: () => clock.now,
    random: () => 0.5,
    backoffBaseMs: 1_000,
    backoffMaxMs: 8_000,
    ...options,
  })
  return { pool, clock }
}

describe('key selection', () => {
  it('rotates keys round-robin in id order', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-c'), seed('key-a'), seed('key-b')])

    const order = Array.from({ length: 6 }, () => pool.pick(0, T0)?.keyId)
    expect(order).toEqual(['key-a', 'key-b', 'key-c', 'key-a', 'key-b', 'key-c'])
  })

  it('least-used strategy always offers the key with the fewest requests first', () => {
    const { pool } = harness({ strategy: 'least-used' })
    pool.setKeys([seed('key-a'), seed('key-b'), seed('key-c')])
    pool.reportSuccess('key-a', { now: T0 })
    pool.reportSuccess('key-a', { now: T0 + 1 })
    pool.reportSuccess('key-c', { now: T0 + 2 })

    expect(pool.pick(0, T0 + 3)?.keyId).toBe('key-b')

    for (let i = 0; i < 3; i += 1) pool.reportSuccess('key-b', { now: T0 + 4 + i })
    expect(pool.pick(0, T0 + 10)?.keyId).toBe('key-c')

    // Once c has been used twice the tie with a breaks on the older lastUsedAt.
    pool.reportSuccess('key-c', { now: T0 + 10 })
    expect(pool.pick(0, T0 + 11)?.keyId).toBe('key-a')
  })

  it('a disabled key never enters rotation', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a'), seed('key-b')])
    pool.markEnabled('key-a', false)

    const picks = Array.from({ length: 4 }, () => pool.pick(0, T0)?.keyId)
    expect(picks).toEqual(['key-b', 'key-b', 'key-b', 'key-b'])
    expect(pool.hasUsableKey()).toBe(true)
  })
})

describe('token buckets', () => {
  it('the rpm bucket blocks a key until the window resets', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a')])
    pool.configureLimits({ rpm: 2 })
    pool.reportSuccess('key-a', { now: T0 })
    pool.reportSuccess('key-a', { now: T0 })

    expect(pool.pick(0, T0)).toBeNull()
    expect(pool.availableAt(0, T0)).toBe(T0 + MINUTE)
    expect(pool.pick(0, T0 + MINUTE - 1)).toBeNull()
    expect(pool.pick(0, T0 + MINUTE)).not.toBeNull()
  })

  it('the tpm bucket blocks only token-heavy requests until the window resets', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a')])
    pool.configureLimits({ tpm: 100 })
    pool.reportSuccess('key-a', { tokensIn: 90, now: T0 })

    expect(pool.pick(50, T0)).toBeNull()
    expect(pool.availableAt(50, T0)).toBe(T0 + MINUTE)
    expect(pool.pick(10, T0)).not.toBeNull()
    // A light request (and the waiting countdown) is not held back by TPM.
    expect(pool.waitingUntil(T0)).toBeNull()
  })

  it('the rpd bucket blocks a key for the rest of the day', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a')])
    pool.configureLimits({ rpd: 1 })
    pool.reportSuccess('key-a', { now: T0 })

    expect(pool.pick(0, T0)).toBeNull()
    expect(pool.availableAt(0, T0)).toBe(T0 + DAY)
    expect(pool.pick(0, T0 + DAY - 1)).toBeNull()
    expect(pool.pick(0, T0 + DAY)).not.toBeNull()
    expect(pool.isExhausted(T0)).toBe(true)
    expect(pool.exhaustionReason(T0)).toBe('ALL_KEYS_COOLING_DOWN')
  })
})

describe('reportRateLimit', () => {
  it('a Retry-After cooldown holds the key until now + retryAfter', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a')])

    const deadline = pool.reportRateLimit('key-a', { retryAfterMs: 45_000, now: T0 })

    expect(deadline).toBe(T0 + 45_000)
    expect(pool.pick(0, T0)).toBeNull()
    expect(pool.pick(0, T0 + 44_999)).toBeNull()
    expect(pool.pick(0, T0 + 45_000)).not.toBeNull()
    expect(pool.waitingUntil(T0)).toBe(T0 + 45_000)
    expect(pool.health('key-a', T0)).toBe('cooling-down')
  })

  it('exponential backoff with jitter stays within base * 2^(n-1) * [0.75, 1.25]', () => {
    for (const random of [0, 1]) {
      const { pool, clock } = harness({ random: () => random })
      pool.setKeys([seed('key-a')])

      for (let failure = 1; failure <= 6; failure += 1) {
        const expected = Math.min(8_000, 1_000 * 2 ** Math.min(8, failure - 1))
        const cooldown = pool.reportRateLimit('key-a', { now: clock.now }) - clock.now
        expect(cooldown).toBeGreaterThanOrEqual(Math.floor(expected * 0.75) - 1)
        expect(cooldown).toBeLessThanOrEqual(Math.ceil(expected * 1.25) + 1)
        clock.now += 10 * MINUTE
      }
    }
  })

  it('exponential backoff is capped at backoffMaxMs', () => {
    const { pool, clock } = harness({ random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    const cooldowns: number[] = []
    for (let failure = 1; failure <= 8; failure += 1) {
      cooldowns.push(pool.reportRateLimit('key-a', { now: clock.now }) - clock.now)
      clock.now += 10 * MINUTE
    }

    expect(cooldowns.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(cooldowns.slice(4)).toEqual([8_000, 8_000, 8_000, 8_000])
    expect(Math.max(...cooldowns)).toBeLessThanOrEqual(8_000)
  })

  it('a quota error cools the key for a much longer window than a rate limit', () => {
    const { pool } = harness({ quotaFallbackMs: 30 * MINUTE })
    pool.setKeys([seed('key-a')])

    const rateLimited = pool.reportRateLimit('key-a', { retryAfterMs: 30_000, now: T0 })
    const quota = pool.reportRateLimit('key-a', { quota: true, now: T0 })

    expect(quota - T0).toBeGreaterThan((rateLimited - T0) * 10)
    expect(quota - T0).toBe(30 * MINUTE)
    expect(pool.health('key-a', T0)).toBe('quota-exhausted')
    expect(pool.exhaustionReason(T0)).toBe('QUOTA_EXHAUSTED')
  })

  it('a quota error honours a later server reset hint', () => {
    const { pool } = harness({ quotaFallbackMs: 5 * MINUTE })
    pool.setKeys([seed('key-a')])

    const deadline = pool.reportRateLimit('key-a', {
      quota: true,
      rate: {
        limit: null,
        remaining: null,
        resetAt: T0 + 10 * MINUTE,
        retryAfterMs: null,
        tokensLimit: null,
        tokensRemaining: null,
      },
      now: T0,
    })

    expect(deadline).toBe(T0 + 10 * MINUTE)
  })
})

describe('invalid keys and exhaustion', () => {
  it('markInvalid removes a key from rotation for good', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a'), seed('key-b')])
    pool.markInvalid('key-a', '401 unauthorized', T0)

    const picks = Array.from({ length: 3 }, () => pool.pick(0, T0)?.keyId)
    expect(picks).toEqual(['key-b', 'key-b', 'key-b'])
    expect(pool.health('key-a', T0)).toBe('invalid')
    expect(pool.snapshot(T0).find((entry) => entry.id === 'key-a')?.health).toBe('invalid')

    pool.markInvalid('key-b', '', T0)
    expect(pool.hasUsableKey()).toBe(false)
  })

  it('exhaustionReason reports NO_API_KEY when no key is configured', () => {
    const { pool } = harness()
    expect(pool.exhaustionReason(T0)).toBe('NO_API_KEY')
    expect(pool.isExhausted(T0)).toBe(false)
  })

  it('exhaustionReason reports ALL_KEYS_COOLING_DOWN while every key cools', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a')])
    pool.reportRateLimit('key-a', { retryAfterMs: 30_000, now: T0 })

    expect(pool.isExhausted(T0)).toBe(true)
    expect(pool.exhaustionReason(T0)).toBe('ALL_KEYS_COOLING_DOWN')
    expect(pool.exhaustionReason(T0 + 30_000)).toBe('ALL_KEYS_COOLING_DOWN')
  })

  it('exhaustionReason reports QUOTA_EXHAUSTED for a quota cooldown', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a')])
    pool.reportRateLimit('key-a', { quota: true, now: T0 })

    expect(pool.exhaustionReason(T0)).toBe('QUOTA_EXHAUSTED')
  })

  it('exhaustionReason reports INVALID_KEY when every key was rejected', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a'), seed('key-b')])
    pool.markInvalid('key-a', '', T0)
    pool.markInvalid('key-b', '', T0)

    expect(pool.isExhausted(T0)).toBe(true)
    expect(pool.exhaustionReason(T0)).toBe('INVALID_KEY')
  })

  it('a usable key means the pool is not exhausted', () => {
    const { pool } = harness()
    pool.setKeys([seed('key-a')])
    expect(pool.isExhausted(T0)).toBe(false)
    expect(pool.hasUsableKey()).toBe(true)
  })
})

describe('persistence round-trip', () => {
  it('persistedAll() carries every field applyPoolState writes back', () => {
    const { pool, clock } = harness()
    pool.setKeys([seed('key-a'), seed('key-b')])
    pool.configureLimits({ rpm: 12 })
    pool.reportSuccess('key-a', { tokensIn: 40, tokensOut: 25, now: clock.now })
    pool.reportRateLimit('key-b', { retryAfterMs: 30_000, now: clock.now })

    const states = pool.persistedAll()
    // Type-level: assignable to the parameter of `apiKeyRepo.applyPoolState`.
    const written: ApplyPoolStateArg[] = states
    expect(written).toHaveLength(2)
    expect(Object.keys(written[0]).sort()).toEqual(
      [
        'buckets',
        'cooldownReason',
        'cooldownUntil',
        'enabled',
        'id',
        'lastCheckedAt',
        'lastUsedAt',
        'requests',
        'status',
        'statusDetail',
        'tokensIn',
        'tokensOut',
      ].sort(),
    )
    expect(written[0].status).toBe('valid')
    expect(written[1].status).toBe('cooling')
    expect(written[0].buckets.rpm.limit).toBe(12)

    // A refresh re-seeds the pool from those exact fields.
    const restored = harness({ random: () => 0.5 })
    restored.clock.now = clock.now
    restored.pool.setKeys([
      seed('key-a', { persisted: states[0] }),
      seed('key-b', { persisted: states[1] }),
    ])
    expect(restored.pool.persistedAll()).toEqual(states)
  })

  it('estimateTokens is a conservative characters/3 estimate', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('123456')).toBe(2)
    expect(estimateTokens('1234567')).toBe(3)
  })
})
