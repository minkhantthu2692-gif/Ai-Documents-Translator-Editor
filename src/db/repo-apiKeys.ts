/**
 * API key repository.
 *
 * Keys are sealed with WebCrypto AES-GCM before they touch IndexedDB; the
 * plaintext never leaves this module except through `reveal()` for editing —
 * and the run path opens them inside the translation worker instead, so the
 * main thread never holds a secret.
 *
 * Phase 3 added the key-pool bookkeeping (per-key enable switch, cooldown,
 * lifetime usage counters and the RPM/TPM/RPD bucket position) so a refresh
 * mid-run resumes with the same cooldowns instead of stampeding the provider.
 */

import { decodeSealed, encodeSealed, openText, sealText } from '@/core/crypto'
import { vaultPassphrase } from '@/core/vault'
import { getDb } from './db'
import { stampNew, stampUpdate } from './repo-common'
import type { ApiKeyRecord, ApiKeyStatus, CooldownReason, KeyBuckets } from './types'

export interface ApiKeySummary {
  id: string
  provider: string
  label: string
  lastFour: string
  status: ApiKeyStatus
  statusDetail: string
  lastCheckedAt: number | null
  models: string[]
  updatedAt: number
  enabled: boolean
  cooldownUntil: number
  cooldownReason: CooldownReason | null
  requests: number
  tokensIn: number
  tokensOut: number
  lastUsedAt: number | null
}

export class ApiKeyRepository {
  async create(input: {
    provider: string
    label: string
    secret: string
    models?: string[]
    enabled?: boolean
    /** Session passphrase; omitted = device-bound key. */
    passphrase?: string | null
  }): Promise<ApiKeySummary> {
    const trimmed = input.secret.trim()
    if (trimmed.length < 8) throw new Error('API key looks too short')
    const sealed = await sealText(trimmed, input.passphrase ?? undefined)
    const db = getDb()
    const record = stampNew<ApiKeyRecord>(
      {
        provider: input.provider,
        label: input.label.trim() || `${input.provider} key`,
        cipher: encodeSealed(sealed),
        lastFour: trimmed.slice(-4),
        status: 'unknown',
        statusDetail: '',
        lastCheckedAt: null,
        models: input.models ?? [],
        enabled: input.enabled ?? true,
        cooldownUntil: 0,
        cooldownReason: null,
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastUsedAt: null,
        buckets: null,
      },
      'key',
    )
    await db.apiKeys.add(record)
    return this.summarise(record)
  }

  async list(): Promise<ApiKeySummary[]> {
    const rows = await getDb().apiKeys.toArray()
    return rows
      .map((row) => this.summarise(row))
      .sort((a, b) => a.provider.localeCompare(b.provider) || b.updatedAt - a.updatedAt)
  }

  async listByProvider(provider: string): Promise<ApiKeySummary[]> {
    const rows = await getDb().apiKeys.where('provider').equals(provider).toArray()
    return rows.map((row) => this.summarise(row))
  }

  /** Full rows (sealed) for a run — the worker opens them, never this module. */
  async listRowsByProvider(provider: string): Promise<ApiKeyRecord[]> {
    return getDb().apiKeys.where('provider').equals(provider).toArray()
  }

  async get(id: string): Promise<ApiKeyRecord | undefined> {
    return getDb().apiKeys.get(id)
  }

  /** Decrypts the secret (only for the edit/verify flows). */
  async reveal(id: string): Promise<string> {
    const row = await getDb().apiKeys.get(id)
    if (!row) throw new Error(`API key not found: ${id}`)
    return openText(decodeSealed(row.cipher), vaultPassphrase() ?? undefined)
  }

  async replaceSecret(
    id: string,
    secret: string,
    passphrase?: string | null,
  ): Promise<ApiKeySummary> {
    const db = getDb()
    const row = await db.apiKeys.get(id)
    if (!row) throw new Error(`API key not found: ${id}`)
    const sealed = await sealText(secret.trim(), passphrase ?? undefined)
    const next = stampUpdate(row, {
      cipher: encodeSealed(sealed),
      lastFour: secret.trim().slice(-4),
      status: 'unknown' as ApiKeyStatus,
      statusDetail: '',
      lastCheckedAt: null,
      cooldownUntil: 0,
      cooldownReason: null,
      buckets: null,
    })
    await db.apiKeys.put(next)
    return this.summarise(next)
  }

