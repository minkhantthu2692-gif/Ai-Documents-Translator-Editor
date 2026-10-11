// @vitest-environment node

/**
 * The reasoning-effort knob must reach the wire only for models the registry
 * flags as reasoning models, and only in the spelling each provider accepts —
 * Groq 400s on an unknown `reasoning` property (live-checked 11 Oct 2026),
 * while an unbounded think starves the answer outright: gpt-oss-120b spent
 * 3042 tokens reasoning with no content left, so every batch came back empty
 * (live sweep, Oct 2026). The registry decides; a guess would be a 400.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerMeta } from '@/config/models.config'
import { adapterConfigFor, createOpenAiCompatAdapter } from './openaiCompat'
import type { TranslateCall } from './types'

const REPLY = JSON.stringify({
  choices: [{ message: { content: '{"items":[]}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
})

/** Posts one translate call and returns the JSON body the adapter sent. */
async function postBody(
  provider: 'groq' | 'openrouter',
  call: TranslateCall,
): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(REPLY, { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const adapter = createOpenAiCompatAdapter(adapterConfigFor(providerMeta(provider)))
  await adapter.translate('test-key', call)
  const init = fetchMock.mock.calls[0]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const baseCall: TranslateCall = {
  model: 'openai/gpt-oss-120b',
  system: 'system',
  user: 'user',
  temperature: 0.2,
  reasoningEffort: 'low',
}

describe('reasoning effort injection', () => {
  it('sends the flat reasoning_effort to Groq for a flagged model', async () => {
    const body = await postBody('groq', baseCall)
    expect(body.reasoning_effort).toBe('low')
    expect(body.reasoning).toBeUndefined()
  })

  it('sends the OpenRouter object form for a flagged route', async () => {
    const body = await postBody('openrouter', {
      ...baseCall,
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
    })
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('never sends the knob to a model the registry does not flag', async () => {
    const body = await postBody('groq', { ...baseCall, model: 'qwen/qwen3.6-27b' })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })

  it('omits the knob when the call carries no effort', async () => {
    const body = await postBody('groq', { ...baseCall, reasoningEffort: undefined })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })
})
