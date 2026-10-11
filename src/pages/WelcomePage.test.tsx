/**
 * First-run welcome + setup screen (the combined landing/first-time-setup
 * page): language, appearance and sync choices, and the three ways out —
 * Get started (default flow), Get started after choosing sync setup, and the
 * quiet skip-to-dashboard link. Each path must mark onboarding complete and
 * land on the right route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import i18n from '@/i18n'
import { useUiStore } from '@/stores/uiStore'
import { WelcomePage } from './WelcomePage'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function renderWelcome() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/welcome']}>
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/projects/new" element={<div data-testid="dest-new" />} />
          <Route path="/settings" element={<div data-testid="dest-settings" />} />
          <Route path="/" element={<div data-testid="dest-dashboard" />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

function resetStore() {
  useUiStore.setState({ onboarded: false, language: 'en', theme: 'system' })
}

describe('WelcomePage', () => {
  beforeEach(async () => {
    resetStore()
    await i18n.changeLanguage('en')
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    await i18n.changeLanguage('en')
  })

  it('renders the setup choices: language, appearance and sync', () => {
    renderWelcome()

    expect(screen.getByTestId('welcome-get-started')).toBeInTheDocument()
    expect(screen.getByText('English')).toBeInTheDocument()
    expect(screen.getByText('မြန်မာ')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label('welcome.themeLight') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label('welcome.themeDark') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label('welcome.themeSystem') })).toBeInTheDocument()
    expect(screen.getByText(label('welcome.syncSkip'))).toBeInTheDocument()
    expect(screen.getByText(label('welcome.syncLater'))).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: label('welcome.skipToDashboard') }),
    ).toBeInTheDocument()
  })

  it('switches the app language and remembers the theme choice', async () => {
    renderWelcome()

    fireEvent.click(screen.getByText('မြန်မာ'))
    await waitFor(() => expect(useUiStore.getState().language).toBe('my'))
    await waitFor(() => expect(i18n.language).toBe('my'))

    fireEvent.click(screen.getByRole('button', { name: label('welcome.themeDark') }))
    await waitFor(() => expect(useUiStore.getState().theme).toBe('dark'))
  })

  it('Get started completes onboarding and heads to the new-project flow', async () => {
    renderWelcome()

    fireEvent.click(screen.getByTestId('welcome-get-started'))

    expect(await screen.findByTestId('dest-new')).toBeInTheDocument()
    expect(useUiStore.getState().onboarded).toBe(true)
  })

  it('choosing sync setup routes Get started to the data settings instead', async () => {
    renderWelcome()

    fireEvent.click(screen.getByText(label('welcome.syncLater')))
    fireEvent.click(screen.getByTestId('welcome-get-started'))

    expect(await screen.findByTestId('dest-settings')).toBeInTheDocument()
    expect(useUiStore.getState().onboarded).toBe(true)
  })

  it('the skip link lands on the dashboard and still finishes setup', async () => {
    renderWelcome()

    fireEvent.click(screen.getByRole('button', { name: label('welcome.skipToDashboard') }))

    expect(await screen.findByTestId('dest-dashboard')).toBeInTheDocument()
    expect(useUiStore.getState().onboarded).toBe(true)
  })
})
