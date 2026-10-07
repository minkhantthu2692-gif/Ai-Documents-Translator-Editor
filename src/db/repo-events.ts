/** Event repository — append-only timeline behind the Logs page. */

import type { AppEvent } from '@/core/events'
import type { Severity } from '@/core/reasonCodes'
import { getDb } from './db'
import type { EventRecord } from './types'

export interface EventQuery {
  severities?: Severity[]
  reasonCode?: string | null
  projectId?: string | null
  search?: string
  since?: number
  limit?: number
}

const MAX_EVENTS = 5000

export class EventRepository {
  async append(event: AppEvent): Promise<EventRecord> {
    const record: EventRecord = {
      id: event.id,
      timestamp: event.timestamp,
      state: event.state,
      pageIndex: event.pageIndex,
      lineIndex: event.lineIndex,
      reasonCode: event.reasonCode,
      severity: event.severity,
      messageMy: event.messageMy,
      messageEn: event.messageEn,
      technicalDetail: event.technicalDetail,
      fixActions: event.fixActions,
      projectId: event.projectId,
      jobId: event.jobId,
      action: event.action,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      deviceId: event.deviceId,
      version: event.version,
    }
    await getDb().events.add(record)
    await this.trim()
    return record
  }

  async list(query: EventQuery = {}): Promise<EventRecord[]> {
    const { severities, reasonCode, projectId, search, since, limit = 500 } = query
    let rows = await getDb().events.toArray()

    if (severities && severities.length > 0) {
      rows = rows.filter((row) => severities.includes(row.severity))
    }
    if (reasonCode) rows = rows.filter((row) => row.reasonCode === reasonCode)
    if (projectId) rows = rows.filter((row) => row.projectId === projectId)
    if (typeof since === 'number') rows = rows.filter((row) => row.timestamp >= since)
    if (search && search.trim()) {
      const needle = search.trim().toLowerCase()
      rows = rows.filter(
        (row) =>
          row.messageEn.toLowerCase().includes(needle) ||
          row.messageMy.toLowerCase().includes(needle) ||
          row.technicalDetail.toLowerCase().includes(needle) ||
          (row.reasonCode ?? '').toLowerCase().includes(needle),
      )
    }

    rows.sort((a, b) => b.timestamp - a.timestamp)
    return limit ? rows.slice(0, limit) : rows
  }

  async countBySeverity(): Promise<Record<Severity, number>> {
    const counts: Record<Severity, number> = {
      info: 0,
      success: 0,
      warning: 0,
      error: 0,
      critical: 0,
    }
    const rows = await getDb().events.toArray()
    for (const row of rows) counts[row.severity] += 1
    return counts
  }

  clearAll(): Promise<void> {
    return getDb().events.clear()
  }

  private async trim(): Promise<void> {
    const table = getDb().events
    const count = await table.count()
    if (count <= MAX_EVENTS) return
    const rows = await table
      .orderBy('timestamp')
      .limit(count - MAX_EVENTS)
      .primaryKeys()
    await table.bulkDelete(rows)
  }
}

export const eventRepo = new EventRepository()
