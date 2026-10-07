/** Job repository — tracks long running pipeline work for the dashboard. */

import { getDb } from './db'
import { stampNew, stampUpdate } from './repo-common'
import type { JobRecord, JobType } from './types'
import type { FsmState } from '@/core/fsm'

const TERMINAL_JOB_STATES: FsmState[] = ['EXPORT_READY', 'CANCELLED', 'FAILED', 'IDLE']

export class JobRepository {
  async create(
    input: Partial<JobRecord> & { type: JobType; projectId?: string | null },
  ): Promise<JobRecord> {
    const db = getDb()
    const record = stampNew<JobRecord>(
      {
        projectId: input.projectId ?? null,
        state: 'PREFLIGHT',
        progress: 0,
        pageIndex: null,
        lineIndex: null,
        reasonCode: null,
        messageMy: '',
        messageEn: '',
        startedAt: Date.now(),
        finishedAt: null,
        ...input,
      },
      'job',
    )
    await db.jobs.add(record)
    return record
  }

  async update(id: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const db = getDb()
    const existing = await db.jobs.get(id)
    if (!existing) throw new Error(`Job not found: ${id}`)
    const next = stampUpdate(existing, patch)
    if (TERMINAL_JOB_STATES.includes(next.state) && next.finishedAt === null) {
      next.finishedAt = Date.now()
      next.updatedAt = next.finishedAt
    }
    await db.jobs.put(next)
    return next
  }

  get(id: string): Promise<JobRecord | undefined> {
    return getDb().jobs.get(id)
  }

  async listActive(): Promise<JobRecord[]> {
    const rows = await getDb().jobs.toArray()
    return rows
      .filter((row) => !TERMINAL_JOB_STATES.includes(row.state))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  async listRecent(limit = 10): Promise<JobRecord[]> {
    const rows = await getDb().jobs.toArray()
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  }

  async listByProject(projectId: string): Promise<JobRecord[]> {
    const rows = await getDb().jobs.where('projectId').equals(projectId).toArray()
    return rows.sort((a, b) => b.startedAt - a.startedAt)
  }

  remove(id: string): Promise<void> {
    return getDb().jobs.delete(id)
  }

  clearFinished(): Promise<number> {
    return getDb()
      .jobs.filter((row) => TERMINAL_JOB_STATES.includes(row.state))
      .delete()
  }
}

export const jobRepo = new JobRepository()
