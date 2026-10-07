/**
 * Block inspector render test: the three tabs come up, the seeded block's
 * translation and its pending suggestion are shown with Accept/Reject, and
 * the Document tab counts the block.
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
import { loadEditorBlocks } from '@/editor/blocks'
import { resetEditorStore } from '@/editor/store'
import { BlockInspector } from './BlockInspector'

const PROJECT_ID = 'prj_block_inspector'
const TRANSLATION = 'မြို့မှ နောက်ဆုံးရ သတင်းများ'
const SUGGESTION = 'မြို့တွင်းမှ နောက်ဆုံး သတင်းများ'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

describe('BlockInspector', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-inspector-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    resetEditorStore()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the tabs, the translation, the suggestion and the block count', async () => {
    const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0 })
    await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order: 0,
      kind: 'paragraph',
      sourceText: 'Breaking news from the city',
      translatedText: TRANSLATION,
      suggestedText: SUGGESTION,
      suggestedModel: 'gemini-2.0-flash',
      suggestedAt: Date.now() - 60_000,
      status: 'edited',
    })
    const blocks = await loadEditorBlocks(PROJECT_ID)

    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <BlockInspector projectId={PROJECT_ID} block={blocks[0]} blocks={blocks} />
        </MemoryRouter>
      </I18nextProvider>,
    )

    expect(screen.getAllByRole('tab')).toHaveLength(3)

    expect(await screen.findByLabelText(label('editor.block.translation'))).toHaveValue(TRANSLATION)

    expect(screen.getByText(label('editor.block.suggestion'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label('editor.block.accept') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label('editor.block.reject') })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: label('editor.tabs.document') }))
    expect(screen.getByText(label('workspace.blockCount')).nextElementSibling).toHaveTextContent(
      '1',
    )
  })
})
