/**
 * Key pool — rotation, token buckets and cooldown bookkeeping for BYOK keys.
 *
 * One instance owns every key of the run. It answers three questions the rest
 * of the pipeline depends on:
 *
 *   1. `pick()`     — which key may send the next request *right now*?
 *   2. `availableAt()` — when will a key be available again (the WAITING_RATE_LIMIT
 *      countdown), or `null` when one is available now;
 *   3. `persisted()` — what must be written back to IndexedDB so a refresh keeps
 *      cooldowns, usage counters and bucket positions.
 *
 * Every function is pure w.r.t. its `now` argument, so the 429-storm tests run
 * on a virtual clock with no timers.
 */

import type { RateLimitInfo } from '@/providers/rateLimit'
import type { BucketState, CooldownReason, KeyBuckets } from '@/db/types'

export type { BucketState, CooldownReason, KeyBuckets }

export type KeyHealthState = 'healthy' | 'cooling-down' | 'invalid' | 'quota-exhausted' | 'disabled'

export interface PersistedKeyState {
  id: string
  enabled: boolean
  status: 'unknown' | 'valid' | 'invalid' | 'cooling' | 'quota'
  statusDetail: string
  cooldownUntil: number
  cooldownReason: CooldownReason | null
  lastCheckedAt: number | null
  requests: number
  tokensIn: number
  tokensOut: number
  lastUsedAt: number
  buckets: KeyBuckets
}

export interface KeySeed {
  id: string
  provider: string
  nickname: string
  lastFour: string
  enabled: boolean
  /** Plaintext secret; `null` until the run has opened the sealed record. */
  secret: string | null
  /** Health restored from IndexedDB (a refreshed page keeps its cooldowns). */
  persisted?: Partial<PersistedKeyState>
}

export interface KeyLease {
  keyId: string
  secret: string
  nickname: string
  /** Masked display form — the only thing ever logged or rendered. */
  masked: string
}

export interface KeyUsageSnapshot {
  id: string
  nickname: string
  lastFour: string
  masked: string
  enabled: boolean
  health: KeyHealthState
  cooldownUntil: number
  cooldownReason: CooldownReason | null
  requests: number
  tokensIn: number
  tokensOut: number
  lastUsedAt: number
  /** Requests left in the current minute/day (null = unknown). */
  rpmRemaining: number | null
  rpdRemaining: number | null
  /** The key has a usable secret in memory. */
  loaded: boolean
}

export interface KeyPoolOptions {
  strategy?: 'round-robin' | 'least-used'
  now?: () => number
  /** Deterministic jitter source for tests (0..1). */
  random?: () => number
  /** Exponential backoff base / cap for transient failures. */
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** Cooldown applied when a quota error carries no reset hint. */
  quotaFallbackMs?: number
}

export interface LimitConfig {
  rpm: number
  tpm: number
  rpd: number
}

interface KeyState {
  seed: KeySeed
  secret: string | null
  enabled: boolean
  nickname: string
  buckets: KeyBuckets
  cooldownUntil: number
  cooldownReason: CooldownReason | null
  invalid: boolean
  invalidDetail: string
  failures: number
  requests: number
  tokensIn: number
  tokensOut: number
  lastUsedAt: number
  lastCheckedAt: number | null
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

export const DEFAULT_LIMITS: LimitConfig = { rpm: 30, tpm: 100_000, rpd: 1_000 }

function emptyBucket(limit: number, now: number, windowMs: number): BucketState {
  return { limit, used: 0, resetAt: now + windowMs }
}

function maskOf(lastFour: string): string {
  return `••••${lastFour || '????'}`
}

/** Conservative estimate: 1 token ≈ 3 characters of source text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3))
}

export class KeyPool {
  private readonly keys = new Map<string, KeyState>()
  private readonly strategy: 'round-robin' | 'least-used'
  private readonly nowFn: () => number
  private readonly randomFn: () => number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly quotaFallbackMs: number
  private limits: LimitConfig = DEFAULT_LIMITS
  private cursor = 0

  constructor(options: KeyPoolOptions = {}) {
    this.strategy = options.strategy ?? 'round-robin'
    this.nowFn = options.now ?? (() => Date.now())
    this.randomFn = options.random ?? Math.random
    this.backoffBaseMs = options.backoffBaseMs ?? 2_000
    this.backoffMaxMs = options.backoffMaxMs ?? 5 * 60_000
    this.quotaFallbackMs = options.quotaFallbackMs ?? 60 * MINUTE_MS
  }

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */

