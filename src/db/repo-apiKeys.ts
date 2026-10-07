/**
 * API key repository.
 *
 * Keys are sealed with WebCrypto AES-GCM before they touch IndexedDB; the
 * plaintext never leaves this module except through `reveal()` for editing.
 */

import { decodeSealed, encodeSealed, openText, sealText } from '@/core/crypto'
import { getDb } from './db'
import { stampNew, stampUpdate } from './repo-common'
import type { ApiKeyRecord, ApiKeyStatus } from './types'

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
}

export class ApiKeyRepository {
  async create(input: {
    provider: string
    label: string
    secret: string
    models?: string[]
  }): Promise<ApiKeySummary> {
    const trimmed = input.secret.trim()
    if (trimmed.length < 8) throw new Error('API key looks too short')
    const sealed = await sealText(trimmed)
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

  async get(id: string): Promise<ApiKeyRecord | undefined> {
    return getDb().apiKeys.get(id)
  }

  /** Decrypts the secret (only for the edit/verify flows). */
  async reveal(id: string): Promise<string> {
    const row = await getDb().apiKeys.get(id)
    if (!row) throw new Error(`API key not found: ${id}`)
    return openText(decodeSealed(row.cipher))
  }

  async replaceSecret(id: string, secret: string): Promise<ApiKeySummary> {
    const db = getDb()
    const row = await db.apiKeys.get(id)
    if (!row) throw new Error(`API key not found: ${id}`)
    const sealed = await sealText(secret.trim())
    const next = stampUpdate(row, {
      cipher: encodeSealed(sealed),
      lastFour: secret.trim().slice(-4),
      status: 'unknown' as ApiKeyStatus,
      statusDetail: '',
      lastCheckedAt: null,
    })
    await db.apiKeys.put(next)
    return this.summarise(next)
  }

  async setStatus(id: string, status: ApiKeyStatus, statusDetail = ''): Promise<void> {
    const db = getDb()
    const row = await db.apiKeys.get(id)
    if (!row) return
    await db.apiKeys.put(stampUpdate(row, { status, statusDetail, lastCheckedAt: Date.now() }))
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
    }
  }
}

export const apiKeyRepo = new ApiKeyRepository()
