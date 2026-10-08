/** Settings repository — typed key/value store persisted in IndexedDB. */

import { getDb } from './db'
import { stampNew } from './repo-common'
import { enqueueDelete } from '@/sync/hooks'
import type { SettingRecord } from './types'

export class SettingsRepository {
  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await getDb().settings.get(key)
    if (!row) return fallback
    return row.value as T
  }

  async set<T>(key: string, value: T, group = 'general'): Promise<SettingRecord> {
    const db = getDb()
    const existing = await db.settings.get(key)
    const timestamp = Date.now()
    if (existing) {
      const next: SettingRecord = {
        ...existing,
        value,
        group,
        updatedAt: timestamp,
        version: existing.version + 1,
      }
      await db.settings.put(next)
      return next
    }
    const record = stampNew<SettingRecord>({ id: key, group, value }, 'set')
    // Settings use the key itself as the primary key.
    const finalRecord: SettingRecord = {
      ...record,
      id: key,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await db.settings.put(finalRecord)
    return finalRecord
  }

  async getAll(): Promise<SettingRecord[]> {
    return getDb().settings.toArray()
  }

  async getByGroup(group: string): Promise<SettingRecord[]> {
    return getDb().settings.where('group').equals(group).toArray()
  }

  async remove(key: string): Promise<void> {
    const db = getDb()
    const existing = await db.settings.get(key)
    await db.settings.delete(key)
    if (existing) {
      await enqueueDelete('settings', existing as unknown as Record<string, unknown>)
    }
  }

  async clear(): Promise<void> {
    await getDb().settings.clear()
  }
}

export const settingsRepo = new SettingsRepository()

/** Setting keys used across the app (typed to avoid typos). */
export const SETTING_KEYS = {
  language: 'ui.language',
  theme: 'ui.theme',
  cacheEnabled: 'cache.enabled',
  cacheTtl: 'cache.ttl',
  cacheMaxBytes: 'cache.maxBytes',
  appsScriptUrl: 'sync.appsScriptUrl',
  appsScriptToken: 'sync.appsScriptToken',
  syncEnabled: 'sync.enabled',
  autoSync: 'sync.autoSync',
  autoSyncInterval: 'sync.intervalMinutes',
  conflictPolicy: 'sync.conflictPolicy',
  syncEntities: 'sync.entities',
  assistantEnabled: 'assistant.enabled',
  provider: 'ai.provider',
  model: 'ai.model',
  batchMaxLines: 'translate.batchMaxLines',
} as const
