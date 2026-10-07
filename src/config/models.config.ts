/**
 * Provider + model registry (Phase 3).
 *
 * Two sources of truth, deliberately:
 *   1. this file — bundled fallback list, used before (or instead of) live
 *      discovery, and the only place where free-tier limits are declared;
 *   2. the providers' own `/models` endpoints — live discovery marks what is
 *      actually reachable *today* (see `src/providers/discovery.ts`).
 *
 * Entries marked `verifyAvailability: true` come from the fallback list only:
 * the model may have been renamed or retired upstream, so the UI shows a
 * "verify availability" note and the runtime falls back down the chain when the
 * endpoint answers 404.
 *
 * Rate limits (rpm / rpd / tpm / tpd) are *estimates of the free tier* — live
 * response headers always win at runtime (`src/translate/rateLimiter.ts`), and
 * nothing here is ever presented as a hard guarantee.
 */

export type ProviderId = 'gemini' | 'openrouter' | 'groq' | 'openai'

export type QualityTier = 'basic' | 'standard' | 'premium'

export interface ModelSpec {
  id: string
  label: string
  provider: ProviderId
  /** Maximum context window in tokens. */
  contextWindow: number
  /** Requests per minute on the free tier (estimate). */
  rpm: number
  /** Requests per day on the free tier (estimate). */
  rpd: number
  /** Tokens per minute on the free tier (estimate). */
  tpm: number
  /** Tokens per day on the free tier (estimate); omitted = unknown. */
  tpd?: number
  qualityTier: QualityTier
  /** Usable without a paid plan (`:free` routes count as free). */
  free: boolean
  /** Strong default for PDF translation: big context + dependable JSON. */
  recommendedForPdf?: boolean
  /** Bundled fallback entry — availability is checked at runtime. */
  verifyAvailability?: boolean
  notes?: string
}

export interface ProviderMeta {
  id: ProviderId
  label: string
  /** Base URL of the chat-completions style API (OpenAI-compatible ones only). */
  baseUrl: string
  /** Where the user can mint a key. */
  getKeyUrl: string
  /** Provider documentation. */
  docsUrl: string
  /** True when the base URL is user-configurable (OpenAI-compatible). */
  customBaseUrl: boolean
  /** Explains where a free tier comes from (rendered in the provider card). */
  freeTierNote: string
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    getKeyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    customBaseUrl: false,
    freeTierNote: 'Free tier via Google AI Studio (per-minute and per-day quotas).',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    getKeyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/models?max_price=0',
    customBaseUrl: false,
    freeTierNote: 'Free models are listed with a `:free` suffix (zero prompt/completion price).',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    getKeyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/models',
    customBaseUrl: false,
    freeTierNote: 'Developer free tier with per-minute and per-day rate limits.',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/models',
    customBaseUrl: true,
    freeTierNote:
      'Custom base URL: a local server (Ollama, LM Studio, llama.cpp) or a proxy can serve models for free.',
  },
]

export const PROVIDER_IDS: ProviderId[] = PROVIDERS.map((provider) => provider.id)

export function providerMeta(id: ProviderId): ProviderMeta {
  const found = PROVIDERS.find((provider) => provider.id === id)
  if (!found) throw new Error(`Unknown provider: ${id}`)
  return found
}

