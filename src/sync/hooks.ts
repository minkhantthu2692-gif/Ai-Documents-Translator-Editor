/**
 * Outbox hooks for deletions.
 *
 * Collect() can only see rows that still exist, so a delete has to be queued
 * at the moment it happens. The payload is the last-known row re-stamped to
 * "now" with this device's id so the tombstone beats any concurrent remote
 * edit under last-write-wins — otherwise a deletion could lose against a
 * slightly older cloud copy and silently resurrect the record.
 */

import { getDeviceId } from '@/core/id'
import { getDb } from '@/db/db'
import { outboxRepo } from '@/db/repo-outbox'
import type { OutboxEntity } from '@/db/types'

/** Queues an `op:'delete'` tombstone for a record that just vanished. */
export async function enqueueDelete(
  entity: OutboxEntity,
  record: Record<string, unknown>,
): Promise<void> {
  const id = record?.id === undefined || record.id === null ? '' : String(record.id)
  if (!id) return
  const payload: Record<string, unknown> = {
    ...record,
    id,
    updatedAt: Date.now(),
    version: (Number(record.version) || 0) + 1,
    deviceId: getDeviceId(),
  }
  await outboxRepo.enqueue({ entity, entityId: id, op: 'delete', payload })
}

/**
 * Drops queued page/block upserts for a project that is being deleted
 * locally: the server's `deleteProject` action cascades the whole subtree, so
 * re-sending those children afterwards would resurrect them next to the
 * tombstone. The project's own queue entry is kept — `enqueueDelete('project',
 * …)` converts it to a tombstone in place.
 */
export async function dropPendingProjectChildren(projectId: string): Promise<void> {
  const db = getDb()
  await db.outbox
    .filter((row) => {
      if (row.entity !== 'page' && row.entity !== 'block') return false
      const payload = row.payload
      if (!payload || typeof payload !== 'object') return false
      return (payload as { projectId?: unknown }).projectId === projectId
    })
    .delete()
}
