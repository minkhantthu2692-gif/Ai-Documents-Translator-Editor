/**
 * Troubleshooting Assistant tests.
 *
 * Covers the five layers of the feature:
 *   1. redaction — no secret-shaped string survives `redact()`,
 *   2. offline rules — reason codes / sync codes / keywords → bilingual answers,
 *   3. proxy client — normalisation, and every failure degrading to offline,
 *   4. safe actions — settings mutations, navigation effects, guards,
 *   5. context building — seeds, provider/model, logs, redacted memory.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase, getDb, setDb } from '@/db/db'
import { resetDeviceIdCache } from '@/core/id'
import { createEvent } from '@/core/events'
import { eventRepo } from '@/db/repo-events'
import { apiKeyRepo } from '@/db/repo-apiKeys'
import { cacheRepo } from '@/db/repo-cache'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { runSafeAction } from './actions'
import { askAssistant, assistantEndpoint, normalizeAnswer } from './client'
import { buildContext } from './context'
import { errorMemory } from './errorMemory'
import { redact, redactText } from './redact'
import { ruleAnswer } from './rules'
import type { AssistantContext } from './types'

const MYANMAR_RE = /[\u1000-\u109f\uaa60-\uaaff]/

function ctx(overrides: Partial<AssistantContext> = {}): AssistantContext {
  return {
    errorCode: null,
    reasonCode: null,
    stack: null,
    jobState: null,
    provider: null,
    model: null,
    recentLogs: [],
    browser: 'test-browser',
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Redaction                                                               */
/* -------------------------------------------------------------------------- */