/** Bundled models. Keep every provider at ≥ 6 free-tier-capable entries. */
export const MODELS: ModelSpec[] = [
  /* ------------------------------------------------------------------ */
  /* Google Gemini                                                       */
  /* ------------------------------------------------------------------ */
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 15,
    rpd: 1_500,
    tpm: 400_000,
    tpd: 1_000_000,
    qualityTier: 'standard',
    free: true,
    recommendedForPdf: true,
    verifyAvailability: true,
    notes: 'Newest flash line — verify the exact id against models.list before relying on it.',
  },
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 15,
    rpd: 1_500,
    tpm: 400_000,
    tpd: 1_000_000,
    qualityTier: 'standard',
    free: true,
    verifyAvailability: true,
    notes: 'Verify availability — ids in the 3.x flash line move quickly.',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 15,
    rpd: 1_500,
    tpm: 400_000,
    tpd: 1_000_000,
    qualityTier: 'standard',
    free: true,
    verifyAvailability: true,
    notes: 'Verify availability on models.list before selecting.',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 15,
    rpd: 1_500,
    tpm: 400_000,
    tpd: 1_000_000,
    qualityTier: 'standard',
    free: true,
    recommendedForPdf: true,
    notes: 'Stable free tier, 1M context, strong JSON discipline.',
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 30,
    rpd: 1_500,
    tpm: 400_000,
    tpd: 1_000_000,
    qualityTier: 'basic',
    free: true,
    recommendedForPdf: true,
    notes: 'Cheapest/faster sibling — good default for Basic quality.',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 5,
    rpd: 100,
    tpm: 250_000,
    tpd: 100_000,
    qualityTier: 'premium',
    free: true,
    recommendedForPdf: true,
    notes: 'Free tier exists but is small — reserve it for High quality runs.',
  },
  {
    id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 15,
    rpd: 1_500,
    tpm: 400_000,
    tpd: 1_000_000,
    qualityTier: 'standard',
    free: true,
    verifyAvailability: true,
    notes: 'Older generation — kept as a fallback when 2.5 is unavailable.',
  },
  {
    id: 'gemini-2.0-flash-lite',
    label: 'Gemini 2.0 Flash Lite',
    provider: 'gemini',
    contextWindow: 1_048_576,
    rpm: 30,
    rpd: 1_500,
    tpm: 400_000,
    tpd: 1_000_000,
    qualityTier: 'basic',
    free: true,
    verifyAvailability: true,
    notes: 'Older lite line — fallback only.',
  },
  {
    id: 'gemma-3-27b-it',
    label: 'Gemma 3 27B IT',
    provider: 'gemini',
    contextWindow: 131_072,
    rpm: 30,
    rpd: 500,
    tpm: 50_000,
    tpd: 250_000,
    qualityTier: 'basic',
    free: true,
    verifyAvailability: true,
    notes: 'Open Gemma model served through the Gemini API.',
  },

  /* ------------------------------------------------------------------ */
  /* Groq                                                                */
  /* ------------------------------------------------------------------ */
  {
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B Versatile',
    provider: 'groq',
    contextWindow: 131_072,
    rpm: 30,
    rpd: 14_400,
    tpm: 12_000,
    tpd: 500_000,
    qualityTier: 'standard',
    free: true,
    recommendedForPdf: true,
    notes: 'Workhorse: fast, cheap free tier, dependable structured output.',
  },
  {
    id: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant',
    provider: 'groq',
    contextWindow: 131_072,
    rpm: 30,
    rpd: 14_400,
    tpm: 12_000,
    tpd: 500_000,
    qualityTier: 'basic',
    free: true,
    notes: 'Fastest option — Basic quality only.',
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    provider: 'groq',
    contextWindow: 131_072,
    rpm: 30,
    rpd: 14_400,
    tpm: 12_000,
    tpd: 500_000,
    qualityTier: 'premium',
    free: true,
    recommendedForPdf: true,
    notes: 'Open-weight large model on Groq — good review-pass candidate.',
  },
  {
    id: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B',
    provider: 'groq',
    contextWindow: 131_072,
    rpm: 30,
    rpd: 14_400,
    tpm: 12_000,
    tpd: 500_000,
    qualityTier: 'basic',
    free: true,
    notes: 'Small open-weight model — cheap single-pass translation.',
  },
  {
    id: 'meta-llama/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout 17B (16E)',
    provider: 'groq',
    contextWindow: 131_072,
    rpm: 30,
    rpd: 14_400,
    tpm: 12_000,
    tpd: 500_000,
    qualityTier: 'standard',
    free: true,
    verifyAvailability: true,
    notes: 'Mixture-of-experts scout — verify the id on the Groq models page.',
  },
  {
    id: 'qwen/qwen3-32b',
    label: 'Qwen3 32B',
    provider: 'groq',
    contextWindow: 131_072,
    rpm: 30,
    rpd: 14_400,
    tpm: 12_000,
    tpd: 500_000,
    qualityTier: 'standard',
    free: true,
    verifyAvailability: true,
    notes: 'Strong multilingual model — verify availability before relying on it.',
  },

  /* ------------------------------------------------------------------ */
  /* OpenRouter (free pool)                                              */
  /* ------------------------------------------------------------------ */
  {
    id: 'deepseek/deepseek-chat-v3.1:free',
    label: 'DeepSeek Chat V3.1 (free)',
    provider: 'openrouter',
    contextWindow: 163_840,
    rpm: 20,
    rpd: 200,
    tpm: 40_000,
    tpd: 200_000,
    qualityTier: 'standard',
    free: true,
    recommendedForPdf: true,
    notes: 'Large free pool with a long context — solid default on OpenRouter.',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    label: 'Llama 3.3 70B Instruct (free)',
    provider: 'openrouter',
    contextWindow: 131_072,
    rpm: 20,
    rpd: 200,
    tpm: 40_000,
    tpd: 200_000,
    qualityTier: 'standard',
    free: true,
    notes: 'Free route of the 70B workhorse.',
  },
  {
    id: 'qwen/qwen3-235b-a22b:free',
    label: 'Qwen3 235B A22B (free)',
    provider: 'openrouter',
    contextWindow: 131_072,
    rpm: 20,
    rpd: 200,
    tpm: 40_000,
    tpd: 200_000,
    qualityTier: 'premium',
    free: true,
    recommendedForPdf: true,
    verifyAvailability: true,
    notes: 'Very large free model — check that the route still exists.',
  },
  {
    id: 'google/gemma-3-27b-it:free',
    label: 'Gemma 3 27B IT (free)',
    provider: 'openrouter',
    contextWindow: 131_072,
    rpm: 20,
    rpd: 200,
    tpm: 40_000,
    tpd: 200_000,
    qualityTier: 'basic',
    free: true,
    notes: 'Free open model — Basic quality.',
  },
  {
    id: 'mistralai/mistral-small-3.2-24b-instruct:free',
    label: 'Mistral Small 3.2 24B (free)',
    provider: 'openrouter',
    contextWindow: 131_072,
    rpm: 20,
    rpd: 200,
    tpm: 40_000,
    tpd: 200_000,
    qualityTier: 'standard',
    free: true,
    verifyAvailability: true,
    notes: 'Efficient European model on the free route — verify it is up.',
  },
  {
    id: 'openai/gpt-oss-20b:free',
    label: 'GPT-OSS 20B (free)',
    provider: 'openrouter',
    contextWindow: 131_072,
    rpm: 20,
    rpd: 200,
    tpm: 40_000,
    tpd: 200_000,
    qualityTier: 'basic',
    free: true,
    notes: 'Free route of the small open-weight model.',
  },

  /* ------------------------------------------------------------------ */
  /* OpenAI-compatible (custom base URL)                                 */
  /* ------------------------------------------------------------------ */
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    provider: 'openai',
    contextWindow: 128_000,
    rpm: 500,
    rpd: 10_000,
    tpm: 200_000,
    qualityTier: 'standard',
    free: true,
    recommendedForPdf: true,
    notes: 'Free only when the base URL points at a local or self-hosted endpoint.',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    rpm: 500,
    rpd: 10_000,
    tpm: 200_000,
    qualityTier: 'premium',
    free: true,
    notes: 'Free only via a local/self-hosted endpoint; paid on api.openai.com.',
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    provider: 'openai',
    contextWindow: 1_048_576,
    rpm: 500,
    rpd: 10_000,
    tpm: 200_000,
    qualityTier: 'standard',
    free: true,
    recommendedForPdf: true,
    notes: '1M context — free only via a local/self-hosted endpoint.',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    provider: 'openai',
    contextWindow: 1_048_576,
    rpm: 500,
    rpd: 10_000,
    tpm: 200_000,
    qualityTier: 'premium',
    free: true,
    notes: 'Free only via a local/self-hosted endpoint.',
  },
  {
    id: 'gpt-4-turbo',
    label: 'GPT-4 Turbo',
    provider: 'openai',
    contextWindow: 128_000,
    rpm: 500,
    rpd: 10_000,
    tpm: 200_000,
    qualityTier: 'premium',
    free: true,
    verifyAvailability: true,
    notes: 'Older flagship — kept as a fallback; verify on your endpoint.',
  },
  {
    id: 'gpt-3.5-turbo',
    label: 'GPT-3.5 Turbo',
    provider: 'openai',
    contextWindow: 16_385,
    rpm: 500,
    rpd: 10_000,
    tpm: 200_000,
    qualityTier: 'basic',
    free: true,
    verifyAvailability: true,
    notes: 'Small context — only useful for short pages on local endpoints.',
  },
]

