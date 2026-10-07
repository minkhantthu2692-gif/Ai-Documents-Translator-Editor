/**
 * Source-file repository.
 *
 * Keeps the original PDF bytes per project so thumbnails, background renders
 * and "re-parse this document" keep working after a reload without asking the
 * user for the file again.
 */

import { getDb } from './db'
import { stampNew, stampUpdate } from './repo-common'
import type { SourceFileRecord } from './types'

const SAMPLE_CHUNK = 256 * 1024

/**
 * Cheap content fingerprint: FNV-1a over up to three sampled 256 KB windows
 * (head, middle, tail) plus the exact size. Sampled rather than total so a
 * 150 MB file never blocks the main thread.
 */
export async function checksumOf(blob: Blob): Promise<string> {
  const size = blob.size
  const starts = [
    0,
    Math.max(0, Math.floor(size / 2) - SAMPLE_CHUNK / 2),
    Math.max(0, size - SAMPLE_CHUNK),
  ]
  let hash = 0x811c9dc5
  // Fold the size in first so files that share a sampled window still differ.
  const sizeBytes = new Uint8Array(8)
  new DataView(sizeBytes.buffer).setBigUint64(0, BigInt(size))
  for (const byte of sizeBytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  for (const start of starts) {
    const chunk = new Uint8Array(await blob.slice(start, start + SAMPLE_CHUNK).arrayBuffer())
    for (let i = 0; i < chunk.length; i += 1) {
      hash ^= chunk[i]
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${size.toString(36)}`
}

export interface PutSourceFileInput {
  projectId: string
  file: Blob
  name: string
  pageCount: number
  checksum?: string
  /** Password of an encrypted PDF — stored so reloads can re-open it. */
  password?: string
  /**
   * Pre-assigned id. The wizard generates it when the file is picked so the
   * analysis worker can be talking about `id` before any project exists — the
   * record then keeps the same identity.
   */
  id?: string
}

export class SourceFileRepository {
  get(id: string): Promise<SourceFileRecord | undefined> {
    return getDb().sourceFiles.get(id)
  }

  listByProject(projectId: string): Promise<SourceFileRecord[]> {
    return getDb().sourceFiles.where('projectId').equals(projectId).sortBy('updatedAt')
  }

  async getLatestByProject(projectId: string): Promise<SourceFileRecord | undefined> {
    const rows = await this.listByProject(projectId)
    return rows[rows.length - 1]
  }

  async put(input: PutSourceFileInput): Promise<SourceFileRecord> {
    const db = getDb()
    const checksum = input.checksum ?? (await checksumOf(input.file))
    const record = stampNew<SourceFileRecord>(
      {
        id: input.id,
        projectId: input.projectId,
        name: input.name,
        size: input.file.size,
        mime: input.file.type || 'application/pdf',
        blob: input.file,
        pageCount: input.pageCount,
        checksum,
        password: input.password ?? null,
      },
      'src',
    )
    // `put` (not `add`): a retried Start with the same pre-assigned id must not
    // throw halfway through creating a project.
    await db.sourceFiles.put(record)
    return record
  }

  async update(id: string, patch: Partial<SourceFileRecord>): Promise<SourceFileRecord> {
    const db = getDb()
    const existing = await this.get(id)
    if (!existing) throw new Error(`source file ${id} not found`)
    const next = stampUpdate(existing, patch)
    await db.sourceFiles.put(next)
    return next
  }

  async remove(id: string): Promise<void> {
    await getDb().sourceFiles.delete(id)
  }

  async removeByProject(projectId: string): Promise<number> {
    const rows = await this.listByProject(projectId)
    await getDb().sourceFiles.bulkDelete(rows.map((row) => row.id))
    return rows.length
  }

  /** Total bytes held for a project (shown in Settings → Cache). */
  async bytesByProject(projectId: string): Promise<number> {
    const rows = await this.listByProject(projectId)
    return rows.reduce((sum, row) => sum + row.size, 0)
  }
}

export const sourceFileRepo = new SourceFileRepository()
