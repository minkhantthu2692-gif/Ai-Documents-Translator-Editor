/**
 * Dexie (IndexedDB) schema.
 *
 * Version 1 — initial tables.
 * Version 2 — adds `projects.archivedAt` and `blocks.kind` indexes and backfills
 *             the sync metadata (deviceId / version / updatedAt) on legacy rows.
 *
 * Dexie runs upgrade hooks only when an existing database is older than the
 * version being installed, so a fresh install applies both schemas in order and
 * skips the backfill.
 */

import Dexie, { type Table } from 'dexie'
import { getDeviceId } from '@/core/id'
import type {
  ApiKeyRecord,
  BlockRecord,
  CacheRecord,
  EventRecord,
  GlossaryRecord,
  JobRecord,
  OutboxRecord,
  PageRecord,
  ProjectRecord,
  SettingRecord,
  TranslationMemoryRecord,
  TranslationRecord,
  UsageStatsRecord,
} from './types'

export const DB_NAME = 'aidt'
export const DB_SCHEMA_VERSION = 2

export const TABLE_NAMES = [
  'projects',
  'pages',
  'blocks',
  'translations',
  'glossary',
  'translationMemory',
  'cache',
  'jobs',
  'events',
  'outbox',
  'settings',
  'apiKeys',
  'usageStats',
] as const

export type TableName = (typeof TABLE_NAMES)[number]

export class AppDatabase extends Dexie {
  projects!: Table<ProjectRecord, string>
  pages!: Table<PageRecord, string>
  blocks!: Table<BlockRecord, string>
  translations!: Table<TranslationRecord, string>
  glossary!: Table<GlossaryRecord, string>
  translationMemory!: Table<TranslationMemoryRecord, string>
  cache!: Table<CacheRecord, string>
  jobs!: Table<JobRecord, string>
  events!: Table<EventRecord, string>
  outbox!: Table<OutboxRecord, string>
  settings!: Table<SettingRecord, string>
  apiKeys!: Table<ApiKeyRecord, string>
  usageStats!: Table<UsageStatsRecord, string>

  constructor(name = DB_NAME) {
    super(name)

    this.version(1).stores({
      projects: 'id, name, status, lastOpenedAt, createdAt, updatedAt',
      pages: 'id, [projectId+index], projectId, ocrStatus, updatedAt',
      blocks: 'id, [projectId+pageId+order], projectId, pageId, status, updatedAt',
      translations:
        'id, sourceHash, [projectId+blockId], projectId, blockId, provider, status, updatedAt',
      glossary: 'id, sourceTerm, targetTerm, projectId, updatedAt',
      translationMemory: 'id, sourceHash, [sourceLang+targetLang+sourceHash], hits, updatedAt',
      cache: 'id, [kind+key], kind, expiresAt, lastAccessAt, updatedAt',
      jobs: 'id, state, type, projectId, startedAt, updatedAt',
      events: 'id, timestamp, severity, reasonCode, state, updatedAt',
      outbox: 'id, [entity+entityId], nextAttemptAt, updatedAt',
      settings: 'id, group, updatedAt',
      apiKeys: 'id, provider, status, updatedAt',
      usageStats: 'id, [provider+model+day], day, provider, updatedAt',
    })

    this.version(2)
      .stores({
        projects: 'id, name, status, lastOpenedAt, archivedAt, createdAt, updatedAt',
        pages: 'id, [projectId+index], projectId, ocrStatus, updatedAt',
        blocks: 'id, [projectId+pageId+order], projectId, pageId, kind, status, updatedAt',
        translations:
          'id, sourceHash, [projectId+blockId], projectId, blockId, provider, status, updatedAt',
        glossary: 'id, sourceTerm, targetTerm, projectId, updatedAt',
        translationMemory: 'id, sourceHash, [sourceLang+targetLang+sourceHash], hits, updatedAt',
        cache: 'id, [kind+key], kind, expiresAt, lastAccessAt, updatedAt',
        jobs: 'id, state, type, projectId, startedAt, updatedAt',
        events: 'id, timestamp, severity, reasonCode, state, updatedAt',
        outbox: 'id, [entity+entityId], nextAttemptAt, updatedAt',
        settings: 'id, group, updatedAt',
        apiKeys: 'id, provider, status, updatedAt',
        usageStats: 'id, [provider+model+day], day, provider, updatedAt',
      })
      .upgrade(async (tx) => {
        const deviceId = getDeviceId()
        const now = Date.now()
        const tables: TableName[] = [...TABLE_NAMES]
        for (const tableName of tables) {
          const table = tx.table(tableName)
          await table.toCollection().modify((record: Record<string, unknown>) => {
            if (!record.updatedAt) record.updatedAt = now
            if (!record.createdAt) record.createdAt = record.updatedAt
            if (!record.deviceId) record.deviceId = deviceId
            if (typeof record.version !== 'number') record.version = 1
          })
        }
        await tx
          .table('projects')
          .toCollection()
          .modify((project: Record<string, unknown>) => {
            if (typeof project.archived === 'boolean') {
              project.archivedAt = project.archived ? (project.updatedAt as number) : null
            } else {
              project.archived = false
              project.archivedAt = null
            }
          })
      })
  }
}

let database: AppDatabase | null = null

export function getDb(): AppDatabase {
  if (!database) database = new AppDatabase()
  return database
}

/** Test seam: inject a pre-built instance (fake-indexeddb in unit tests). */
export function setDb(instance: AppDatabase | null): void {
  database = instance
}

export async function closeDb(): Promise<void> {
  if (database) {
    database.close()
    database = null
  }
}

/** Deletes the whole database (Settings → Delete all local data). */
export async function deleteDatabase(): Promise<void> {
  await closeDb()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => resolve()
  })
  database = null
}
