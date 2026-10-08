/**
 * OpenAI-compatible adapter factory.
 *
 * Groq, OpenRouter and any self-hosted endpoint (Ollama, LM Studio, llama.cpp,
 * vLLM …) speak the same `/chat/completions` + `/models` dialect, so they share
 * one implementation configured per provider: base URL, auth header, model-list
 * parsing and free-tier detection.
 *
 * The secret is sent as `Authorization: Bearer <key>` — it never appears in the
 * URL, and every error string passes through `redactSecret` first.
 */

import type { ProviderId, ProviderMeta } from '@/config/models.config'
import { DEFAULT_TIMEOUT_MS, requestJson, textFromChatBody, usageOf } from './http'
import { emptyRateLimit, parseRateLimitHeaders, type RateLimitInfo } from './rateLimit'
import {
  ProviderError,
  type AdapterOptions,
  type DiscoveredModel,
  type ProviderAdapter,
  type TestKeyResult,
  type TranslateCall,
  type TranslateResult,
} from './types'

export interface OpenAiCompatConfig {
  id: ProviderId
  label: string
  defaultBaseUrl: string
  /** Extra headers some providers require (never authentication). */
  extraHeaders?: (baseUrl: string) => Record<string, string>
  /** Provider-specific interpretation of the `/models` payload. */
  parseModels: (body: unknown, baseUrl: string) => DiscoveredModel[]
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Local endpoints (`http://localhost:11434`) serve models for free. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  } catch {
    return false
  }
}

function baseUrlFor(config: OpenAiCompatConfig, options?: AdapterOptions): string {
  return trimSlash(options?.baseUrl?.trim() || config.defaultBaseUrl)
}

function authHeaders(key: string, extra: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extra }
}

function modelsFromOpenAiList(body: unknown, baseUrl: string): DiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const local = isLocalEndpoint(baseUrl)
  return data
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
    )
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : ''
      const context =
        typeof entry.context_length === 'number'
          ? entry.context_length
          : typeof entry.context_window === 'number'
            ? entry.context_window
            : null
      return {
        id,
        label: typeof entry.owned_by === 'string' && entry.owned_by ? `${id}` : id,
        contextWindow: context,
        free: local,
        usable: id.length > 0,
      }
    })
    .filter((model) => model.id.length > 0)
}

/** Abilities OpenRouter reports per model: input modalities + key parameters. */
function capabilitiesOfOpenRouter(entry: Record<string, unknown>): string[] | undefined {
  const architecture = entry.architecture as Record<string, unknown> | undefined
  const modalities = Array.isArray(architecture?.input_modalities)
    ? architecture.input_modalities
    : []
  const supported = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
  const has = (name: string) => supported.some((value) => value === name)
  const capabilities = [
    ...modalities.filter((value): value is string => typeof value === 'string' && value !== 'text'),
    ...(has('reasoning') ? ['reasoning'] : []),
    ...(has('tools') ? ['tools'] : []),
  ]
  return capabilities.length > 0 ? capabilities : undefined
}

function modelsFromOpenRouter(body: unknown): DiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  return data
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
    )
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : ''
      const pricing = entry.pricing as Record<string, unknown> | undefined
      const prompt = Number(pricing?.prompt ?? NaN)
      const completion = Number(pricing?.completion ?? NaN)
      const free = prompt === 0 && completion === 0
      const context = typeof entry.context_length === 'number' ? entry.context_length : null
      return {
        id,
        label: typeof entry.name === 'string' && entry.name ? entry.name : id,
        contextWindow: context,
        free,
        usable: id.length > 0,
        capabilities: capabilitiesOfOpenRouter(entry),
      }
    })
    .filter((model) => model.id.length > 0)
}

/** Groq tags free-tier models through the `data[].owned_by`/fee fields. */
function modelsFromGroq(body: unknown, baseUrl: string): DiscoveredModel[] {
  return modelsFromOpenAiList(body, baseUrl).map((model) => ({ ...model, free: true }))
}