  /** Replaces the key set (a run starts, or the settings tab edits a key). */
  setKeys(seeds: KeySeed[]): void {
    const seen = new Set<string>()
    for (const seed of seeds) {
      seen.add(seed.id)
      const existing = this.keys.get(seed.id)
      if (existing) {
        existing.seed = seed
        existing.enabled = seed.enabled
        existing.nickname = seed.nickname
        if (seed.secret) existing.secret = seed.secret
        continue
      }
      const persisted = seed.persisted
      const now = this.nowFn()
      this.keys.set(seed.id, {
        seed,
        secret: seed.secret,
        enabled: seed.enabled,
        nickname: seed.nickname,
        buckets: persisted?.buckets ?? {
          rpm: emptyBucket(this.limits.rpm, now, MINUTE_MS),
          tpm: emptyBucket(this.limits.tpm, now, MINUTE_MS),
          rpd: emptyBucket(this.limits.rpd, now, DAY_MS),
        },
        cooldownUntil: persisted?.cooldownUntil ?? 0,
        cooldownReason: persisted?.cooldownReason ?? null,
        invalid: persisted?.status === 'invalid',
        invalidDetail: persisted?.statusDetail ?? '',
        failures: 0,
        requests: persisted?.requests ?? 0,
        tokensIn: persisted?.tokensIn ?? 0,
        tokensOut: persisted?.tokensOut ?? 0,
        lastUsedAt: persisted?.lastUsedAt ?? 0,
        lastCheckedAt: persisted?.lastCheckedAt ?? null,
      })
    }
    for (const id of [...this.keys.keys()]) {
      if (!seen.has(id)) this.keys.delete(id)
    }
  }

  /** Applies model-configured limits (bucket ceilings follow the model). */
  configureLimits(limits: Partial<LimitConfig>): void {
    this.limits = { ...this.limits, ...limits }
    for (const key of this.keys.values()) {
      key.buckets.rpm.limit = this.limits.rpm
      key.buckets.tpm.limit = this.limits.tpm
      key.buckets.rpd.limit = this.limits.rpd
    }
  }

  get limitConfig(): LimitConfig {
    return this.limits
  }

  size(): number {
    return this.keys.size
  }

  /* ------------------------------------------------------------------ */
  /* Selection                                                           */
  /* ------------------------------------------------------------------ */

  health(keyId: string, now = this.nowFn()): KeyHealthState {
    const key = this.keys.get(keyId)
    if (!key) return 'disabled'
    if (!key.enabled) return 'disabled'
    if (key.invalid) return 'invalid'
    if (now < key.cooldownUntil) {
      return key.cooldownReason === 'quota' ? 'quota-exhausted' : 'cooling-down'
    }
    return 'healthy'
  }

  /** Eligible keys with at least one bucket slot left, in strategy order. */
  private hasCapacity(key: KeyState, requests: number, tokens: number, now: number): boolean {
    const { rpm, tpm, rpd } = key.buckets
    if (rpm.used + requests > rpm.limit && now < rpm.resetAt) return false
    if (rpd.used + requests > rpd.limit && now < rpd.resetAt) return false
    if (tokens > 0 && tpm.used + tokens > tpm.limit && now < tpm.resetAt) return false
    return true
  }

