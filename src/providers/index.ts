/**
 * Provider registry — one adapter per provider, looked up by id.
 *
 * The pipeline only ever talks to `ProviderAdapter`, so adding a provider is a
 * matter of a config entry plus (at most) a new adapter implementation.
 */

import { PROVIDERS, providerMeta, type ProviderId } from '@/config/models.config'
import { createGeminiAdapter } from './gemini'
import { adapterConfigFor, createOpenAiCompatAdapter } from './openaiCompat'
import type { ProviderAdapter } from './types'

export type { ProviderAdapter, TranslateCall, TranslateResult, TestKeyResult } from './types'
export { ProviderError, RETRYABLE_KINDS } from './types'
export type { RateLimitInfo } from './rateLimit'

const registry = new Map<ProviderId, ProviderAdapter>()

for (const meta of PROVIDERS) {
  if (meta.id === 'gemini') {
    registry.set(meta.id, createGeminiAdapter(meta))
  } else {
    registry.set(meta.id, createOpenAiCompatAdapter(adapterConfigFor(meta)))
  }
}

export function getAdapter(provider: ProviderId): ProviderAdapter {
  const adapter = registry.get(provider)
  if (!adapter) throw new Error(`No adapter registered for provider: ${provider}`)
  return adapter
}

export function hasAdapter(provider: string): provider is ProviderId {
  return registry.has(provider as ProviderId)
}

/** Providers in display order (from the shared config). */
export function providerList(): typeof PROVIDERS {
  return PROVIDERS
}

export { providerMeta }
