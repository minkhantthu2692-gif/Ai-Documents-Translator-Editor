/**
 * Imported models — the ids a user pulled in from a provider's live list
 * (Settings → Available Models) and wants offered in the model dropdowns.
 *
 * Persisted as one `settings` row (`ai.importedModels`, group `ai`) so it
 * travels with backup/export and cloud sync like every other setting. Every
 * mutation re-registers the in-memory set in `models.config`, which is what
 * `modelsFor()` merges — so the translate page, the project wizard and the
 * AI Providers card all see imports without any extra wiring.
 *
 * `ensureLoaded()` is idempotent and shares one in-flight read: the
 * Translate page awaits it before the stale-config heal, so an imported id
 * can never be wiped by the heal racing the first load.
 */

import { create } from 'zustand'
import { settingsRepo } from '@/db/repo-settings'
import {
  isBundledModel,
  registerImportedModels,
  type ModelSpec,
  type ProviderId,
} from '@/config/models.config'

export const IMPORTED_MODELS_KEY = 'ai.importedModels'

/** A bundled-shaped spec plus when it was imported (shown in the tab). */
export interface ImportedModelSpec extends ModelSpec {
  importedAt: number
}

export interface ImportModelInput {
  provider: ProviderId
  id: string
  label: string
  contextWindow: number | null
  free: boolean
}

interface ImportedModelsState {
  specs: ImportedModelSpec[]
  loaded: boolean
  /** Reads the persisted set once (shared promise across callers). */
  ensureLoaded: () => Promise<void>
  /** Persists + registers a new model. False when already in the list. */
  importModel: (input: ImportModelInput) => Promise<boolean>
  /** Persists + unregisters an imported model. */
  removeModel: (provider: ProviderId, id: string) => Promise<void>
}

let inflight: Promise<void> | null = null

function apply(specs: ImportedModelSpec[]): void {
  registerImportedModels(specs)
}

export const useImportedModelsStore = create<ImportedModelsState>((set, get) => ({
  specs: [],
  loaded: false,

  ensureLoaded: async () => {
    if (get().loaded) return
    if (!inflight) {
      inflight = settingsRepo
        .get<ImportedModelSpec[]>(IMPORTED_MODELS_KEY, [])
        .then((stored) => {
          const specs = Array.isArray(stored) ? stored : []
          apply(specs)
          set({ specs, loaded: true })
        })
        .finally(() => {
          inflight = null
        })
    }
    await inflight
  },

  importModel: async (input) => {
    await get().ensureLoaded()
    const key = `${input.provider}/${input.id}`
    const already = get().specs.some((spec) => `${spec.provider}/${spec.id}` === key)
    // The bundled list wins: its specs carry the limits and labels we trust.
    if (already || isBundledModel(input.provider, input.id)) return false

    const spec: ImportedModelSpec = {
      id: input.id,
      label: input.label.trim() || input.id,
      provider: input.provider,
      contextWindow: input.contextWindow ?? 0,
      // Placeholder shape for `ModelSpec` only — `modelSpec()` never returns
      // imported entries, so these numbers never reach the quota gate or the
      // rate limiter (both treat the id as "limits unknown").
      rpm: 30,
      rpd: 1_000,
      tpm: 100_000,
      qualityTier: 'standard',
      free: input.free,
      notes: 'Imported from the provider’s live model list.',
      importedAt: Date.now(),
    }
    const specs = [...get().specs, spec]
    apply(specs)
    set({ specs })
    await settingsRepo.set(IMPORTED_MODELS_KEY, specs, 'ai')
    return true
  },

  removeModel: async (provider, id) => {
    await get().ensureLoaded()
    const specs = get().specs.filter((spec) => !(spec.provider === provider && spec.id === id))
    if (specs.length === get().specs.length) return
    apply(specs)
    set({ specs })
    await settingsRepo.set(IMPORTED_MODELS_KEY, specs, 'ai')
  },
}))
