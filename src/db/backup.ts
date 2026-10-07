/**
 * Backup export / import (JSON).
 *
 * The file contains every table, a schema version and provenance metadata so a
 * restore can validate the payload before touching IndexedDB. API keys travel
 * sealed (AES-GCM) and are only decryptable on the device that created them.
 */

import { DB_SCHEMA_VERSION, TABLE_NAMES, getDb, type TableName } from './db'
import { getDeviceId } from '@/core/id'
import { createEvent } from '@/core/events'
import { eventRepo } from './repo-events'

export const BACKUP_FORMAT = 'aidt-backup'
export const BACKUP_SCHEMA_VERSION = 1

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  schemaVersion: number
  dbSchemaVersion: number
  exportedAt: number
  deviceId: string
  appVersion: string
  counts: Record<string, number>
  tables: Partial<Record<TableName, unknown[]>>
}

export interface RestoreReport {
  mode: 'replace' | 'merge'
  imported: Record<string, number>
  skipped: Record<string, number>
  warnings: string[]
}

export class BackupError extends Error {
  readonly reasonCode: 'BACKUP_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
    this.reasonCode = 'BACKUP_INVALID'
  }
}

function appVersion(): string {
  return import.meta.env?.VITE_APP_VERSION ?? '0.1.0'
}

/** Reads every table into a plain serialisable object. */
export async function createBackup(): Promise<BackupFile> {
  const db = getDb()
  const tables: Partial<Record<TableName, unknown[]>> = {}
  const counts: Record<string, number> = {}

  for (const name of TABLE_NAMES) {
    const rows = await db.table(name).toArray()
    tables[name] = rows as unknown[]
    counts[name] = rows.length
  }

  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    dbSchemaVersion: DB_SCHEMA_VERSION,
    exportedAt: Date.now(),
    deviceId: getDeviceId(),
    appVersion: appVersion(),
    counts,
    tables,
  }
}

export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2)
}

/** Validates untrusted JSON before any write happens. */
export function parseBackup(json: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new BackupError(`Not valid JSON: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new BackupError('Backup is not an object')
  const candidate = parsed as Partial<BackupFile>
  if (candidate.format !== BACKUP_FORMAT) {
    throw new BackupError(`Unexpected format: ${String(candidate.format)}`)
  }
  if (typeof candidate.schemaVersion !== 'number' || candidate.schemaVersion < 1) {
    throw new BackupError('Missing backup schema version')
  }
  if (candidate.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new BackupError(
      `Backup schema ${candidate.schemaVersion} is newer than supported ${BACKUP_SCHEMA_VERSION}`,
    )
  }
  if (!candidate.tables || typeof candidate.tables !== 'object') {
    throw new BackupError('Backup has no tables')
  }
  for (const key of Object.keys(candidate.tables)) {
    if (!TABLE_NAMES.includes(key as TableName)) {
      throw new BackupError(`Unknown table in backup: ${key}`)
    }
    const rows = (candidate.tables as Record<string, unknown>)[key]
    if (!Array.isArray(rows)) throw new BackupError(`Table "${key}" is not an array`)
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') {
        throw new BackupError(`Table "${key}" contains a row without a string id`)
      }
    }
  }
  return candidate as BackupFile
}

/**
 * Restores a validated backup.
 *  - replace: wipes local tables, then writes the backup contents.
 *  - merge:   keeps the newer of local vs. incoming rows (matched by id).
 */
export async function restoreBackup(
  backup: BackupFile,
  mode: 'replace' | 'merge' = 'replace',
): Promise<RestoreReport> {
  const db = getDb()
  const imported: Record<string, number> = {}
  const skipped: Record<string, number> = {}
  const warnings: string[] = []

  if (backup.tables.apiKeys?.length && backup.deviceId !== getDeviceId()) {
    warnings.push('apiKeys.device-bound')
  }

  for (const name of TABLE_NAMES) {
    const incoming = (backup.tables[name] ?? []) as { id: string; updatedAt?: number }[]
    imported[name] = 0
    skipped[name] = 0

    if (mode === 'replace') {
      await db.transaction('rw', db.table(name), async () => {
        await db.table(name).clear()
        if (incoming.length) {
          await db.table(name).bulkAdd(incoming)
          imported[name] = incoming.length
        }
      })
      continue
    }

    await db.transaction('rw', db.table(name), async () => {
      for (const row of incoming) {
        const local = await db.table(name).get(row.id)
        if (!local) {
          await db.table(name).add(row)
          imported[name] += 1
        } else if ((row.updatedAt ?? 0) > ((local as { updatedAt?: number }).updatedAt ?? 0)) {
          await db.table(name).put(row)
          imported[name] += 1
        } else {
          skipped[name] += 1
        }
      }
    })
  }

  await eventRepo.append(
    createEvent({
      state: 'BACKUP',
      action: `backup.restore.${mode}`,
      severity: 'success',
      messageMy: `မိတ္တူပြန်တင်ပြီး (${mode === 'replace' ? 'အစားထိုး' : 'ပေါင်းထည့်'})`,
      messageEn: `Backup restored (${mode})`,
      technicalDetail: JSON.stringify({ imported, skipped, warnings }),
    }),
  )

  return { mode, imported, skipped, warnings }
}

/**
 * Triggers a download. The object URL is revoked immediately after the click
 * hand-off so no blob stays alive in memory.
 */
export async function downloadBackup(): Promise<string> {
  const backup = await createBackup()
  const json = serializeBackup(backup)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `aidt-backup-${stamp}.json`
  saveJsonFile(json, filename)
  return filename
}

export function saveJsonFile(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Reads a File (from an <input type="file">) and restores it. */
export async function restoreBackupFromFile(
  file: File,
  mode: 'replace' | 'merge',
): Promise<RestoreReport> {
  const text = await file.text()
  const backup = parseBackup(text)
  return restoreBackup(backup, mode)
}
