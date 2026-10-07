/**
 * Knowledge page render test: the three tabs come up, a glossary term entered
 * through the form lands in the table and all four presets are listed.
 *
 * IndexedDB is faked exactly the way `src/db/repo-content.test.ts` does it —
 * a uniquely named database per test so the repositories work unmocked.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { PROJECT_TEMPLATES } from '@/editor/templates'
import { KnowledgePage } from './KnowledgePage'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function renderPage() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('KnowledgePage', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the three tabs, adds a glossary term and lists the presets', async () => {
    renderPage()

    expect(screen.getAllByRole('tab')).toHaveLength(3)

    fireEvent.change(screen.getByLabelText(label('knowledge.glossary.sourceLabel')), {
      target: { value: 'quality assurance' },
    })
    fireEvent.change(screen.getByLabelText(label('knowledge.glossary.targetLabel')), {
      target: { value: 'အရည်အသွေး စစ်ဆေးခြင်း' },
    })
    fireEvent.click(screen.getByRole('button', { name: label('common.add') }))

    expect(await screen.findByText('quality assurance')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: label('knowledge.tabs.tm') }))
    expect(await screen.findByText(label('knowledge.tm.emptyTitle'))).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: label('knowledge.tabs.templates') }))
    expect(
      PROJECT_TEMPLATES.every((template) => screen.queryByText(template.nameEn) !== null),
    ).toBe(true)
  })
})
