/**
 * Model discovery.
 *
 * Live discovery first — the provider's own `/models` endpoint says what is
 * reachable today, which is the only way to honour "free" and "available"
 * honestly. The bundled fallback list (`src/config/models.config.ts`) is used
 * when discovery fails (offline, no key yet, endpoint down) and is always
 * merged in so a user can still pick a known id.
 *
 * Results are cached in the `settings` table per provider so the dropdown is
 * instant on the next visit; "Refresh models" re-runs discovery.
 */

import type { DiscoveredModel } from './types'
import { getAdapter } from './index'
import { settingsRepo } from '@/db/repo-settings'
import {
  MODELS,
  modelsFor,
  type ModelSpec,
  type ProviderId,
  type QualityTier,
} from '@/config/models.config'

export type ModelAvailability = 'yes' | 'unknown' | 'no'

export interface ModelOption {
  id: string
  label: string
  provider: ProviderId
  free: boolean
  contextWindow: number | null
  recommendedForPdf: boolean
  /** Bundled-only entry: confirm it still exists upstream. */
  verifyAvailability: boolean
  qualityTier: QualityTier | null
  available: ModelAvailability
  source: 'live' | 'fallback'
}

export interface DiscoveryResult {
  provider: ProviderId
  models: DiscoveredModel[]
  source: 'live' | 'fallback'
  error: string | null
  checkedAt: number
}

const cacheKey = (provider: ProviderId): string => `ai.models.${provider}`
/** Discovery results older than this are refreshed on the next open. */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000

export async function loadCachedDiscovery(provider: ProviderId): Promise<DiscoveryResult | null> {
  const cached = await settingsRepo.get<DiscoveryResult | null>(cacheKey(provider), null)
  if (!cached || !Array.isArray(cached.models)) return null
  return cached
}

export async function saveDiscovery(result: DiscoveryResult): Promise<void> {
  await settingsRepo.set(cacheKey(result.provider), result, 'ai')
}

/**
 * Asks the provider for its model list. Never throws: a failure degrades to a
 * `source: 'fallback'` result so the UI can still render a dropdown.
 */
export async function discoverModels(
  provider: ProviderId,
  key: string | null,
  options: { signal?: AbortSignal; baseUrl?: string } = {},
): Promise<DiscoveryResult> {
  const now = Date.now()
  if (!key) {
    return { provider, models: [], source: 'fallback', error: 'NO_KEY', checkedAt: now }
  }
  try {
    const models = await getAdapter(provider).listModels(key, {
      signal: options.signal,
      baseUrl: options.baseUrl,
    })
    return { provider, models, source: 'live', error: null, checkedAt: now }
  } catch (error) {
    return {
      provider,
      models: [],
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error),
      checkedAt: now,
    }
  }
}

function bundledSpecs(provider: ProviderId): ModelSpec[] {
  return modelsFor(provider)
}

/**
 * Merges live discovery with the bundled list.
 *
 *  - a model present in both → live wins (availability known, context window
 *    from the provider);
 *  - a bundled model missing from a *successful* discovery → `available: 'no'`;
 *  - when discovery failed → everything is `available: 'unknown'`.
 */
export function buildModelOptions(
  provider: ProviderId,
  discovery: DiscoveryResult | null,
): ModelOption[] {
  const bundled = bundledSpecs(provider)
  const liveById = new Map<string, DiscoveredModel>()
  for (const model of discovery?.models ?? []) liveById.set(model.id, model)

  const discoveryRan = discovery !== null && discovery.source === 'live'
  const options: ModelOption[] = []

  for (const spec of bundled) {
    const live = liveById.get(spec.id)
    liveById.delete(spec.id)
    options.push({
      id: spec.id,
      label: spec.label,
      provider,
      free: live ? live.free || spec.free : spec.free,
      contextWindow: live?.contextWindow ?? spec.contextWindow,
      recommendedForPdf: Boolean(spec.recommendedForPdf),
      verifyAvailability: Boolean(spec.verifyAvailability) && !live,
      qualityTier: spec.qualityTier,
      available: live ? 'yes' : discoveryRan ? 'no' : 'unknown',
      source: live ? 'live' : 'fallback',
    })
  }

  // Models the provider knows but our fallback list does not (new releases).
  for (const live of liveById.values()) {
    if (!live.usable) continue
    options.push({
      id: live.id,
      label: live.label || live.id,
      provider,
      free: live.free,
      contextWindow: live.contextWindow,
      recommendedForPdf: false,
      verifyAvailability: false,
      qualityTier: null,
      available: 'yes',
      source: 'live',
    })
  }

  return options
}

/** Every model id bundled for a provider (used by tests and validation). */
export function bundledModelIds(provider: ProviderId): string[] {
  return MODELS.filter((model) => model.provider === provider).map((model) => model.id)
}