export const GROQ_MODELS_PARSE = modelsFromGroq
export const OPENROUTER_MODELS_PARSE = modelsFromOpenRouter
export const OPENAI_MODELS_PARSE = modelsFromOpenAiList

export function createOpenAiCompatAdapter(config: OpenAiCompatConfig): ProviderAdapter {
  const parseRateLimit = (headers: Headers, now?: number): RateLimitInfo =>
    parseRateLimitHeaders(headers, now ?? Date.now())

  return {
    id: config.id,
    label: config.label,
    parseRateLimit,

    async translate(
      key: string,
      call: TranslateCall,
      options: AdapterOptions = {},
    ): Promise<TranslateResult> {
      const base = baseUrlFor(config, options)
      const extra = config.extraHeaders?.(base) ?? {}
      const response = await requestJson(`${base}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(key, extra),
        body: {
          model: call.model,
          messages: [
            { role: 'system', content: call.system },
            { role: 'user', content: call.user },
          ],
          temperature: call.temperature,
          ...(call.maxOutputTokens ? { max_tokens: call.maxOutputTokens } : {}),
          stream: false,
        },
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        secrets: [key],
      })

      const text = textFromChatBody(response.body)
      const usage = usageOf(response.body)
      return {
        text,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        latencyMs: response.latencyMs,
        rate: parseRateLimit(response.headers),
      }
    },

    async listModels(key: string, options: AdapterOptions = {}): Promise<DiscoveredModel[]> {
      const base = baseUrlFor(config, options)
      const response = await requestJson(`${base}/models`, {
        method: 'GET',
        headers: authHeaders(key, config.extraHeaders?.(base) ?? {}),
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        secrets: [key],
      })
      return config.parseModels(response.body, base)
    },

    async testKey(key: string, options: AdapterOptions = {}): Promise<TestKeyResult> {
      const started = Date.now()
      try {
        const models = await this.listModels(key, options)
        return {
          ok: true,
          kind: 'ok',
          latencyMs: Date.now() - started,
          detail: `GET /models → ${models.length} models`,
          rate: emptyRateLimit(),
          modelsAvailable: models.length,
        }
      } catch (error) {
        return testFailure(error, Date.now() - started)
      }
    },
  }
}

/** Maps a thrown provider error onto the "Test key" result shape. */
export function testFailure(error: unknown, latencyMs: number): TestKeyResult {
  if (error instanceof ProviderError) {
    const kind =
      error.kind === 'unauthorized' || error.kind === 'forbidden'
        ? 'invalid'
        : error.kind === 'quota'
          ? 'quota'
          : error.kind === 'rate_limit'
            ? 'rate_limit'
            : error.kind === 'server' || error.kind === 'bad_request'
              ? 'server'
              : error.kind === 'network' || error.kind === 'timeout'
                ? 'network'
                : 'server'
    return {
      ok: false,
      kind,
      latencyMs,
      detail: error.message,
      rate: error.rate,
      modelsAvailable: null,
    }
  }
  return {
    ok: false,
    kind: 'network',
    latencyMs,
    detail: error instanceof Error ? error.message : String(error),
    rate: null,
    modelsAvailable: null,
  }
}

/** Builds the OpenRouter/Groq/OpenAI entries from the shared provider meta. */
export function adapterConfigFor(meta: ProviderMeta): OpenAiCompatConfig {
  if (meta.id === 'openrouter') {
    return {
      id: meta.id,
      label: meta.label,
      defaultBaseUrl: meta.baseUrl,
      parseModels: (body) => modelsFromOpenRouter(body),
    }
  }
  if (meta.id === 'groq') {
    return {
      id: meta.id,
      label: meta.label,
      defaultBaseUrl: meta.baseUrl,
      parseModels: (body, base) => modelsFromGroq(body, base),
    }
  }
  return {
    id: meta.id,
    label: meta.label,
    defaultBaseUrl: meta.baseUrl,
    parseModels: (body, base) => modelsFromOpenAiList(body, base),
  }
}
