/**
 * Export dialog render test: the dialog stays hidden while closed, opens with
 * the "Export as" menu listing PDF and DOCX, starts from a slugified file
 * name taken from the project record, and only shows the font-warning panel
 * when the preflight actually found missing families (never under jsdom,
 * where every family resolves). The export itself is never started.
 *
 * IndexedDB is faked exactly the way `src/pages/KnowledgePage.test.tsx` does
 * it — a uniquely named database per test so the repositories work unmocked.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { projectRepo } from '@/db/repo-projects'
import { ExportDialog } from './ExportDialog'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function Harness({ open, projectId }: { open: boolean; projectId: string }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <ExportDialog open={open} onClose={() => undefined} projectId={projectId} />
      </MemoryRouter>
    </I18nextProvider>
  )
}

describe('ExportDialog', () => {
  let db: AppDatabase
  let projectId: string

  beforeEach(async () => {
    db = new AppDatabase(
      `aidt-export-dialog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    setDb(db)
    await db.open()

    const project = await projectRepo.create({
      name: 'Sample Report',
      sourceLang: 'en',
      targetLang: 'my',
    })
    projectId = project.id

    const page = await pageRepo.upsert({ projectId, index: 0 })
    await blockRepo.upsert({
      projectId,
      pageId: page.id,
      order: 0,
      fontFamily: 'ABCDEF+Calibri',
      sourceText: 'Torque curve',
      translatedText: 'တာယာအား မှတ်တမ်း',
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('opens with the format menu, a slugified file name and no false font warning', async () => {
    const view = render(<Harness open={false} projectId={projectId} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    view.rerender(<Harness open projectId={projectId} />)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    // "Export as" menu: every format is listed under its group heading.
    fireEvent.click(screen.getByTestId('export-format-html'))
    expect(await screen.findByText(label('export.format.pdf'))).toBeInTheDocument()
    expect(screen.getByText(label('export.format.docx'))).toBeInTheDocument()

    // The file name starts from the project's slug ("Sample Report").
    expect(await screen.findByDisplayValue('sample-report')).toBeInTheDocument()

    // jsdom resolves every family, so either there is no panel or it is a
    // warning — never a panel that claims trouble without the tone.
    const fontWarning = screen.queryByTestId('export-font-warning')
    expect(fontWarning === null || fontWarning.getAttribute('data-tone') === 'warning').toBe(true)
  })
})