/**
 * Ordered fallback chain per provider: tried when the selected model answers
 * 404 / is missing from live discovery. Every entry is free-tier capable.
 */
export const FALLBACK_CHAINS: Record<ProviderId, string[]> = {
  gemini: [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-2.0-flash',
    'gemma-3-27b-it',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-20b',
    'qwen/qwen3-32b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
  ],
  openrouter: [
    'deepseek/deepseek-chat-v3.1:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'qwen/qwen3-235b-a22b:free',
    'mistralai/mistral-small-3.2-24b-instruct:free',
    'google/gemma-3-27b-it:free',
    'openai/gpt-oss-20b:free',
  ],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-3.5-turbo'],
}

/** Models of one provider, recommended entries first. */
export function modelsFor(provider: ProviderId): ModelSpec[] {
  return MODELS.filter((model) => model.provider === provider).sort(
    (a, b) =>
      Number(Boolean(b.recommendedForPdf)) - Number(Boolean(a.recommendedForPdf)) ||
      rankTier(a.qualityTier) - rankTier(b.qualityTier),
  )
}

function rankTier(tier: QualityTier): number {
  return tier === 'basic' ? 0 : tier === 'standard' ? 1 : 2
}

/** Exact spec for a model id (fallback list lookup). */
export function modelSpec(provider: ProviderId, model: string): ModelSpec | undefined {
  return MODELS.find((entry) => entry.provider === provider && entry.id === model)
}

/**
 * Free-tier budget handed to the pre-flight quota check. `maxTokens` stays 0
 * when the daily token allowance is unknown, which makes the quota check
 * report PENDING instead of inventing a limit.
 */
export function freeTierLimits(
  provider: ProviderId,
  model: string,
): {
  maxRequests: number
  maxTokens: number
} {
  const spec = modelSpec(provider, model)
  if (!spec) return { maxRequests: 0, maxTokens: 0 }
  return { maxRequests: spec.rpd, maxTokens: spec.tpd ?? 0 }
}

/** Default model for a provider (first entry of its fallback chain). */
export function defaultModelFor(provider: ProviderId): string {
  return FALLBACK_CHAINS[provider][0]
}
