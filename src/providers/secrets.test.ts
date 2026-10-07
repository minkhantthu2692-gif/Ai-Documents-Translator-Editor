/**
 * Secret hygiene — Phase 3 acceptance: "no key appears in logs/network URLs".
 *
 * The key may only travel in a request header, and every error string that
 * could echo it back must pass through `redactSecret` first. Both facts are
 * asserted against the real adapters with a stubbed `fetch`, so the URL that
 * would land in a request log is the one under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerMeta } from '@/config/models.config'
import { requestJson, redactSecret } from './http'
import { createGeminiAdapter } from './gemini'
import { adapterConfigFor, createOpenAiCompatAdapter } from './openaiCompat'
import { ProviderError, type TranslateCall } from './types'

const SECRET = 'sk-LEAK-CANARY-0123456789'

const CALL: TranslateCall = {
  model: 'gemini-2.5-flash',
  system: 'Translate the line.',
  user: 'Hello',
  temperature: 0.1,
}

interface Capture {
  url: string
  headers: Record<string, string>
}

/** Replaces `fetch` with a canned response and records what was sent. */
function stubFetch(status: number, body: unknown): Capture[] {
  const seen: Capture[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: { headers?: Record<string, string> } | undefined) => {
      seen.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        text: async () => JSON.stringify(body),
      } as unknown as Response
    }),
  )
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('secret never reaches the URL', () => {
  it('sends the Gemini key as x-goog-api-key, not as ?key=', async () => {
    const seen = stubFetch(200, {
      candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
    })
    const adapter = createGeminiAdapter(providerMeta('gemini'))

    const result = await adapter.translate(SECRET, CALL)

    expect(seen).toHaveLength(1)
    expect(seen[0].url).not.toContain(SECRET)
    expect(seen[0].url).not.toContain('key=')
    expect(seen[0].url).toContain(':generateContent')
    expect(seen[0].headers['x-goog-api-key']).toBe(SECRET)
    expect(result.text).toBe('{"items":[]}')
    expect(result.tokensIn).toBe(3)
    expect(result.tokensOut).toBe(5)
  })

  it('sends an OpenAI-compatible key as a Bearer header', async () => {
    const seen = stubFetch(200, {
      choices: [{ message: { content: 'translated' } }],
      usage: { prompt_tokens: 2, completion_tokens: 4 },
    })
    const adapter = createOpenAiCompatAdapter(adapterConfigFor(providerMeta('openai')))

    const result = await adapter.translate(SECRET, { ...CALL, model: 'gpt-4o-mini' })

    expect(seen).toHaveLength(1)
    expect(seen[0].url).not.toContain(SECRET)
    expect(seen[0].headers['Authorization']).toBe(`Bearer ${SECRET}`)
    expect(result.text).toBe('translated')
    expect(result.tokensIn).toBe(2)
    expect(result.tokensOut).toBe(4)
  })
})

describe('error strings are redacted', () => {
  it('masks a provider error body that echoes the key', async () => {
    stubFetch(401, { error: { message: `API key not valid: ${SECRET}` } })

    const error = await requestJson('https://example.test/v1/chat/completions', {
      method: 'GET',
      headers: {},
      secrets: [SECRET],
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderError)
    const message = String((error as Error).message)
    expect(message).not.toContain(SECRET)
    expect(message).toContain('••••')
    expect(message).toContain('HTTP 401')
  })

  it('masks the key inside a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`getaddrinfo ENOTFOUND api.example.test?key=${SECRET}`)
      }),
    )

    const error = await requestJson('https://example.test/v1/models', {
      method: 'GET',
      headers: {},
      secrets: [SECRET],
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderError)
    expect(String((error as Error).message)).not.toContain(SECRET)
  })
})

describe('redactSecret', () => {
  it('replaces every occurrence of a real secret', () => {
    expect(redactSecret(`token ${SECRET} again ${SECRET}`, [SECRET])).toBe('token •••• again ••••')
  })

  it('ignores empty, null and implausibly short values', () => {
    expect(redactSecret('nothing to hide', ['', 'ab', null, undefined])).toBe('nothing to hide')
  })
})