describe('redact', () => {
  it('strips provider keys, bearer tokens and query secrets', () => {
    expect(redactText('failure with key sk-or-v1-abcdef1234567890xyz in config')).not.toContain(
      'sk-or-v1',
    )
    expect(redactText('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456')
    expect(redactText('https://x.test/?api_key=supersecret123&page=2')).not.toContain(
      'supersecret123',
    )
    expect(redactText('github token ghp_abcdefghijklmnopqrstuv')).not.toContain('ghp_')
    expect(redactText(`hash ${'a1'.repeat(32)}`)).not.toContain('a1a1a1a1')
  })

  it('keeps ordinary text intact', () => {
    const text = 'SYNC_FAILED: the sheet lock timed out after 30s'
    expect(redactText(text)).toBe(text)
  })

  it('deep-redacts nested structures', () => {
    const input = {
      logs: ['token=abcdef1234567890 failed', 'ok'],
      meta: { stack: 'at fetch (sk-proj-12345678901234567890)' },
    }
    const output = redact(input)
    expect(JSON.stringify(output)).not.toContain('abcdef1234567890')
    expect(JSON.stringify(output)).not.toContain('sk-proj-')
    expect(output.logs[1]).toBe('ok')
  })

  it('survives cyclic references', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    expect(() => redact(cyclic)).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Error memory                                                             */
/* -------------------------------------------------------------------------- */

describe('errorMemory', () => {
  afterEach(() => errorMemory.clear())

  it('remembers, lists and clears entries', () => {
    errorMemory.remember('UNAUTHORIZED', 'token rejected')
    errorMemory.remember(null, 'second failure')
    expect(errorMemory.recent(10)).toHaveLength(2)
    expect(errorMemory.last()?.message).toBe('second failure')
    expect(errorMemory.last()?.code).toBeNull()
    errorMemory.clear()
    expect(errorMemory.last()).toBeNull()
  })

  it('caps the ring at 20 entries', () => {
    for (let i = 0; i < 25; i += 1) errorMemory.remember(`C${i}`, `m${i}`)
    expect(errorMemory.recent(100)).toHaveLength(20)
    expect(errorMemory.recent(100)[0].code).toBe('C5')
  })

  it('redacts secrets on the way in', () => {
    errorMemory.remember(null, 'config had sk-or-v1-deadbeefdeadbeefdead')
    expect(errorMemory.last()?.message).not.toContain('deadbeef')
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Offline rules                                                            */
/* -------------------------------------------------------------------------- */

describe('ruleAnswer', () => {
  it('answers a rate-limit question with steps and safe actions', () => {
    const answer = ruleAnswer('I got a 429 rate limit error', ctx(), 'en')
    expect(answer.title).toMatch(/rate limit/i)
    expect(answer.steps.length).toBeGreaterThanOrEqual(2)
    expect(answer.actions.length).toBeGreaterThanOrEqual(1)
    expect(answer.actions.map((a) => a.id)).toContain('reduce-batch')
  })

  it('answers in Burmese when asked in Myanmar', () => {
    const answer = ruleAnswer('အင်တာနက် မရှိဘူး', ctx(), 'my')
    expect(MYANMAR_RE.test(answer.title)).toBe(true)
    expect(MYANMAR_RE.test(answer.explanation)).toBe(true)
    expect(answer.steps.every((step) => MYANMAR_RE.test(step))).toBe(true)
  })

  it('uses the structured sync error code when the question is empty', () => {
    const answer = ruleAnswer('', ctx({ errorCode: 'UNAUTHORIZED' }), 'en')
    expect(answer.title).toMatch(/token/i)
    expect(answer.actions.map((a) => a.id)).toContain('open-data')
  })

  it('maps reason codes to plain-language explanations', () => {
    const answer = ruleAnswer('', ctx({ reasonCode: 'NO_API_KEY' }), 'en')
    expect(answer.title).toMatch(/API key/i)
    expect(answer.steps.length).toBeGreaterThanOrEqual(2)
  })

  it('matches sync keywords before falling back', () => {
    const answer = ruleAnswer('google sheet sync keeps failing', ctx(), 'en')
    expect(answer.title).toMatch(/sync/i)
  })

  it('always returns a usable fallback with three actions', () => {
    const answer = ruleAnswer('', ctx(), 'en')
    expect(answer.steps.length).toBeGreaterThanOrEqual(2)
    expect(answer.actions).toHaveLength(3)
    const my = ruleAnswer('', ctx(), 'my')
    expect(MYANMAR_RE.test(my.title)).toBe(true)
  })

  it('offers only executable action ids', () => {
    const executable = new Set([
      'rotate-key',
      'reduce-batch',
      'clear-cache',
      'retry',
      'open-providers',
      'open-data',
      'open-logs',
    ])
    for (const question of ['', 'quota exceeded', 'sync failed', 'export broken']) {
      const answer = ruleAnswer(question, ctx(), 'en')
      for (const action of answer.actions) expect(executable.has(action.id)).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Proxy client                                                             */
/* -------------------------------------------------------------------------- */

describe('assistant client', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('normalises the endpoint URL', () => {
    expect(assistantEndpoint('https://p.example')).toBe('https://p.example/assistant')
    expect(assistantEndpoint('https://p.example/')).toBe('https://p.example/assistant')
    expect(assistantEndpoint('https://p.example/assistant')).toBe('https://p.example/assistant')
  })

  it('falls back to offline rules when no proxy is configured', async () => {
    vi.stubEnv('VITE_ASSISTANT_PROXY_URL', '')
    const result = await askAssistant({ question: 'quota exceeded', context: ctx(), lang: 'en' })
    expect(result.mode).toBe('offline')
    expect(result.fallbackReason).toBe('proxy-not-configured')
    expect(result.answer.steps.length).toBeGreaterThan(0)
  })

  it('uses the proxy when it answers', async () => {
    vi.stubEnv('VITE_ASSISTANT_PROXY_URL', 'https://p.example')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          model: 'meta-llama/llama-3.3-70b-instruct:free',
          answer: {
            title: 'Cloud sync problem',
            explanation: 'The token no longer matches the script property.',
            steps: ['Copy the new token.', 'Paste it in Settings → Data.'],
            actions: [
              { id: 'retry-job', label: 'Retry', kind: 'retry' },
              { id: 'open-settings', label: 'Settings', kind: 'navigation' },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await askAssistant({ question: 'sync broke', context: ctx(), lang: 'en' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://p.example/assistant')
    expect(String(init.body)).toContain('"lang":"en"')
    expect(result.mode).toBe('proxy')
    expect(result.model).toContain('llama')
    expect(result.fallbackReason).toBeNull()
    // Model-chosen ids are mapped onto the executable vocabulary.
    expect(result.answer.actions.map((a) => a.id)).toEqual(['retry', 'open-data'])
  })

  it('falls back offline on a proxy error envelope (MISSING_KEY)', async () => {
    vi.stubEnv('VITE_ASSISTANT_PROXY_URL', 'https://p.example')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, code: 'MISSING_KEY', message: 'no key' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const result = await askAssistant({ question: '', context: ctx(), lang: 'en' })
    expect(result.mode).toBe('offline')
    expect(result.fallbackReason).toBe('MISSING_KEY')
    expect(result.answer.title.length).toBeGreaterThan(0)
  })

  it('falls back offline when the body is not JSON', async () => {
    vi.stubEnv('VITE_ASSISTANT_PROXY_URL', 'https://p.example')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>error</html>', { status: 200 })),
    )
    const result = await askAssistant({ question: '', context: ctx(), lang: 'en' })
    expect(result.mode).toBe('offline')
    expect(result.fallbackReason).toMatch(/^network:/)
  })

  it('falls back offline on a network failure or abort', async () => {
    vi.stubEnv('VITE_ASSISTANT_PROXY_URL', 'https://p.example')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    const first = await askAssistant({ question: '', context: ctx(), lang: 'en' })
    expect(first.mode).toBe('offline')
    expect(first.fallbackReason).toMatch(/^network:/)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')))
    const second = await askAssistant({ question: '', context: ctx(), lang: 'my' })
    expect(second.mode).toBe('offline')
    expect(second.fallbackReason).toBe('timeout')
    expect(MYANMAR_RE.test(second.answer.title)).toBe(true)
  })
})

describe('normalizeAnswer', () => {
  it('caps steps and deduplicates mapped action ids', () => {
    const answer = normalizeAnswer({
      title: 'T',
      explanation: 'E',
      steps: Array.from({ length: 10 }, (_, i) => `step ${i}`),
      actions: [
        { id: 'retry-job', label: 'Retry', kind: 'retry' },
        { id: 'rerun', label: 'Rerun', kind: 'retry' },
        { id: 'mystery', label: '??', kind: 'data' },
      ],
    })
    expect(answer?.steps).toHaveLength(6)
    // 'retry-job' and 'rerun' both map to 'retry'; 'mystery' is dropped.
    expect(answer?.actions.map((a) => a.id)).toEqual(['retry'])
    expect(answer?.actions[0].label).toBe('Retry')
  })

  it('rejects unusable shapes and redacts echoed secrets', () => {
    expect(normalizeAnswer(null)).toBeNull()
    expect(normalizeAnswer({ explanation: 'no title' })).toBeNull()
    const answer = normalizeAnswer({
      title: 'Leak',
      explanation: 'the key sk-or-v1-abc123def456ghi789 was rejected',
      steps: [],
      actions: [],
    })
    expect(answer?.explanation).not.toContain('sk-or-v1-')
  })
})

/* -------------------------------------------------------------------------- */
/* 5. Safe actions + context (IndexedDB)                                       */
/* -------------------------------------------------------------------------- */

describe('assistant with local database', () => {
  let dbCounter = 0

  beforeEach(async () => {
    dbCounter += 1
    const db = new AppDatabase(`aidt-assistant-${Date.now()}-${dbCounter}`)
    setDb(db)
    await db.open()
    resetDeviceIdCache()
    errorMemory.clear()
  })

  afterEach(async () => {
    errorMemory.clear()
    setDb(null)
  })

  it('reduce-batch lowers translate.batchMaxLines with a floor of 5', async () => {
    await settingsRepo.set(SETTING_KEYS.batchMaxLines, 25, 'translate')
    const outcome = await runSafeAction('reduce-batch')
    expect(outcome.ok).toBe(true)
    expect(await settingsRepo.get(SETTING_KEYS.batchMaxLines, 25)).toBe(15)
    expect(outcome.titleEn).toContain('15')

    await settingsRepo.set(SETTING_KEYS.batchMaxLines, 5, 'translate')
    const atFloor = await runSafeAction('reduce-batch')
    expect(atFloor.ok).toBe(false)
    expect(await settingsRepo.get(SETTING_KEYS.batchMaxLines, 25)).toBe(5)
  })

  it('clear-cache empties the cache without touching settings', async () => {
    await cacheRepo.put('translation', 'key-1', { text: 'cached' })
    expect(await getDb().cache.count()).toBeGreaterThan(0)
    const outcome = await runSafeAction('clear-cache')
    expect(outcome.ok).toBe(true)
    expect(await getDb().cache.count()).toBe(0)
  })

  it('rotate-key clears cooldowns and points at AI Providers', async () => {
    const created = await apiKeyRepo.create({
      provider: 'openrouter',
      label: 'main',
      secret: 'sk-or-v1-testkey123456',
    })
    await getDb().apiKeys.update(created.id, {
      cooldownUntil: Date.now() + 600_000,
      cooldownReason: 'rate_limit',
    })
    const outcome = await runSafeAction('rotate-key')
    expect(outcome.ok).toBe(true)
    expect(outcome.effect).toEqual({ type: 'navigate', to: '/settings?tab=providers' })
    const rows = await apiKeyRepo.list()
    expect(rows[0].cooldownUntil).toBe(0)
    expect(rows[0].cooldownReason).toBeNull()
    // Never leaks key material into the toast copy.
    expect(outcome.titleEn).not.toContain('testkey123456')
  })

  it('navigation actions return the right targets', async () => {
    expect((await runSafeAction('open-data')).effect).toEqual({
      type: 'navigate',
      to: '/settings?tab=data',
    })
    expect((await runSafeAction('open-logs')).effect).toEqual({ type: 'navigate', to: '/logs' })
    const unknown = await runSafeAction('drop-everything')
    expect(unknown.ok).toBe(false)
    expect(unknown.effect).toBeUndefined()
  })

  it('retry becomes sync-now in sync context and reload otherwise', async () => {
    const syncRetry = await runSafeAction('retry', { syncContext: true })
    expect(syncRetry.effect).toEqual({ type: 'sync-now' })
    const plainRetry = await runSafeAction('retry')
    expect(plainRetry.effect).toEqual({ type: 'reload' })
  })

  it('buildContext seeds codes, reads provider/model and redacts memory', async () => {
    await settingsRepo.set(SETTING_KEYS.provider, 'openrouter', 'ai')
    await settingsRepo.set(SETTING_KEYS.model, 'meta-llama/llama-3.3-70b-instruct:free', 'ai')
    errorMemory.remember('UNAUTHORIZED', 'token=abcdef1234567890 rejected')
    await eventRepo.append(
      createEvent({
        state: 'SYNC',
        action: 'sync.push',
        severity: 'error',
        reasonCode: 'SYNC_FAILED',
        messageEn: 'Push failed',
        messageMy: 'တင်သွင်းမှု မအောင်မြင်ပါ',
        technicalDetail: 'sk-or-v1-secretleak999 in body',
      }),
    )

    const built = await buildContext()
    expect(built.provider).toBe('openrouter')
    expect(built.model).toContain('llama')
    expect(built.errorCode).toBe('UNAUTHORIZED')
    expect(built.reasonCode).toBe('SYNC_FAILED')
    expect(built.browser).toContain('online=')
    expect(built.recentLogs.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(built)
    expect(serialized).not.toContain('abcdef1234567890')
    expect(serialized).not.toContain('secretleak999')

    const seeded = await buildContext({ errorCode: 'SEED_CODE', reasonCode: 'NO_API_KEY' })
    expect(seeded.errorCode).toBe('SEED_CODE')
    expect(seeded.reasonCode).toBe('NO_API_KEY')
  })
})
