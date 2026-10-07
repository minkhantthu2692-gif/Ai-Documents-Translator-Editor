/**
 * Per-block revision history (Phase 4).
 *
 * Every edit the editor applies writes one row with only the fields it
 * changed, so the inspector can show a timeline per block, "restore" an old
 * value, and the undo stack has a durable audit trail to fall back on.
 */

import { getDb } from './db'
import { stampNew } from './repo-common'
import type { RevisionAction, RevisionRecord } from './types'

/** Hard cap per block so a long editing session cannot grow without bound. */
export const REVISION_KEEP = 50

export interface RevisionInput {
  projectId: string
  blockId: string
  pageIndex: number
  action: RevisionAction
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** `user` or the model id that produced the change. */
  actor?: string
  note?: string
  timestamp?: number
}

export class RevisionRepository {
  async record(input: RevisionInput): Promise<RevisionRecord> {
    const record = stampNew<RevisionRecord>(
      {
        ...input,
        actor: input.actor ?? 'user',
        note: input.note ?? '',
        timestamp: input.timestamp ?? Date.now(),
      },
      'rev',
    )
    await getDb().revisions.add(record)
    // Cap the per-block history: oldest beyond the limit go first.
    const count = await getDb().revisions.where('blockId').equals(record.blockId).count()
    if (count > REVISION_KEEP) {
      const stale = await getDb()
        .revisions.where('blockId')
        .equals(record.blockId)
        .sortBy('timestamp')
      const drop = stale.slice(0, count - REVISION_KEEP).map((row) => row.id)
      if (drop.length > 0) await getDb().revisions.bulkDelete(drop)
    }
    return record
  }

  get(id: string): Promise<RevisionRecord | undefined> {
    return getDb().revisions.get(id)
  }

  /** Newest first. */
  async listByBlock(blockId: string, limit = REVISION_KEEP): Promise<RevisionRecord[]> {
    const rows = await getDb().revisions.where('blockId').equals(blockId).toArray()
    return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
  }

  /** Newest first across the project (the "document history" view). */
  async listByProject(projectId: string, limit = 200): Promise<RevisionRecord[]> {
    const rows = await getDb().revisions.where('projectId').equals(projectId).toArray()
    return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
  }

  countByProject(projectId: string): Promise<number> {
    return getDb().revisions.where('projectId').equals(projectId).count()
  }

  removeByProject(projectId: string): Promise<number> {
    return getDb().revisions.where('projectId').equals(projectId).delete()
  }
}

export const revisionRepo = new RevisionRepository()
