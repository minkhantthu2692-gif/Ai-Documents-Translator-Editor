/** Outbox — local changes queued for the Phase 5 cloud sync. */

import { getDb } from './db'
import { stampNew, stampUpdate } from './repo-common'
import type { OutboxEntity, OutboxOp, OutboxRecord } from './types'

export class OutboxRepository {
  async enqueue(input: {
    entity: OutboxEntity
    entityId: string
    op: OutboxOp
    payload: unknown
    delayMs?: number
  }): Promise<OutboxRecord> {
    const db = getDb()
    const existing = await db.outbox
      .where('[entity+entityId]')
      .equals([input.entity, input.entityId] as never)
      .first()

    if (existing) {
      const next = stampUpdate(existing, {
        op: input.op,
        payload: input.payload,
        attempts: existing.attempts,
        lastError: null,
        nextAttemptAt: Date.now() + (input.delayMs ?? 0),
        sentAt: null,
      })
      await db.outbox.put(next)
      return next
    }

    const record = stampNew<OutboxRecord>(
      {
        entity: input.entity,
        entityId: input.entityId,
        op: input.op,
        payload: input.payload,
        attempts: 0,
        lastError: null,
        nextAttemptAt: Date.now() + (input.delayMs ?? 0),
        sentAt: null,
      },
      'obx',
    )
    await db.outbox.add(record)
    return record
  }

  async due(limit = 50): Promise<OutboxRecord[]> {
    const now = Date.now()
    const rows = await getDb().outbox.toArray()
    return rows
      .filter((row) => row.sentAt === null && row.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit)
  }

  async markSent(id: string): Promise<void> {
    const db = getDb()
    const row = await db.outbox.get(id)
    if (!row) return
    await db.outbox.put(stampUpdate(row, { sentAt: Date.now(), lastError: null }))
  }

  async markFailed(id: string, error: string, retryDelayMs: number): Promise<void> {
    const db = getDb()
    const row = await db.outbox.get(id)
    if (!row) return
    await db.outbox.put(
      stampUpdate(row, {
        attempts: row.attempts + 1,
        lastError: error,
        nextAttemptAt: Date.now() + retryDelayMs,
      }),
    )
  }

  async pendingCount(): Promise<number> {
    const rows = await getDb().outbox.toArray()
    return rows.filter((row) => row.sentAt === null).length
  }

  async listPending(): Promise<OutboxRecord[]> {
    const rows = await getDb().outbox.toArray()
    return rows.filter((row) => row.sentAt === null)
  }

  async clearSent(): Promise<number> {
    return getDb()
      .outbox.filter((row) => row.sentAt !== null)
      .delete()
  }

  clearAll(): Promise<void> {
    return getDb().outbox.clear()
  }
}

export const outboxRepo = new OutboxRepository()
