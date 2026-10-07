/**
 * Dexie (IndexedDB) schema.
 *
 * Version 1 — initial tables.
 * Version 2 — adds `projects.archivedAt` and `blocks.kind` indexes and backfills
 *             the sync metadata (deviceId / version / updatedAt) on legacy rows.
 * Version 3 — adds `sourceFiles` (the original PDF bytes) and backfills the
 *             Phase 2 analysis fields on existing pages/blocks.
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
  SourceFileRecord,
  TranslationMemoryRecord,
  TranslationRecord,
  UsageStatsRecord,
} from './types'

export const DB_NAME = 'aidt'
export const DB_SCHEMA_VERSION = 3

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
  'sourceFiles',
] as const

/** Tables that existed at schema v2 — the v2 backfill must only touch these. */
const V2_TABLE_NAMES: TableName[] = [
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
]

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
  sourceFiles!: Table<SourceFileRecord, string>

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
        // Only tables that existed at v2 — `sourceFiles` arrives with v3.
        const tables: TableName[] = [...V2_TABLE_NAMES]
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

    this.version(3)
      .stores({
        projects: 'id, name, status, lastOpenedAt, archivedAt, createdAt, updatedAt',
        pages: 'id, [projectId+index], projectId, ocrStatus, contentClass, updatedAt',
        blocks: 'id, [projectId+pageId+order], projectId, pageId, kind, status, region, updatedAt',
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
        sourceFiles: 'id, projectId, updatedAt',
      })
      .upgrade(async (tx) => {
        // Backfill the Phase 2 analysis fields on rows written before v3.
        const now = Date.now()
        await tx
          .table('pages')
          .toCollection()
          .modify((page: Record<string, unknown>) => {
            if (page.contentClass === undefined) {
              page.contentClass = page.hasTextLayer === false ? 'scanned' : 'text'
            }
            if (typeof page.textCoverage !== 'number') {
              page.textCoverage = page.hasTextLayer === false ? 0 : 1
            }
            if (page.detectedLanguage === undefined) page.detectedLanguage = null
            if (typeof page.lineCount !== 'number') page.lineCount = 0
            if (page.analysisState === undefined) page.analysisState = 'idle'
            if (page.ocrConfidence === undefined) page.ocrConfidence = null
            if (typeof page.updatedAt !== 'number') page.updatedAt = now
          })
        await tx
          .table('blocks')
          .toCollection()
          .modify((block: Record<string, unknown>) => {
            if (block.region === undefined) block.region = 'body'
            if (block.alignment === undefined) block.alignment = 'left'
            if (!Array.isArray(block.lines)) block.lines = []
            if (block.skipRule === undefined) block.skipRule = null
            if (!Array.isArray(block.placeholders)) block.placeholders = []
            if (block.listMarker === undefined) block.listMarker = null
            if (typeof block.updatedAt !== 'number') block.updatedAt = now
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