  /**
   * Next usable key, or `null` when every key is disabled, invalid, cooling or
   * out of quota capacity.
   */
  pick(tokenEstimate = 0, now = this.nowFn()): KeyLease | null {
    const ordered = [...this.keys.values()].sort((a, b) => a.seed.id.localeCompare(b.seed.id))
    if (ordered.length === 0) return null
    const offset = this.cursor % ordered.length
    const rotated = [...ordered.slice(offset), ...ordered.slice(0, offset)]

    let pool = rotated.filter((key) => {
      if (!key.enabled || key.invalid || !key.secret) return false
      if (now < key.cooldownUntil) return false
      return this.hasCapacity(key, 1, tokenEstimate, now)
    })
    if (this.strategy === 'least-used') {
      pool = pool.sort((a, b) => a.requests - b.requests || a.lastUsedAt - b.lastUsedAt)
    }
    const chosen = pool[0]
    if (!chosen) return null

    this.cursor = (this.cursor + 1) % Math.max(1, ordered.length)
    return {
      keyId: chosen.seed.id,
      secret: chosen.secret as string,
      nickname: chosen.nickname,
      masked: maskOf(chosen.seed.lastFour),
    }
  }

  /**
   * Epoch ms when a key may become available, or `null` when one is usable
   * right now. Used directly for the WAITING_RATE_LIMIT countdown.
   */
  availableAt(tokenEstimate = 0, now = this.nowFn()): number | null {
    if (this.pick(tokenEstimate, now)) return null
    let earliest: number | null = null
    for (const key of this.keys.values()) {
      if (!key.enabled || key.invalid || !key.secret) continue
      const candidates = [key.cooldownUntil]
      if (key.buckets.rpm.used + 1 > key.buckets.rpm.limit) candidates.push(key.buckets.rpm.resetAt)
      if (key.buckets.rpd.used + 1 > key.buckets.rpd.limit) candidates.push(key.buckets.rpd.resetAt)
      if (tokenEstimate > 0 && key.buckets.tpm.used + tokenEstimate > key.buckets.tpm.limit) {
        candidates.push(key.buckets.tpm.resetAt)
      }
      for (const candidate of candidates) {
        if (candidate <= now) continue
        if (earliest === null || candidate < earliest) earliest = candidate
      }
    }
    return earliest
  }

  /** Cooldown (epoch ms) when every key is cooling/quota-bound, else null. */
  waitingUntil(now = this.nowFn()): number | null {
    return this.availableAt(0, now)
  }

  /* ------------------------------------------------------------------ */
  /* Reporting                                                           */
  /* ------------------------------------------------------------------ */

  private consume(key: KeyState, tokens: number, now: number): void {
    const roll = (bucket: BucketState, windowMs: number, amount: number): void => {
      if (now >= bucket.resetAt) {
        bucket.used = 0
        bucket.resetAt = now + windowMs
      }
      bucket.used += amount
    }
    roll(key.buckets.rpm, MINUTE_MS, 1)
    roll(key.buckets.rpd, DAY_MS, 1)
    if (tokens > 0) roll(key.buckets.tpm, MINUTE_MS, tokens)
    key.requests += 1
    key.lastUsedAt = now
    key.lastCheckedAt = now
  }

  reportSuccess(
    keyId: string,
    input: {
      tokensIn?: number
      tokensOut?: number
      rate?: RateLimitInfo | null
      now?: number
    } = {},
  ): void {
    const key = this.keys.get(keyId)
    if (!key) return
    const now = input.now ?? this.nowFn()
    this.consume(key, input.tokensIn ?? 0, now)
    key.tokensIn += input.tokensIn ?? 0
    key.tokensOut += input.tokensOut ?? 0
    key.failures = 0
    key.cooldownUntil = 0
    key.cooldownReason = null
    this.applyRateInfo(key, input.rate ?? null, now)
  }

