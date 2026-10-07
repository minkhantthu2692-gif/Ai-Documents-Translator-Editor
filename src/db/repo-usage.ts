/** Usage statistics — per provider/model/day counters feeding the dashboard charts. */

import { getDb } from './db'
import { getDeviceId } from '@/core/id'
import { stampUpdate } from './repo-common'
import type { UsageStatsRecord } from './types'

export interface UsageInput {
  provider: string
  model: string
  characters?: number
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  ok?: boolean
}

export interface ProviderUsage {
  provider: string
  requests: number
  failedRequests: number
  characters: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface DailyUsage {
  day: string
  requests: number
  characters: number
  tokens: number
}

export function dayKey(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export class UsageRepository {
  async record(input: UsageInput): Promise<UsageStatsRecord> {
    const db = getDb()
    const day = dayKey()
    const existing = await db.usageStats
      .where('[provider+model+day]')
      .equals([input.provider, input.model, day] as never)
      .first()

    if (existing) {
      const next = stampUpdate(existing, {
        requests: existing.requests + 1,
        failedRequests: existing.failedRequests + (input.ok === false ? 1 : 0),
        characters: existing.characters + (input.characters ?? 0),
        tokensIn: existing.tokensIn + (input.tokensIn ?? 0),
        tokensOut: existing.tokensOut + (input.tokensOut ?? 0),
        costUsd: Number((existing.costUsd + (input.costUsd ?? 0)).toFixed(6)),
      })
      await db.usageStats.put(next)
      return next
    }

    const timestamp = Date.now()
    const record: UsageStatsRecord = {
      id: `use_${input.provider}_${input.model}_${day}`,
      provider: input.provider,
      model: input.model,
      day,
      requests: 1,
      failedRequests: input.ok === false ? 1 : 0,
      characters: input.characters ?? 0,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      costUsd: input.costUsd ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      deviceId: getDeviceId(),
      version: 1,
    }
    await db.usageStats.add(record)
    return record
  }

  async totalsByProvider(): Promise<ProviderUsage[]> {
    const rows = await getDb().usageStats.toArray()
    const map = new Map<string, ProviderUsage>()
    for (const row of rows) {
      const entry =
        map.get(row.provider) ??
        ({
          provider: row.provider,
          requests: 0,
          failedRequests: 0,
          characters: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        } satisfies ProviderUsage)
      entry.requests += row.requests
      entry.failedRequests += row.failedRequests
      entry.characters += row.characters
      entry.tokensIn += row.tokensIn
      entry.tokensOut += row.tokensOut
      entry.costUsd += row.costUsd
      map.set(row.provider, entry)
    }
    return Array.from(map.values()).sort((a, b) => b.requests - a.requests)
  }

  /** Last `days` days, oldest first, including empty days. */
  async dailySeries(days = 14): Promise<DailyUsage[]> {
    const rows = await getDb().usageStats.toArray()
    const byDay = new Map<string, DailyUsage>()
    const today = new Date()
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(today)
      date.setDate(today.getDate() - i)
      const key = dayKey(date)
      byDay.set(key, { day: key, requests: 0, characters: 0, tokens: 0 })
    }
    for (const row of rows) {
      const entry = byDay.get(row.day)
      if (!entry) continue
      entry.requests += row.requests
      entry.characters += row.characters
      entry.tokens += row.tokensIn + row.tokensOut
    }
    return Array.from(byDay.values())
  }

  async totals(): Promise<{
    requests: number
    characters: number
    tokens: number
    costUsd: number
  }> {
    const rows = await getDb().usageStats.toArray()
    return rows.reduce(
      (acc, row) => ({
        requests: acc.requests + row.requests,
        characters: acc.characters + row.characters,
        tokens: acc.tokens + row.tokensIn + row.tokensOut,
        costUsd: acc.costUsd + row.costUsd,
      }),
      { requests: 0, characters: 0, tokens: 0, costUsd: 0 },
    )
  }

  clear(): Promise<void> {
    return getDb().usageStats.clear()
  }
}

export const usageRepo = new UsageRepository()
