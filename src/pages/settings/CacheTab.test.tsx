/**
 * Settings → Cache tab, factory-reset guards (feature: a reset button that
 * restores the whole web app, behind a warning so it cannot be hit by
 * accident). The final confirm is never clicked here — that path is covered
 * by the `resetEverything` unit below, which asserts the storage half of the
 * wipe without touching jsdom's reload.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, resetEverything, setDb } from '@/db/db'
import { CacheTab } from './CacheTab'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function renderTab() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/settings?tab=cache']}>
        <CacheTab />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('CacheTab factory reset', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
    setDb(null)
  })

  it('warns about the consequences and stays disabled until RESET is typed exactly', async () => {
    renderTab()

    fireEvent.click(await screen.findByTestId('reset-app-button'))

    // The warning list spells out what is about to be lost …
    expect(await screen.findByText(label('settings.cache.resetWarnData'))).toBeInTheDocument()
    expect(screen.getByText(label('settings.cache.resetWarnKeys'))).toBeInTheDocument()
    expect(screen.getByText(label('settings.cache.resetWarnSettings'))).toBeInTheDocument()

    // … and the confirm button refuses anything but the exact phrase.
    const confirm = screen.getByTestId('reset-confirm-button')
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByTestId('reset-phrase-input'), {
      target: { value: 'reset' },
    })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByTestId('reset-phrase-input'), {
      target: { value: 'RESET ' },
    })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByTestId('reset-phrase-input'), {
      target: { value: 'RESET' },
    })
    expect(confirm).toBeEnabled()
  })

  it('resetEverything clears the device secret, device id and UI preferences', async () => {
    localStorage.setItem('aidt.ui', JSON.stringify({ state: { theme: 'dark' }, version: 1 }))
    localStorage.setItem('aidt.deviceId', 'dev_test1234')
    localStorage.setItem('aidt.keySecret', 'sealed-test-material')

    await resetEverything()

    expect(localStorage.getItem('aidt.ui')).toBeNull()
    expect(localStorage.getItem('aidt.deviceId')).toBeNull()
    expect(localStorage.getItem('aidt.keySecret')).toBeNull()
  })
})
