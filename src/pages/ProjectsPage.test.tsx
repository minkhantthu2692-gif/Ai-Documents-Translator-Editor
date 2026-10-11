/**
 * ProjectsPage bulk selection and bulk delete (feature: "select and delete
 * several projects at once"). IndexedDB is faked the way the settings tab
 * tests do it — a uniquely named database per test seeded through the real
 * repository, so the cascade behind `removeMany` is the production one.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { projectRepo } from '@/db/repo-projects'
import { useUiStore } from '@/stores/uiStore'
import { ProjectsPage } from './ProjectsPage'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function renderPage() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/projects']}>
        <ProjectsPage />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('ProjectsPage bulk delete', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    useUiStore.setState({ projectsView: 'grid' })
    await i18n.changeLanguage('en')
    await projectRepo.create({ name: 'Alpha book', sourceLang: 'en', targetLang: 'my' })
    await projectRepo.create({ name: 'Beta report', sourceLang: 'en', targetLang: 'my' })
  })

  afterEach(() => {
    cleanup()
    setDb(null)
    useUiStore.setState({ projectsView: 'grid' })
  })

  it('selecting cards shows the bulk bar with a true count and deletes behind a confirm', async () => {
    renderPage()

    const boxes = await screen.findAllByTestId('project-select')
    expect(boxes).toHaveLength(2)
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])

    const bar = await screen.findByTestId('bulk-actions')
    expect(bar).toHaveTextContent('2')

    fireEvent.click(screen.getByRole('button', { name: label('projects.deleteSelected') }))
    const confirm = await screen.findByRole('button', { name: /^Delete 2$/ })
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByTestId('project-select')).toBeNull())
    expect(await db.projects.count()).toBe(0)
    expect(screen.queryByTestId('bulk-actions')).toBeNull()
  })

  it('cancelling the bulk confirm deletes nothing', async () => {
    renderPage()

    const boxes = await screen.findAllByTestId('project-select')
    fireEvent.click(boxes[0])

    fireEvent.click(await screen.findByRole('button', { name: label('projects.deleteSelected') }))
    const dialog = await screen.findByRole('button', { name: /^Delete 1$/ })
    fireEvent.click(screen.getByRole('button', { name: label('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Delete 1$/ })).toBeNull())

    expect(await db.projects.count()).toBe(2)
    expect(screen.getByTestId('bulk-actions')).toBeInTheDocument()
    expect(dialog).not.toBeInTheDocument()
  })

  it('list view offers select-all and clearing the selection hides the bar', async () => {
    useUiStore.getState().setProjectsView('list')
    renderPage()

    const selectAll = await screen.findByTestId('project-select-all')
    fireEvent.click(selectAll)

    await waitFor(() => {
      expect(screen.getByTestId('bulk-actions')).toHaveTextContent('2')
    })

    fireEvent.click(screen.getByRole('button', { name: label('projects.clearSelection') }))
    await waitFor(() => expect(screen.queryByTestId('bulk-actions')).toBeNull())
    // The rows themselves are untouched by clearing a selection.
    expect(await db.projects.count()).toBe(2)
  })
})