  /**
   * 429 / quota → cooldown with exponential backoff + jitter (and the server's
   * own `Retry-After` when it gave one). Returns the cooldown deadline.
   */
  reportRateLimit(
    keyId: string,
    input: {
      retryAfterMs?: number | null
      quota?: boolean
      rate?: RateLimitInfo | null
      now?: number
    } = {},
  ): number {
    const key = this.keys.get(keyId)
    const now = input.now ?? this.nowFn()
    if (!key) return now

    const rate = input.rate ?? null
    const retryAfter = input.retryAfterMs ?? rate?.retryAfterMs ?? null
    const quota = input.quota ?? false

    key.failures += 1
    let cooldown = quota
      ? this.quotaFallbackMs
      : Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(8, key.failures - 1))
    // ±25% jitter so parallel workers do not stampede back onto the key.
    const jitter = 0.75 + this.randomFn() * 0.5
    cooldown = Math.round(cooldown * jitter)
    if (retryAfter !== null && retryAfter > 0) cooldown = Math.max(cooldown, retryAfter)
    if (quota && rate?.resetAt) cooldown = Math.max(cooldown, rate.resetAt - now)

    key.cooldownUntil = now + cooldown
    key.cooldownReason = quota ? 'quota' : 'rate_limit'
    key.lastCheckedAt = now
    this.applyRateInfo(key, rate, now)
    return key.cooldownUntil
  }

  /** 5xx / timeout: short backoff, the key itself is still good. */
  reportTransient(keyId: string, now = this.nowFn()): number {
    const key = this.keys.get(keyId)
    if (!key) return now
    key.failures += 1
    const cooldown = Math.min(
      this.backoffMaxMs,
      Math.round(
        this.backoffBaseMs * 2 ** Math.min(6, key.failures - 1) * (0.75 + this.randomFn() * 0.5),
      ),
    )
    key.cooldownUntil = now + cooldown
    key.cooldownReason = 'server'
    key.lastCheckedAt = now
    return key.cooldownUntil
  }

  /** 401/403 — the key is dead until the user fixes it. */
  markInvalid(keyId: string, detail = '', now = this.nowFn()): void {
    const key = this.keys.get(keyId)
    if (!key) return
    key.invalid = true
    key.invalidDetail = detail
    key.lastCheckedAt = now
    key.cooldownUntil = 0
    key.cooldownReason = null
  }

  markValid(keyId: string, now = this.nowFn()): void {
    const key = this.keys.get(keyId)
    if (!key) return
    key.invalid = false
    key.invalidDetail = ''
    key.failures = 0
    key.cooldownUntil = 0
    key.cooldownReason = null
    key.lastCheckedAt = now
  }

  markEnabled(keyId: string, enabled: boolean): void {
    const key = this.keys.get(keyId)
    if (key) key.enabled = enabled
  }

  setSecret(keyId: string, secret: string | null): void {
    const key = this.keys.get(keyId)
    if (key) key.secret = secret
  }

  /** Live headers win over the bundled estimates. */
  private applyRateInfo(key: KeyState, rate: RateLimitInfo | null, now: number): void {
    if (!rate) return
    if (rate.limit !== null && rate.limit > 0) key.buckets.rpm.limit = rate.limit
    if (rate.tokensLimit !== null && rate.tokensLimit > 0) key.buckets.tpm.limit = rate.tokensLimit
    if (rate.remaining !== null && rate.limit !== null) {
      const window = Math.max(rate.resetAt ?? now + MINUTE_MS, now)
      key.buckets.rpm.used = Math.max(0, rate.limit - rate.remaining)
      key.buckets.rpm.resetAt = window
    }
    if (rate.tokensRemaining !== null && rate.tokensLimit !== null) {
      const window = Math.max(rate.resetAt ?? now + MINUTE_MS, now)
      key.buckets.tpm.used = Math.max(0, rate.tokensLimit - rate.tokensRemaining)
      key.buckets.tpm.resetAt = window
    }
  }

  /* ------------------------------------------------------------------ */
  /* Introspection / persistence                                         */
  /* ------------------------------------------------------------------ */

  usage(keyId: string): KeyUsageSnapshot | null {
    const key = this.keys.get(keyId)
    if (!key) return null
    return this.snapshotOf(key, this.nowFn())
  }

  snapshot(now = this.nowFn()): KeyUsageSnapshot[] {
    return [...this.keys.values()]
      .sort((a, b) => a.seed.id.localeCompare(b.seed.id))
      .map((key) => this.snapshotOf(key, now))
  }

  private snapshotOf(key: KeyState, now: number): KeyUsageSnapshot {
    const rpmWindow =
      key.buckets.rpm.resetAt > now
        ? key.buckets.rpm.limit - key.buckets.rpm.used
        : key.buckets.rpm.limit
    const rpdWindow =
      key.buckets.rpd.resetAt > now
        ? key.buckets.rpd.limit - key.buckets.rpd.used
        : key.buckets.rpd.limit
    return {
      id: key.seed.id,
      nickname: key.nickname,
      lastFour: key.seed.lastFour,
      masked: maskOf(key.seed.lastFour),
      enabled: key.enabled,
      health: this.health(key.seed.id, now),
      cooldownUntil: key.cooldownUntil,
      cooldownReason: key.cooldownReason,
      requests: key.requests,
      tokensIn: key.tokensIn,
      tokensOut: key.tokensOut,
      lastUsedAt: key.lastUsedAt,
      rpmRemaining: Math.max(0, rpmWindow),
      rpdRemaining: Math.max(0, rpdWindow),
      loaded: Boolean(key.secret),
    }
  }

  /** The slice of state that must survive a refresh. */
  persisted(keyId: string): PersistedKeyState | null {
    const key = this.keys.get(keyId)
    if (!key) return null
    const now = this.nowFn()
    const health = this.health(keyId, now)
    return {
      id: key.seed.id,
      enabled: key.enabled,
      status: key.invalid
        ? 'invalid'
        : health === 'quota-exhausted'
          ? 'quota'
          : health === 'cooling-down'
            ? 'cooling'
            : key.lastCheckedAt === null
              ? 'unknown'
              : 'valid',
      statusDetail: key.invalidDetail,
      cooldownUntil: key.cooldownUntil,
      cooldownReason: key.cooldownReason,
      lastCheckedAt: key.lastCheckedAt,
      requests: key.requests,
      tokensIn: key.tokensIn,
      tokensOut: key.tokensOut,
      lastUsedAt: key.lastUsedAt,
      buckets: {
        rpm: { ...key.buckets.rpm },
        tpm: { ...key.buckets.tpm },
        rpd: { ...key.buckets.rpd },
      },
    }
  }

  persistedAll(): PersistedKeyState[] {
    return [...this.keys.keys()]
      .map((id) => this.persisted(id))
      .filter((state): state is PersistedKeyState => state !== null)
  }

  /** True when no usable key exists at all (the run cannot make progress). */
  hasUsableKey(): boolean {
    for (const key of this.keys.values()) {
      if (key.enabled && key.secret && !key.invalid) return true
    }
    return false
  }

  /** True when at least one key exists but none is usable right now. */
  isExhausted(now = this.nowFn()): boolean {
    return this.keys.size > 0 && this.pick(0, now) === null
  }

  /** Reason code for a run that cannot proceed. */
  exhaustionReason(
    now = this.nowFn(),
  ): 'ALL_KEYS_COOLING_DOWN' | 'QUOTA_EXHAUSTED' | 'INVALID_KEY' | 'NO_API_KEY' {
    if (this.keys.size === 0) return 'NO_API_KEY'
    let anyQuota = false
    let anyCooldown = false
    let anyInvalid = false
    let anyBucketed = false
    for (const key of this.keys.values()) {
      if (!key.enabled) continue
      if (key.invalid) {
        anyInvalid = true
        continue
      }
      if (!key.secret) continue
      if (now < key.cooldownUntil) {
        if (key.cooldownReason === 'quota') anyQuota = true
        else anyCooldown = true
        continue
      }
      // Usable key, but every bucket may still be full (rpm/rpd exhausted).
      anyBucketed = true
    }
    if (anyQuota) return 'QUOTA_EXHAUSTED'
    if (anyCooldown || anyBucketed) return 'ALL_KEYS_COOLING_DOWN'
    return anyInvalid ? 'INVALID_KEY' : 'NO_API_KEY'
  }
}