  /** Per-key nickname shown everywhere (settings card, progress read-out). */
  async setLabel(id: string, label: string): Promise<void> {
    const db = getDb()
    const row = await db.apiKeys.get(id)
    if (!row) return
    const trimmed = label.trim()
    if (!trimmed || trimmed === row.label) return
    await db.apiKeys.put(stampUpdate(row, { label: trimmed }))
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const db = getDb()
    const row = await db.apiKeys.get(id)
    if (!row || row.enabled === enabled) return
    await db.apiKeys.put(
      stampUpdate(row, enabled ? { enabled } : { enabled, cooldownUntil: 0, cooldownReason: null }),
    )
  }

  async setStatus(id: string, status: ApiKeyStatus, statusDetail = ''): Promise<void> {
    const db = getDb()
    const row = await db.apiKeys.get(id)
    if (!row) return
    await db.apiKeys.put(stampUpdate(row, { status, statusDetail, lastCheckedAt: Date.now() }))
  }

  async setModelHints(id: string, models: string[]): Promise<void> {
    const db = getDb()
    const row = await db.apiKeys.get(id)
    if (!row) return
    await db.apiKeys.put(stampUpdate(row, { models }))
  }

  /**
   * Writes the pool's view of a key back to IndexedDB: status, cooldown and
   * the bucket/usage counters. Called after every batch so a refresh resumes
   * exactly where the run left off.
   */
  async applyPoolState(state: {
    id: string
    enabled: boolean
    status: ApiKeyStatus
    statusDetail: string
    cooldownUntil: number
    cooldownReason: CooldownReason | null
    lastCheckedAt: number | null
    requests: number
    tokensIn: number
    tokensOut: number
    lastUsedAt: number
    buckets: KeyBuckets
  }): Promise<void> {
    const db = getDb()
    const row = await db.apiKeys.get(state.id)
    if (!row) return
    await db.apiKeys.put(
      stampUpdate(row, {
        enabled: state.enabled,
        status: state.status,
        statusDetail: state.statusDetail,
        cooldownUntil: state.cooldownUntil,
        cooldownReason: state.cooldownReason,
        lastCheckedAt: state.lastCheckedAt,
        requests: state.requests,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        lastUsedAt: state.lastUsedAt,
        buckets: state.buckets,
      }),
    )
  }

  remove(id: string): Promise<void> {
    return getDb().apiKeys.delete(id)
  }

  clearAll(): Promise<void> {
    return getDb().apiKeys.clear()
  }

  async healthByProvider(): Promise<
    Record<string, { total: number; usable: number; status: ApiKeyStatus }>
  > {
    const rows = await getDb().apiKeys.toArray()
    const health: Record<string, { total: number; usable: number; status: ApiKeyStatus }> = {}
    for (const row of rows) {
      const entry = (health[row.provider] ??= { total: 0, usable: 0, status: 'unknown' })
      if (row.enabled === false) continue
      entry.total += 1
      if (row.status === 'valid' || row.status === 'unknown') entry.usable += 1
      if (row.status === 'quota' || row.status === 'cooling') entry.status = row.status
      else if (row.status === 'invalid' && entry.status !== 'quota' && entry.status !== 'cooling')
        entry.status = 'invalid'
      else if (row.status === 'valid' && entry.status === 'unknown') entry.status = 'valid'
    }
    return health
  }

  private summarise(row: ApiKeyRecord): ApiKeySummary {
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      lastFour: row.lastFour,
      status: row.status,
      statusDetail: row.statusDetail,
      lastCheckedAt: row.lastCheckedAt,
      models: row.models,
      updatedAt: row.updatedAt,
      enabled: row.enabled !== false,
      cooldownUntil: row.cooldownUntil ?? 0,
      cooldownReason: row.cooldownReason ?? null,
      requests: row.requests ?? 0,
      tokensIn: row.tokensIn ?? 0,
      tokensOut: row.tokensOut ?? 0,
      lastUsedAt: row.lastUsedAt ?? null,
    }
  }
}

export const apiKeyRepo = new ApiKeyRepository()
