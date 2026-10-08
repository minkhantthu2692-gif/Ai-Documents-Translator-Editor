/**
 * Provider adapter contract.
 *
 * Four adapters (Gemini, OpenRouter, Groq, OpenAI-compatible) implement it, so
 * the translation pipeline only ever sees `translate` / `listModels` /
 * `testKey` / `parseRateLimit`.
 *
 * Security rules enforced by every implementation:
 *  - the secret travels in a header, never in the URL and never in a log line;
 *  - error messages are built from status + provider text with the key
 *    stripped out (`redactSecret` in `http.ts`);
 *  - responses are read at most once and the body is not echoed anywhere.
 */

import type { ProviderId } from '@/config/models.config'
import type { RateLimitInfo } from './rateLimit'

export interface TranslateCall {
  model: string
  /** System prompt for this quality level (already contains the glossary). */
  system: string
  /** User message carrying the numbered lines. */
  user: string
  temperature: number
  /** Upper bound for the completion (protects the free tier). */
  maxOutputTokens?: number
}

export interface TranslateResult {
  /** Raw assistant text (validated downstream). */
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  rate: RateLimitInfo
}

export type ProviderErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'bad_request'
  | 'model_missing'
  | 'network'
  | 'timeout'
  | 'unknown'

/** HTTP statuses that are worth retrying (possibly on another key/model). */
export const RETRYABLE_KINDS: readonly ProviderErrorKind[] = [
  'rate_limit',
  'quota',
  'server',
  'network',
  'timeout',
]

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly status: number | null
  readonly retryAfterMs: number | null
  readonly rate: RateLimitInfo | null

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: {
      status?: number | null
      retryAfterMs?: number | null
      rate?: RateLimitInfo | null
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.kind = kind
    this.status = options.status ?? null
    this.retryAfterMs = options.retryAfterMs ?? null
    this.rate = options.rate ?? null
  }
}

export interface DiscoveredModel {
  id: string
  label: string
  contextWindow: number | null
  /** Zero prompt *and* completion price (OpenRouter `:free` routes). */
  free: boolean
  /** The endpoint says this model can generate content (Gemini filter). */
  usable: boolean
  /**
   * Provider-reported abilities when the API exposes them — OpenRouter's
   * input modalities and `supported_parameters` (reasoning/tools). Absent
   * means the endpoint told us nothing, not that the model lacks them.
   */
  capabilities?: string[]
}

export type TestKind =
  'ok' | 'invalid' | 'quota' | 'rate_limit' | 'server' | 'network' | 'unsupported'

export interface TestKeyResult {
  ok: boolean
  kind: TestKind
  latencyMs: number
  /** Human-readable technical detail (never contains the key). */
  detail: string
  rate: RateLimitInfo | null
  /** Number of models the key can see (discovery result). */
  modelsAvailable: number | null
}

export interface AdapterOptions {
  signal?: AbortSignal
  /** Overrides the configured base URL (OpenAI-compatible custom endpoints). */
  baseUrl?: string
  /** Timeout in ms; defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number
}

export interface ProviderAdapter {
  id: ProviderId
  label: string
  /** One chat completion. The key is sent as a header only. */
  translate(key: string, call: TranslateCall, options?: AdapterOptions): Promise<TranslateResult>
  /** Live model discovery (already filtered to usable/free entries). */
  listModels(key: string, options?: AdapterOptions): Promise<DiscoveredModel[]>
  /** Cheap round trip used by the "Test key" button. */
  testKey(key: string, options?: AdapterOptions): Promise<TestKeyResult>
  /** Provider-specific rate-limit header interpretation. */
  parseRateLimit(headers: Headers, now?: number): RateLimitInfo
}
