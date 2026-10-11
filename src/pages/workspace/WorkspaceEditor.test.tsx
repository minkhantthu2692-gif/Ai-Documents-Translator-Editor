/**
 * Workspace editor integration test: the glue between the persisted document
 * and the split view.
 *
 * IndexedDB is faked exactly the way `BlockInspector.test.tsx` does it, and
 * `react-virtuoso` renders its items flat (see `SplitView.test.tsx` for why).
 * What is pinned here is the wiring that has no other test: gestures reaching
 * the store, an inline edit travelling through the command stack into Dexie
 * and back out again under undo, the keyboard shortcuts, and the session's
 * own lifecycle.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode, Ref } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { useEditorStore, resetEditorStore } from '@/editor/store'
import { WorkspaceEditor } from './WorkspaceEditor'

interface VirtuosoProps {
  data?: unknown[]
  itemContent?: (index: number, item: unknown) => ReactNode
  computeItemKey?: (index: number, item: unknown) => string
  rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
}

vi.mock('react-virtuoso', async () => {
  const { useEffect } = await import('react')
  return {
    Virtuoso: ({
      data,
      itemContent,
      computeItemKey,
      rangeChanged,
      ref,
    }: VirtuosoProps & { ref?: unknown }) => {
      const items = data ?? []
      useEffect(() => {
        if (items.length > 0) rangeChanged?.({ startIndex: 0, endIndex: items.length - 1 })
      }, [items.length, rangeChanged])
      return (
        <div data-testid="virtuoso-mock" ref={ref as Ref<HTMLDivElement>}>
          {items.map((item, index) => (
            <div key={computeItemKey?.(index, item) ?? String(index)}>
              {itemContent?.(index, item)}
            </div>
          ))}
        </div>
      )
    },
  }
})

const PROJECT_ID = 'prj_workspace_editor'
const SOURCE = 'Breaking news from the city'
const TRANSLATION = 'မြို့မှ နောက်ဆုံးရ သတင်းများ'

/** One page, two translated blocks — the smallest document worth opening. */
async function seed(): Promise<string[]> {
  const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0, width: 612, height: 792 })
  const first = await blockRepo.upsert({
    projectId: PROJECT_ID,
    pageId: page.id,
    order: 0,
    sourceText: SOURCE,
    translatedText: TRANSLATION,
  })
  const second = await blockRepo.upsert({
    projectId: PROJECT_ID,
    pageId: page.id,
    order: 1,
    sourceText: 'The board met on Tuesday.',
    translatedText: '',
  })
  return [first.id, second.id]
}

function mount(): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <WorkspaceEditor projectId={PROJECT_ID} />
    </I18nextProvider>,
  )
}

/** The block node with this id, once the live query has settled. */
async function blockNode(container: HTMLElement, id: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector(`[data-block-id="${id}"]`)).not.toBeNull()
  })
  return container.querySelector(`[data-block-id="${id}"]`) as HTMLElement
}

describe('WorkspaceEditor', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    resetEditorStore()
  })

  afterEach(() => {
    cleanup()
  })

  it('opens the session and renders the seeded page with its blocks', async () => {
    await seed()
    mount()

    expect(screen.getByTestId('workspace-editor')).toBeInTheDocument()
    // The live query settles asynchronously; the row is its first appearance.
    const row = await screen.findByTestId('page-row')
    expect(row).toHaveAttribute('data-page-index', '0')
    await waitFor(() => expect(screen.getAllByTestId('editor-block')).toHaveLength(2))
    expect(screen.getByText(TRANSLATION)).toBeInTheDocument()
    // The untranslated block falls back to its source.
    expect(screen.getByText('The board met on Tuesday.')).toBeInTheDocument()
    expect(useEditorStore.getState().projectId).toBe(PROJECT_ID)
  })

  it('selects a block on click, additively with ctrl', async () => {
    const [first, second] = await seed()
    const { container } = mount()

    fireEvent.click(await blockNode(container, first))
    expect(useEditorStore.getState().selection).toEqual([first])

    fireEvent.click(await blockNode(container, second), { ctrlKey: true })
    expect(useEditorStore.getState().selection).toEqual([first, second])
  })

  it('selects the visible page with Ctrl+A once the list reports it', async () => {
    await seed()
    mount()
    await waitFor(() => expect(useEditorStore.getState().activePage).toBe(0))

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
    expect(useEditorStore.getState().selection).toHaveLength(2)
  })

  it('edits a block inline, saves it through the command stack, undoes back', async () => {
    const [first] = await seed()
    const { container } = mount()

    fireEvent.dblClick(await blockNode(container, first))
    const editor = await screen.findByTestId('block-editor')
    editor.textContent = 'edited through the workspace'
    fireEvent.blur(editor)

    await waitFor(async () => {
      const record = await blockRepo.get(first)
      expect(record?.translatedText).toBe('edited through the workspace')
    })
    // The commit continues after the block write — history rows, then the
    // stack — so the stack is awaited the same way the write was.
    await waitFor(() => expect(useEditorStore.getState().undoStack).toHaveLength(1))

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(async () => {
      const record = await blockRepo.get(first)
      expect(record?.translatedText).toBe(TRANSLATION)
    })
  })

  it('opens find with Ctrl+F', async () => {
    await seed()
    mount()
    await screen.findAllByTestId('editor-block')

    expect(useEditorStore.getState().findOpen).toBe(false)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(useEditorStore.getState().findOpen).toBe(true)
    expect(await screen.findByRole('search')).toBeInTheDocument()
  })

  it('zooms with the keyboard and resets on zero', async () => {
    await seed()
    mount()
    await screen.findAllByTestId('editor-block')
    const start = useEditorStore.getState().zoom

    fireEvent.keyDown(window, { key: '=', ctrlKey: true })
    expect(useEditorStore.getState().zoom).toBeGreaterThan(start)

    fireEvent.keyDown(window, { key: '0', ctrlKey: true })
    expect(useEditorStore.getState().zoom).toBe(1)
  })

  it('ends the session on unmount', async () => {
    const [first] = await seed()
    const view = mount()
    fireEvent.click(await blockNode(view.container, first))
    expect(useEditorStore.getState().selection).toEqual([first])

    view.unmount()
    expect(useEditorStore.getState().selection).toEqual([])
    expect(useEditorStore.getState().projectId).toBeNull()
  })
})
