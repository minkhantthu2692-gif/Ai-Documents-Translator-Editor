/**
 * Selective-sync unit tests — pure functions only, no database and no network.
 *
 * The interesting cases are the two toggles that share one sheet: `settings`
 * and `providerSettings` both write to the `settings` entity, so every row has
 * to be routed by its own id rather than by the entity alone.
 */

import { describe, expect, it } from 'vitest'
import { SYNCABLE_ENTITIES, type SyncToggle } from '@/db/types'
import {
  TABLE_TO_OUTBOX,
  TABLE_TO_WIRE,
  WIRE_TO_OUTBOX,
  WIRE_TO_TABLE,
  defaultEntityToggles,
  isProviderSettingId,
  isSecretSettingId,
  settingsToggleFor,
} from './protocol'

describe('defaultEntityToggles', () => {
  it('offers a switch for every syncable entity plus the provider filter', () => {
    expect(Object.keys(defaultEntityToggles()).sort()).toEqual(
      [...SYNCABLE_ENTITIES, 'providerSettings'].sort(),
    )
  })

  it('ships with provider settings on and API keys off', () => {
    const toggles = defaultEntityToggles()
    expect(toggles.providerSettings).toBe(true)
    expect(toggles.apiKeys).toBe(false)
    expect(toggles.settings).toBe(false)
  })
})

describe('settingsToggleFor', () => {
  const providerOnly: Record<SyncToggle, boolean> = {
    ...defaultEntityToggles(),
    settings: false,
    providerSettings: true,
  }

  it('routes provider ids to the provider toggle', () => {
    expect(settingsToggleFor('ai.model.gemini', providerOnly)).toBe(true)
    expect(settingsToggleFor('ai.baseUrl.openrouter', providerOnly)).toBe(true)
    expect(settingsToggleFor('ui.language', providerOnly)).toBe(false)
    expect(settingsToggleFor('sync.entities', providerOnly)).toBe(false)
  })

  it('routes everything else to the general toggle', () => {
    const rest: Record<SyncToggle, boolean> = {
      ...providerOnly,
      providerSettings: false,
      settings: true,
    }
    expect(settingsToggleFor('ui.language', rest)).toBe(true)
    expect(settingsToggleFor('ai.model.gemini', rest)).toBe(false)
  })

  it('lets both groups travel when both switches are on', () => {
    const both: Record<SyncToggle, boolean> = { ...providerOnly, settings: true }
    expect(settingsToggleFor('ai.model.gemini', both)).toBe(true)
    expect(settingsToggleFor('ui.language', both)).toBe(true)
  })
})

describe('id classifiers', () => {
  it('recognises the provider-configuration prefix', () => {
    expect(isProviderSettingId('ai.provider')).toBe(true)
    expect(isProviderSettingId('ai.importedModels')).toBe(true)
    expect(isProviderSettingId('sync.appsScriptUrl')).toBe(false)
    expect(isProviderSettingId('ui.language')).toBe(false)
  })

  it('keeps credential-shaped setting ids out of every push', () => {
    expect(isSecretSettingId('sync.appsScriptToken')).toBe(true)
    expect(isSecretSettingId('ai.model.gemini')).toBe(false)
    expect(isSecretSettingId('ui.language')).toBe(false)
  })
})

describe('entity mapping', () => {
  it('carries apiKeys across table, wire and outbox', () => {
    expect(TABLE_TO_WIRE.apiKeys).toBe('apiKeys')
    expect(WIRE_TO_TABLE.apiKeys).toBe('apiKeys')
    expect(TABLE_TO_OUTBOX.apiKeys).toBe('apiKey')
    expect(WIRE_TO_OUTBOX.apiKeys).toBe('apiKey')
  })

  it('keeps every other mapping one-to-one', () => {
    for (const entity of SYNCABLE_ENTITIES) {
      expect(WIRE_TO_TABLE[entity]).toBeDefined()
      expect(WIRE_TO_OUTBOX[entity]).toBeDefined()
    }
  })
})
