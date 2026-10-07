/**
 * Google Gemini adapter (AI Studio / Gemini API, `v1beta`).
 *
 * Differences from the OpenAI dialect:
 *  - auth header is `x-goog-api-key` (still a header — never a `?key=` URL, so
 *    the secret cannot leak into request logs or the history);
 *  - payloads use `contents[]` + `system_instruction`;
 *  - usage lives in `usageMetadata`, model discovery in `/models`.
 *
 * `/models` doubles as the "Test key" round trip: it needs no tokens, returns
 * the `x-ratelimit-*` headers and immediately distinguishes a dead key (401)
 * from a healthy one.
 */

import type { ProviderMeta } from '@/config/models.config'
import { DEFAULT_TIMEOUT_MS, requestJson, type HttpResponse } from './http'
import { parseRateLimitHeaders, type RateLimitInfo } from './rateLimit'
import {
  ProviderError,
  type AdapterOptions,
  type DiscoveredModel,
  type ProviderAdapter,
  type TestKeyResult,
  type TranslateCall,
  type TranslateResult,
} from './types'
import { testFailure } from './openaiCompat'

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

function modelPath(model: string): string {
  const trimmed = model.replace(/^models\//, '')
  return `models/${encodeURIComponent(trimmed)}`
}

function textFromCandidates(body: unknown): string {
  const candidates = (body as { candidates?: unknown } | null)?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return ''
  const first = candidates[0] as { content?: { parts?: unknown } }
  const parts = first?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => {
      if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .join('')
}

function usageFrom(body: unknown): GeminiUsage {
  const usage = (body as { usageMetadata?: unknown } | null)?.usageMetadata
  if (!usage || typeof usage !== 'object') return {}
  return usage as GeminiUsage
}

export function createGeminiAdapter(meta: ProviderMeta): ProviderAdapter {
  const parseRateLimit = (headers: Headers, now?: number): RateLimitInfo =>
    parseRateLimitHeaders(headers, now ?? Date.now())

  const auth = (key: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    'x-goog-api-key': key,
  })

  const get = (path: string, key: string, options?: AdapterOptions): Promise<HttpResponse> =>
    requestJson(`${meta.baseUrl}/${path}`, {
      method: 'GET',
      headers: auth(key),
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      secrets: [key],
    })

  return {
    id: meta.id,
    label: meta.label,
    parseRateLimit,

    async translate(
      key: string,
      call: TranslateCall,
      options: AdapterOptions = {},
    ): Promise<TranslateResult> {
      const response = await requestJson(
        `${meta.baseUrl}/${modelPath(call.model)}:generateContent`,
        {
          method: 'POST',
          headers: auth(key),
          body: {
            systemInstruction: { parts: [{ text: call.system }] },
            contents: [{ role: 'user', parts: [{ text: call.user }] }],
            generationConfig: {
              temperature: call.temperature,
              ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
              responseMimeType: 'application/json',
            },
          },
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          secrets: [key],
        },
      )

      const usage = usageFrom(response.body)
      return {
        text: textFromCandidates(response.body),
        tokensIn: usage.promptTokenCount ?? 0,
        tokensOut: usage.candidatesTokenCount ?? 0,
        latencyMs: response.latencyMs,
        rate: parseRateLimit(response.headers),
      }
    },

    async listModels(key: string, options: AdapterOptions = {}): Promise<DiscoveredModel[]> {
      const response = await get('models?pageSize=200', key, options)
      const models = (response.body as { models?: unknown } | null)?.models
      if (!Array.isArray(models)) return []
      return models
        .filter(
          (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
        )
        .map((entry) => {
          const name = typeof entry.name === 'string' ? entry.name : ''
          const id = name.replace(/^models\//, '')
          const methods = Array.isArray(entry.supportedGenerationMethods)
            ? (entry.supportedGenerationMethods as unknown[])
            : []
          const context = typeof entry.inputTokenLimit === 'number' ? entry.inputTokenLimit : null
          return {
            id,
            label:
              typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : id,
            contextWindow: context,
            // AI Studio keys include the free quota tier; the API does not tell
            // us which tier a key is on, so discovery reports "free capable".
            free: true,
            usable: id.length > 0 && methods.includes('generateContent'),
          }
        })
        .filter((model) => model.id.length > 0)
    },

    async testKey(key: string, options: AdapterOptions = {}): Promise<TestKeyResult> {
      const started = Date.now()
      try {
        const response = await get('models?pageSize=1', key, options)
        const models = (response.body as { models?: unknown } | null)?.models
        const count = Array.isArray(models) ? models.length : 0
        return {
          ok: true,
          kind: 'ok',
          latencyMs: Date.now() - started,
          detail: `GET /v1beta/models → ${count} model(s)`,
          rate: parseRateLimit(response.headers),
          modelsAvailable: count,
        }
      } catch (error) {
        const result = testFailure(error, Date.now() - started)
        if (error instanceof ProviderError && error.status === 404) {
          return { ...result, kind: 'invalid', detail: 'API endpoint not found (404)' }
        }
        return result
      }
    },
  }
}
