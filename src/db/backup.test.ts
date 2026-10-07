import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, TABLE_NAMES, setDb } from './db'
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  BackupError,
  createBackup,
  parseBackup,
  restoreBackup,
  serializeBackup,
} from './backup'
import type { ProjectRecord, SettingRecord } from './types'

function makeProject(id: string, name: string, updatedAt: number): ProjectRecord {
  return {
    id,
    name,
    sourceFileName: `${name}.pdf`,
    sourceFileSize: 1024,
    sourceLang: 'en',
    targetLang: 'my',
    status: 'draft',
    pageCount: 2,
    translatedPageCount: 1,
    blockCount: 12,
    characterCount: 3400,
    progress: 50,
    archived: false,
    archivedAt: null,
    lastOpenedAt: updatedAt,
    notes: '',
    createdAt: updatedAt,
    updatedAt,
    deviceId: 'dev_test',
    version: 1,
  }
}

function makeSetting(id: string, value: unknown, updatedAt: number): SettingRecord {
  return {
    id,
    group: 'ui',
    value,
    createdAt: updatedAt,
    updatedAt,
    deviceId: 'dev_test',
    version: 1,
  }
}

describe('backup export / import', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    await db.projects.bulkPut([
      makeProject('prj_1', 'Annual report', 1_700_000_000_000),
      makeProject('prj_2', 'User manual', 1_700_000_100_000),
    ])
    await db.settings.bulkPut([
      makeSetting('ui.language', 'my', 1_700_000_000_000),
      makeSetting('ui.theme', 'dark', 1_700_000_000_000),
    ])
    await db.cache.add({
      id: 'cch_1',
      kind: 'translation',
      key: 'hash-key',
      value: { text: 'hello' },
      size: 128,
      expiresAt: Date.now() + 60_000,
      lastAccessAt: Date.now(),
      hits: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deviceId: 'dev_test',
      version: 1,
    })
  })

  it('exports every table with metadata', async () => {
    const backup = await createBackup()

    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(backup.schemaVersion).toBe(BACKUP_SCHEMA_VERSION)
    expect(backup.deviceId.length).toBeGreaterThan(0)
    expect(backup.counts.projects).toBe(2)
    expect(backup.counts.settings).toBe(2)
    expect(backup.counts.cache).toBe(1)
    for (const table of TABLE_NAMES) {
      expect(Array.isArray(backup.tables[table]), table).toBe(true)
    }
  })

  it('round-trips through JSON', async () => {
    const original = await createBackup()
    const json = serializeBackup(original)
    const parsed = parseBackup(json)

    expect(parsed.counts).toEqual(original.counts)
    expect(parsed.tables.projects).toEqual(original.tables.projects)
    expect(parsed.tables.settings).toEqual(original.tables.settings)

    await db.projects.clear()
    await db.settings.clear()
    await db.cache.clear()
    expect(await db.projects.count()).toBe(0)

    const report = await restoreBackup(parsed, 'replace')
    expect(report.mode).toBe('replace')
    expect(report.imported.projects).toBe(2)
    expect(await db.projects.count()).toBe(2)
    expect(await db.settings.count()).toBe(2)
    expect(await db.cache.count()).toBe(1)

    const restored = await db.projects.get('prj_1')
    expect(restored?.name).toBe('Annual report')
    expect(restored?.updatedAt).toBe(1_700_000_000_000)
    expect(restored?.deviceId).toBe('dev_test')
    expect(restored?.version).toBe(1)
  })

  it('merges without overwriting newer local rows', async () => {
    const backup = await createBackup()

    // Backup also carries a project this device has never seen.
    backup.tables.projects = [
      ...(backup.tables.projects ?? []),
      makeProject('prj_3', 'Onboarding guide', 1_700_000_200_000),
    ]
    backup.counts.projects = backup.tables.projects.length

    // Local row becomes newer than the backup copy.
    await db.projects.put({
      ...makeProject('prj_1', 'Annual report (edited)', 1_700_000_900_000),
      version: 3,
    })

    const report = await restoreBackup(backup, 'merge')
    expect(report.imported.projects).toBe(1)
    expect(report.skipped.projects).toBe(2)

    const kept = await db.projects.get('prj_1')
    expect(kept?.name).toBe('Annual report (edited)')
    expect(kept?.version).toBe(3)

    const unchanged = await db.projects.get('prj_2')
    expect(unchanged?.name).toBe('User manual')

    const imported = await db.projects.get('prj_3')
    expect(imported?.name).toBe('Onboarding guide')
    expect(await db.projects.count()).toBe(3)
  })

  it('rejects malformed backups before touching the database', async () => {
    expect(() => parseBackup('not json')).toThrow(BackupError)
    expect(() => parseBackup('{"format":"other"}')).toThrow(BackupError)
    expect(() =>
      parseBackup(
        JSON.stringify({
          format: BACKUP_FORMAT,
          schemaVersion: BACKUP_SCHEMA_VERSION + 5,
          tables: {},
        }),
      ),
    ).toThrow(BackupError)
    expect(() =>
      parseBackup(
        JSON.stringify({
          format: BACKUP_FORMAT,
          schemaVersion: 1,
          tables: { projects: [{ noId: true }] },
        }),
      ),
    ).toThrow(BackupError)

    expect(await db.projects.count()).toBe(2)
  })
})
