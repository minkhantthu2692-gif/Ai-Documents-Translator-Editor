/**
 * Cache repository with TTL, per-kind budgets and LRU eviction.
 * Kinds: translation | pageRender | ocr | font.
 */

import { getDb } from './db'
import { estimateSize, stampNew } from './repo-common'
import type { CacheKind, CacheRecord } from './types'

export interface CacheSizes {
  translation: number
  pageRender: number
  ocr: number
  font: number
  total: number
  entries: Record<CacheKind, number>
}

export const DEFAULT_TTL_MS: Record<CacheKind, number> = {
  translation: 30 * 24 * 60 * 60 * 1000,
  pageRender: 7 * 24 * 60 * 60 * 1000,
  ocr: 30 * 24 * 60 * 60 * 1000,
  font: 365 * 24 * 60 * 60 * 1000,
}

export const DEFAULT_MAX_BYTES: Record<CacheKind, number> = {
  translation: 64 * 1024 * 1024,
  pageRender: 128 * 1024 * 1024,
  ocr: 64 * 1024 * 1024,
  font: 32 * 1024 * 1024,
}

export class CacheRepository {
  async get<T>(kind: CacheKind, key: string): Promise<T | null> {
    const db = getDb()
    const match = await db.cache
      .where('[kind+key]')
      .equals([kind, key] as never)
      .first()
    if (!match) return null
    if (match.expiresAt !== 0 && match.expiresAt < Date.now()) {
      await db.cache.delete(match.id)
      return null
    }
    await db.cache.update(match.id, {
      lastAccessAt: Date.now(),
      hits: match.hits + 1,
      updatedAt: Date.now(),
    })
    return match.value as T
  }

  async put(
    kind: CacheKind,
    key: string,
    value: unknown,
    options: { ttlMs?: number; maxBytes?: number } = {},
  ): Promise<CacheRecord> {
    const db = getDb()
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS[kind]
    const size = estimateSize(value)
    const existing = await db.cache
      .where('[kind+key]')
      .equals([kind, key] as never)
      .first()
    const timestamp = Date.now()

    if (existing) {
      const next: CacheRecord = {
        ...existing,
        value,
        size,
        expiresAt: ttlMs === 0 ? 0 : timestamp + ttlMs,
        lastAccessAt: timestamp,
        updatedAt: timestamp,
        version: existing.version + 1,
      }
      await db.cache.put(next)
      await this.evict(kind, options.maxBytes ?? DEFAULT_MAX_BYTES[kind])
      return next
    }

    const record = stampNew<CacheRecord>(
      {
        kind,
        key,
        value,
        size,
        expiresAt: ttlMs === 0 ? 0 : timestamp + ttlMs,
        lastAccessAt: timestamp,
        hits: 0,
      },
      'cch',
    )
    await db.cache.add(record)
    await this.evict(kind, options.maxBytes ?? DEFAULT_MAX_BYTES[kind])
    return record
  }

  /** Removes expired rows across all kinds. Returns number deleted. */
  async purgeExpired(): Promise<number> {
    const db = getDb()
    const now = Date.now()
    return db.cache
      .where('expiresAt')
      .below(now)
      .and((row) => row.expiresAt !== 0)
      .delete()
  }

  /** LRU eviction: deletes least-recently-used rows until the kind fits its budget. */
  async evict(kind: CacheKind, maxBytes: number): Promise<number> {
    const db = getDb()
    const rows = await db.cache.where('kind').equals(kind).toArray()
    let total = rows.reduce((sum, row) => sum + row.size, 0)
    if (total <= maxBytes) return 0

    rows.sort((a, b) => a.lastAccessAt - b.lastAccessAt)
    const doomed: string[] = []
    for (const row of rows) {
      if (total <= maxBytes) break
      doomed.push(row.id)
      total -= row.size
    }
    if (doomed.length) await db.cache.bulkDelete(doomed)
    return doomed.length
  }

  async sizes(): Promise<CacheSizes> {
    const rows = await getDb().cache.toArray()
    const sizes: CacheSizes = {
      translation: 0,
      pageRender: 0,
      ocr: 0,
      font: 0,
      total: 0,
      entries: { translation: 0, pageRender: 0, ocr: 0, font: 0 },
    }
    for (const row of rows) {
      sizes[row.kind] += row.size
      sizes.entries[row.kind] += 1
      sizes.total += row.size
    }
    return sizes
  }

  async clearKind(kind: CacheKind): Promise<number> {
    return getDb().cache.where('kind').equals(kind).delete()
  }

  async clearAll(): Promise<void> {
    await getDb().cache.clear()
  }
}

export const cacheRepo = new CacheRepository()
