/**
 * Structured problem context attached to every assistant question.
 *
 * Everything assembled here is run through `redact()` before it leaves this
 * function — the same object feeds the proxy request (whose prompt forbids
 * echoing secrets) and the offline rules (which only read codes).
 */

import { eventRepo } from '@/db/repo-events'
import { jobRepo } from '@/db/repo-jobs'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { errorMemory } from './errorMemory'
import { redact } from './redact'
import type { AssistantContext } from './types'

const MAX_LOG_LINES = 8
const MAX_LOG_LENGTH = 240

function browserLine(): string {
  if (typeof navigator === 'undefined') return 'unknown environment'
  const viewport =
    typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'n/a'
  return `${navigator.userAgent} · lang=${navigator.language} · online=${String(navigator.onLine)} · viewport=${viewport}`
}

function formatLog(row: {
  timestamp: number
  state: string
  reasonCode: string | null
  severity: string
  messageEn: string
  technicalDetail: string
}): string {
  const time = new Date(row.timestamp).toISOString().slice(11, 19)
  const code = row.reasonCode ? ` [${row.reasonCode}]` : ''
  const detail = row.technicalDetail ? ` — ${row.technicalDetail}` : ''
  return `${time} ${row.severity} ${row.state}${code} ${row.messageEn}${detail}`.slice(
    0,
    MAX_LOG_LENGTH,
  )
}

/**
 * @param seed Optional overrides supplied by the entry point (e.g. the Logs
 *             page passes the reason code of the selected event).
 */
export async function buildContext(
  seed: Partial<AssistantContext> = {},
): Promise<AssistantContext> {
  let recentLogs: string[] = []
  let newestReasonCode: AssistantContext['reasonCode'] = null
  let jobState: string | null = null
  let provider: string | null = null
  let model: string | null = null

  try {
    const rows = await eventRepo.list({
      severities: ['error', 'critical', 'warning'],
      limit: 20,
    })
    const ordered = rows.slice().reverse().slice(-MAX_LOG_LINES)
    recentLogs = ordered.map(formatLog)
    newestReasonCode = ordered.length > 0 ? (ordered[ordered.length - 1].reasonCode ?? null) : null
  } catch {
    recentLogs = []
  }

  try {
    const memory = errorMemory.recent(4).map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 19)
      const code = entry.code ? ` [${entry.code}]` : ''
      return `${time} memory${code} ${entry.message}`.slice(0, MAX_LOG_LENGTH)
    })
    const known = new Set(recentLogs.map((line) => line.slice(-80)))
    for (const line of memory) {
      if (recentLogs.length >= MAX_LOG_LINES + 4) break
      if (!known.has(line.slice(-80))) recentLogs.push(line)
    }
  } catch {
    // errorMemory is pure in-memory; ignore.
  }

  if (seed.jobState === undefined) {
    try {
      const [job] = await jobRepo.listRecent(1)
      jobState = job?.state ?? null
    } catch {
      jobState = null
    }
  }

  if (seed.provider === undefined || seed.model === undefined) {
    try {
      const [storedProvider, storedModel] = await Promise.all([
        settingsRepo.get<string>(SETTING_KEYS.provider, ''),
        settingsRepo.get<string>(SETTING_KEYS.model, ''),
      ])
      provider = storedProvider || null
      model = storedModel || null
    } catch {
      provider = null
      model = null
    }
  }

  const memory = errorMemory.last()
  const context: AssistantContext = {
    errorCode: seed.errorCode ?? memory?.code ?? null,
    reasonCode: seed.reasonCode ?? newestReasonCode,
    stack: seed.stack ?? memory?.message ?? null,
    jobState: seed.jobState ?? jobState,
    provider: seed.provider ?? provider,
    model: seed.model ?? model,
    recentLogs: seed.recentLogs ?? recentLogs,
    browser: seed.browser ?? browserLine(),
  }

  return redact(context)
}
