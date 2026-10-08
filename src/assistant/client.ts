/**
 * Assistant client: proxy first, offline rules as the ever-available floor.
 *
 * The proxy (proxy/server.js or proxy/cloudflare-worker.js) holds
 * OPENROUTER_ASSISTANT_KEY server-side — this module only ever sends the
 * question plus the already-redacted context. Every failure mode (no URL
 * configured, network down, 4xx/5xx, malformed body) degrades to
 * `ruleAnswer(...)` with a `fallbackReason` instead of throwing, so the dialog
 * always has something useful to show.
 */

import { redact } from './redact'
import { ruleAnswer } from './rules'
import {
  AssistantError,
  type AskInput,
  type AskResult,
  type AssistantAction,
  type AssistantAnswer,
  type SafeActionId,
} from './types'

const PROXY_TIMEOUT_MS = 20_000

const LIMITS = {
  title: 160,
  explanation: 3000,
  steps: 6,
  stepLength: 400,
  actions: 5,
  labelLength: 60,
} as const

/** Configured proxy base URL ('' when unset → offline mode only). */
export function assistantProxyUrl(): string {
  const raw = import.meta.env.VITE_ASSISTANT_PROXY_URL
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Base URL → `…/assistant` endpoint (the proxy also accepts `/` and `/ask`). */
export function assistantEndpoint(base: string): string {
  const stripped = base.replace(/\/+$/, '').replace(/\/assistant$/i, '')
  return `${stripped}/assistant`
}

const KNOWN_ACTION_IDS: ReadonlySet<string> = new Set<SafeActionId>([
  'rotate-key',
  'reduce-batch',
  'clear-cache',
  'retry',
  'open-providers',
  'open-data',
  'open-logs',
])

/**
 * Proxy models choose their own action ids (`retry-job`, `open-settings`, …).
 * Map them onto the vocabulary the dialog can execute; drop what we cannot
 * run rather than render a dead button.
 */
function mapActionId(id: string): SafeActionId | null {
  const key = id.toLowerCase()
  if (KNOWN_ACTION_IDS.has(key)) return key as SafeActionId
  if (key.includes('rotate')) return 'rotate-key'
  if (key.includes('batch') || key.includes('chunk')) return 'reduce-batch'
  if (key.includes('cache')) return 'clear-cache'
  if (key.includes('provider') || key.includes('key') || key.includes('model'))
    return 'open-providers'
  if (key.includes('log')) return 'open-logs'
  if (
    key.includes('sync') ||
    key.includes('setting') ||
    key.includes('data') ||
    key.includes('project')
  ) {
    return 'open-data'
  }
  if (
    key.includes('retry') ||
    key.includes('rerun') ||
    key.includes('again') ||
    key.includes('job')
  ) {
    return 'retry'
  }
  return null
}

function coerceString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  if (!clean) return null
  return clean.slice(0, maxLength)
}

/** Validates + caps a proxy answer; returns null when unusable. */
export function normalizeAnswer(value: unknown): AssistantAnswer | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const title = coerceString(raw.title, LIMITS.title)
  const explanation = coerceString(raw.explanation, LIMITS.explanation)
  if (!title || !explanation) return null

  const steps: string[] = []
  if (Array.isArray(raw.steps)) {
    for (const step of raw.steps) {
      if (steps.length >= LIMITS.steps) break
      const text = coerceString(step, LIMITS.stepLength)
      if (text) steps.push(text)
    }
  }

  const seen = new Set<string>()
  const actions: AssistantAction[] = []
  if (Array.isArray(raw.actions)) {
    for (const entry of raw.actions) {
      if (actions.length >= LIMITS.actions) break
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const rawId = coerceString(record.id, 40)
      if (!rawId) continue
      const id = mapActionId(rawId)
      if (!id || seen.has(id)) continue
      seen.add(id)
      actions.push({
        id,
        label: coerceString(record.label, LIMITS.labelLength) ?? id,
        kind:
          record.kind === 'retry' || record.kind === 'config' || record.kind === 'data'
            ? record.kind
            : 'navigation',
      })
    }
  }

  // Defense in depth: the proxy should never echo secrets, but scrub anyway.
  return redact({ title, explanation, steps, actions })
}

function offline(input: AskInput, reason: string): AskResult {
  return {
    answer: ruleAnswer(input.question, input.context, input.lang),
    mode: 'offline',
    model: null,
    fallbackReason: reason,
  }
}

async function readErrorCode(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown }
    return {
      code: typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
      message: typeof body.message === 'string' ? body.message : `HTTP ${response.status}`,
    }
  } catch {
    return { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` }
  }
}

/**
 * Asks the assistant. Resolves with the answer and the mode that produced it;
 * never rejects (offline fallback is part of the contract).
 */
export async function askAssistant(input: AskInput): Promise<AskResult> {
  const base = assistantProxyUrl()
  if (!base) return offline(input, 'proxy-not-configured')

  // The dialog auto-asks on open, before the user has typed anything. The
  // proxy contract requires a non-empty question and answers 400 otherwise —
  // a guaranteed failure the browser logs as a console error — so an empty
  // question is answered from the local rules without making a request.
  if (!input.question.trim()) return offline(input, 'empty-question')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
  try {
    const response = await fetch(assistantEndpoint(base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: input.question.slice(0, 4000),
        context: input.context,
        lang: input.lang,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const { code, message } = await readErrorCode(response)
      throw new AssistantError(code, message)
    }

    const body = (await response.json()) as {
      ok?: unknown
      answer?: unknown
      model?: unknown
      code?: unknown
      message?: unknown
    }
    if (body?.ok !== true) {
      throw new AssistantError(
        typeof body.code === 'string' ? body.code : 'BAD_RESPONSE',
        typeof body.message === 'string' ? body.message : 'Bad response',
      )
    }
    const answer = normalizeAnswer(body.answer)
    if (!answer) throw new AssistantError('BAD_SHAPE', 'Proxy returned an unusable answer shape.')

    return {
      answer,
      mode: 'proxy',
      model: typeof body.model === 'string' ? body.model : null,
      fallbackReason: null,
    }
  } catch (err) {
    const name =
      typeof err === 'object' && err !== null && 'name' in err
        ? String((err as { name: unknown }).name)
        : ''
    const reason =
      err instanceof AssistantError
        ? err.code
        : name === 'AbortError'
          ? 'timeout'
          : `network:${err instanceof Error ? err.message : String(err)}`
    return offline(input, reason)
  } finally {
    clearTimeout(timer)
  }
}
