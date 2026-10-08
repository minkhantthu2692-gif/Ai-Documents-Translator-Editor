/**
 * Status-code classification.
 *
 * The interesting case is 429: every provider uses it for *both* a burst and a
 * spent daily allowance, and telling them apart is what decides whether a key
 * backs off for four seconds or parks for the hour. Getting that wrong was how
 * a document that needed more requests than the daily allowance ended up
 * failing with `ALL_KEYS_COOLING_DOWN` after thirty retries instead of
 * stopping cleanly with `QUOTA_EXHAUSTED` and resuming the next day.
 *
 * These fixtures are the real bodies the four supported providers return,
 * abridged to the part that carries the signal.
 */
import { describe, expect, it } from 'vitest'
import { statusToKind } from './http'

describe('statusToKind — 429 tells two different stories', () => {
  const BURSTS: Array<[string, string]> = [
    [
      'Gemini: requests per minute',
      `Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent requests per minute' of project 'x' on consumer pool 'y'.`,
    ],
    [
      'Groq: requests per minute',
      `Rate limit reached for model 'llama-3.3-70b-versatile' on requests per minute. Please try again in 4s.`,
    ],
    ['Groq: too many requests', 'Too Many Requests: you have reached the rate limit.'],
    [
      'OpenRouter: free models per minute',
      'Rate limit reached: free-models-per-minute. Please try again shortly.',
    ],
  ]

  it.each(BURSTS)('%s stays a burst (short backoff)', (_name, body) => {
    expect(statusToKind(429, body)).toBe('rate_limit')
  })

  const QUOTAS: Array<[string, string]> = [
    [
      'Gemini: input tokens per day',
      `Quota exceeded for quota metric 'Generate Content API input tokens per day' and limit 'GenerateContent input tokens per day' of project 'x'.`,
    ],
    [
      'Gemini: RESOURCE_EXHAUSTED without detail',
      'RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).',
    ],
    [
      'OpenAI: insufficient_quota',
      `You exceeded your current quota, please check your plan and billing details.`,
    ],
    ['Groq: free tier daily limit', 'Free tier daily limit reached. Please try again later.'],
    [
      'OpenRouter: free models per day',
      'Rate limit reached: free-models-per-day. Please try again later.',
    ],
  ]

  it.each(QUOTAS)('%s is a spent allowance (quota cooldown)', (_name, body) => {
    expect(statusToKind(429, body)).toBe('quota')
  })

  it('treats a bare 429 with no body as a burst', () => {
    expect(statusToKind(429, '')).toBe('rate_limit')
  })

  it('prefers the daily reading when a body mentions both windows', () => {
    expect(statusToKind(429, 'Quota exceeded per day. Rate limit reached, try again in 1h.')).toBe(
      'quota',
    )
  })
})

describe('statusToKind — the other statuses are unchanged', () => {
  it('maps authentication and routing failures', () => {
    expect(statusToKind(401, 'Incorrect API key provided')).toBe('unauthorized')
    expect(statusToKind(403, 'Permission denied')).toBe('forbidden')
    expect(statusToKind(404, 'The model `x` does not exist')).toBe('model_missing')
  })

  it('maps request and server failures regardless of body text', () => {
    expect(statusToKind(400, 'quota')).toBe('bad_request')
    expect(statusToKind(422, 'invalid schema')).toBe('bad_request')
    expect(statusToKind(408, 'timeout')).toBe('server')
    expect(statusToKind(500, 'quota')).toBe('server')
    expect(statusToKind(503, 'overloaded')).toBe('server')
    expect(statusToKind(418, 'teapot')).toBe('unknown')
  })

  it('only classifies 429 as quota when the body says so', () => {
    expect(statusToKind(500, 'RESOURCE_EXHAUSTED')).toBe('server')
    expect(statusToKind(404, 'quota exceeded')).toBe('model_missing')
  })
})
