/**
 * Imported-models store: import/remove round-trips through the settings row,
 * the merged `modelsFor()` view picks imports up immediately, and the quota
 * inputs stay honest — an imported id has *unknown* limits (PENDING, the
 * rate limiter's defaults) instead of invented numbers, while bundled ids can
 * never be shadowed or duplicated.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, setDb } from '@/db/db'
import { settingsRepo } from '@/db/repo-settings'
import {
  freeTierLimits,
  importedModelSpecs,
  isBundledModel,
  isKnownModel,
  modelSpec,
  modelsFor,
  registerImportedModels,
} from '@/config/models.config'
import {
  IMPORTED_MODELS_KEY,
  useImportedModelsStore,
  type ImportedModelSpec,
} from '@/stores/importedModelsStore'

const store = () => useImportedModelsStore.getState()

function resetRegistry(): void {
  registerImportedModels([])
  useImportedModelsStore.setState({ specs: [], loaded: false })
}

describe('importedModelsStore', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    resetRegistry()
  })

  afterEach(() => {
    resetRegistry()
  })

  it('imports a model, merges it into modelsFor and persists the row', async () => {
    const added = await store().importModel({
      provider: 'openrouter',
      id: 'acme/new-model',
      label: 'Acme New Model',
      contextWindow: 128_000,
      free: false,
    })

    expect(added).toBe(true)
    expect(isKnownModel('openrouter', 'acme/new-model')).toBe(true)
    expect(modelsFor('openrouter').some((spec) => spec.id === 'acme/new-model')).toBe(true)

    const persisted = await settingsRepo.get<ImportedModelSpec[]>(IMPORTED_MODELS_KEY, [])
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ id: 'acme/new-model', provider: 'openrouter' })

    // A cold load re-registers exactly the same set (idempotent).
    resetRegistry()
    await store().ensureLoaded()
    expect(store().loaded).toBe(true)
    expect(isKnownModel('openrouter', 'acme/new-model')).toBe(true)
    expect(importedModelSpecs()).toHaveLength(1)
  })

  it('refuses bundled ids, duplicates, and shadows in register()', async () => {
    const bundled = modelsFor('groq')[0]

    const addedBundled = await store().importModel({
      provider: 'groq',
      id: bundled.id,
      label: 'Shadowed name',
      contextWindow: 1,
      free: true,
    })
    expect(addedBundled).toBe(false)
    expect(isBundledModel('groq', bundled.id)).toBe(true)

    const first = await store().importModel({
      provider: 'groq',
      id: 'acme/only-once',
      label: 'Only Once',
      contextWindow: null,
      free: true,
    })
    const again = await store().importModel({
      provider: 'groq',
      id: 'acme/only-once',
      label: 'Only Once (renamed)',
      contextWindow: null,
      free: true,
    })
    expect([first, again]).toEqual([true, false])
    expect(store().specs.filter((spec) => spec.id === 'acme/only-once')).toHaveLength(1)

    // register() itself drops anything that collides with a bundled id.
    registerImportedModels([modelsFor('groq')[1], { ...modelsFor('groq')[1], id: 'acme/foreign' }])
    expect(importedModelSpecs().map((spec) => spec.id)).toEqual(['acme/foreign'])
    registerImportedModels([])
  })

  it('keeps imported ids invisible to the quota gate (limits unknown)', async () => {
    await store().importModel({
      provider: 'groq',
      id: 'acme/future-model',
      label: 'Future Model',
      contextWindow: null,
      free: true,
    })

    // Unknown id → PENDING semantics, no invented daily budget …
    expect(freeTierLimits('groq', 'acme/future-model')).toEqual({
      maxRequests: 0,
      maxTokens: 0,
    })
    // … and no spec for the rate limiter to misread as a real limit.
    expect(modelSpec('groq', 'acme/future-model')).toBeUndefined()

    // A bundled id keeps its real numbers.
    const bundled = modelsFor('groq')[0]
    const limits = freeTierLimits('groq', bundled.id)
    expect(limits.maxRequests).toBeGreaterThan(0)
  })

  it('removes imported models from the view and the persisted row', async () => {
    await store().importModel({
      provider: 'openrouter',
      id: 'acme/new-model',
      label: 'Acme New Model',
      contextWindow: 128_000,
      free: false,
    })

    await store().removeModel('openrouter', 'acme/new-model')
    expect(isKnownModel('openrouter', 'acme/new-model')).toBe(false)
    expect(await settingsRepo.get<ImportedModelSpec[]>(IMPORTED_MODELS_KEY, [])).toHaveLength(0)

    // Removing something that was never imported is a no-op.
    await store().removeModel('openrouter', 'never/imported')
    expect(store().specs).toHaveLength(0)
  })
})
