/**
 * Settings → Available Models tab.
 *
 * IndexedDB is faked the way `KnowledgePage.test.tsx` does it (a uniquely
 * named database per test) so the settings row and the discovery cache work
 * unmocked, and no API keys are configured — which is exactly the graceful
 * path: every provider renders a no-key hint while the cached live list (if
 * any) stays importable.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { settingsRepo } from '@/db/repo-settings'
import { modelsFor, registerImportedModels } from '@/config/models.config'
import type { DiscoveryResult } from '@/providers/discovery'
import {
  IMPORTED_MODELS_KEY,
  useImportedModelsStore,
  type ImportedModelSpec,
} from '@/stores/importedModelsStore'
import { AvailableModelsTab } from './AvailableModelsTab'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function renderTab() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/settings?tab=models']}>
        <AvailableModelsTab />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('AvailableModelsTab', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-avail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    registerImportedModels([])
    useImportedModelsStore.setState({ specs: [], loaded: false })

    const bundled = modelsFor('openrouter')[0]
    const discovery: DiscoveryResult = {
      provider: 'openrouter',
      source: 'live',
      error: null,
      checkedAt: Date.now(),
      models: [
        {
          id: bundled.id,
          label: bundled.label,
          contextWindow: 262_144,
          free: true,
          usable: true,
          capabilities: ['image', 'reasoning'],
        },
        {
          id: 'acme/new-model',
          label: 'Acme New Model',
          contextWindow: 128_000,
          free: false,
          usable: true,
        },
        {
          id: 'acme/tuned-only',
          label: 'Tuned Only',
          contextWindow: null,
          free: true,
          usable: false,
        },
      ],
    }
    await settingsRepo.set('ai.models.openrouter', discovery, 'ai')
  })

  afterEach(() => {
    cleanup()
    registerImportedModels([])
    useImportedModelsStore.setState({ specs: [], loaded: false })
  })

  it('renders both lists, all four providers and the no-key hints', async () => {
    renderTab()

    expect(await screen.findByTestId('available-models-tab')).toBeInTheDocument()

    // Default list: the bundled registry, grouped and badged.
    const defaults = await screen.findByTestId('default-models')
    expect(defaults.querySelectorAll('li').length).toBeGreaterThan(5)
    expect(screen.getAllByText(label('settings.models.bundledBadge')).length).toBeGreaterThan(5)

    // Available list: four provider blocks, each degraded to "no key" here.
    await waitFor(() => {
      const groq = document.querySelector('[data-testid="models-provider-groq"]')
      expect(groq?.getAttribute('data-state')).toBe('no_key')
    })
    expect(screen.getAllByTestId(/^models-provider-/)).toHaveLength(4)
    expect((await screen.findAllByTestId('models-notice')).length).toBeGreaterThan(0)

    // The cached OpenRouter list still renders — the unusable entry does not.
    expect(await screen.findByText('Acme New Model')).toBeInTheDocument()
    expect(screen.queryByText('Tuned Only')).toBeNull()

    // A cached row that already ships bundled shows the guard, not Import.
    expect(await screen.findByText(label('settings.models.inList'))).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: label('settings.models.import') })).toHaveLength(1)

    // Provider-reported capabilities surface as chips.
    expect((await screen.findAllByTestId('model-capability')).length).toBeGreaterThan(0)
  })

  it('filters both lists by the search box', async () => {
    renderTab()
    expect(await screen.findByText('Acme New Model')).toBeInTheDocument()
    const initialBundled = screen.getByTestId('default-models').querySelectorAll('li').length

    fireEvent.change(screen.getByTestId('models-search'), {
      target: { value: 'acme' },
    })

    await waitFor(() => {
      expect(screen.getByTestId('available-models').querySelectorAll('li')).toHaveLength(1)
    })
    // Nothing in the bundled registry matches "acme" → empty-state message.
    expect(screen.getByTestId('default-models').querySelectorAll('li')).toHaveLength(0)
    expect(screen.getAllByText(label('settings.models.noMatches')).length).toBeGreaterThan(0)
    expect(initialBundled).toBeGreaterThan(5)
  })

  it('imports an available model into the shared list and can remove it again', async () => {
    renderTab()
    expect(await screen.findByText('Acme New Model')).toBeInTheDocument()

    fireEvent.click(
      (await screen.findAllByRole('button', { name: label('settings.models.import') }))[0],
    )

    // The shared registry (used by every model dropdown) now has it …
    await waitFor(() => {
      expect(modelsFor('openrouter').some((spec) => spec.id === 'acme/new-model')).toBe(true)
    })
    // … it appears in the default list with an Imported badge and a remove …
    expect(await screen.findAllByTestId('model-remove')).toHaveLength(1)
    expect(screen.getAllByText(label('settings.models.importedBadge')).length).toBeGreaterThan(0)
    // … the available row flips to the imported guard …
    expect(screen.queryByRole('button', { name: label('settings.models.import') })).toBeNull()
    // … and it is persisted in the settings row.
    expect(await settingsRepo.get<ImportedModelSpec[]>(IMPORTED_MODELS_KEY, [])).toHaveLength(1)

    fireEvent.click(screen.getAllByTestId('model-remove')[0])
    await waitFor(() => {
      expect(modelsFor('openrouter').some((spec) => spec.id === 'acme/new-model')).toBe(false)
    })
    expect(await settingsRepo.get<ImportedModelSpec[]>(IMPORTED_MODELS_KEY, [])).toHaveLength(0)
  })
})
