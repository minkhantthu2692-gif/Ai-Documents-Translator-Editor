/**
 * Split view render tests: one row per page, two panes of the same row,
 * blocks grouped per page, and the callbacks each row wires up.
 *
 * `react-virtuoso` is mocked to render every item flat and to report the
 * full range once: the virtualiser's own windowing is its library's contract
 * and jsdom has no layout to measure it with. What is pinned here is
 * everything around it — grouping, view modes, pane geometry at zoom, the
 * artwork fallback, and the gesture routing.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import type { BlockRecord, PageRecord } from '@/db/types'
import { loadEditorBlocks } from '@/editor/blocks'
import type { IndexedBlock } from '@/editor/commands'
import type { EditorView } from '@/editor/types'
import { SplitView } from './SplitView'

interface VirtuosoProps {
  data?: unknown[]
  itemContent?: (index: number, item: unknown) => ReactNode
  computeItemKey?: (index: number, item: unknown) => string
  rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
}

vi.mock('react-virtuoso', async () => {
  const { useEffect } = await import('react')
  return {
    Virtuoso: ({ data, itemContent, computeItemKey, rangeChanged }: VirtuosoProps) => {
      const items = data ?? []
      useEffect(() => {
        if (items.length > 0) rangeChanged?.({ startIndex: 0, endIndex: items.length - 1 })
      }, [items.length, rangeChanged])
      return (
        <div data-testid="virtuoso-mock">
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

const PROJECT_ID = 'prj_split_view'
const TRANSLATION = 'မြို့မှ နောက်ဆုံးရ သတင်းများ'

/** Seeds `count` letter-sized pages and returns them in index order. */
async function seedPages(count: number): Promise<PageRecord[]> {
  const pages: PageRecord[] = []
  for (let index = 0; index < count; index += 1) {
    pages.push(await pageRepo.upsert({ projectId: PROJECT_ID, index, width: 612, height: 792 }))
  }
  return pages
}

async function seedBlock(
  page: PageRecord,
  extra: Partial<BlockRecord> = {},
): Promise<IndexedBlock> {
  const record = await blockRepo.upsert({
    projectId: PROJECT_ID,
    pageId: page.id,
    order: 0,
    sourceText: 'Breaking news from the city',
    translatedText: TRANSLATION,
    ...extra,
  })
  const blocks = await loadEditorBlocks(PROJECT_ID)
  return blocks.find((block) => block.id === record.id) ?? blocks[blocks.length - 1]
}

interface ViewOptions {
  pages: PageRecord[]
  blocks: IndexedBlock[]
  view?: EditorView
  zoom?: number
  selected?: ReadonlySet<string>
  onSelect?: (id: string, additive: boolean) => void
  onBeginEdit?: (id: string) => void
  onCommitEdit?: (id: string, text: string) => void
  onCancelEdit?: () => void
  onClearSelection?: () => void
  onVisiblePage?: (pageIndex: number) => void
}

function renderView(options: ViewOptions) {
  render(
    <I18nextProvider i18n={i18n}>
      <SplitView
        projectId={PROJECT_ID}
        pages={options.pages}
        blocks={options.blocks}
        view={options.view ?? 'split'}
        zoom={options.zoom ?? 1}
        selected={options.selected ?? new Set()}
        editingId={null}
        overflowIds={new Set()}
        onSelect={options.onSelect ?? vi.fn()}
        onBeginEdit={options.onBeginEdit ?? vi.fn()}
        onCommitEdit={options.onCommitEdit ?? vi.fn()}
        onCancelEdit={options.onCancelEdit ?? vi.fn()}
        onClearSelection={options.onClearSelection ?? vi.fn()}
        {...(options.onVisiblePage ? { onVisiblePage: options.onVisiblePage } : {})}
      />
    </I18nextProvider>,
  )
}

describe('SplitView', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-splitview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when the project has no pages yet', async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <SplitView
          projectId={PROJECT_ID}
          pages={[]}
          blocks={[]}
          view="split"
          zoom={1}
          selected={new Set()}
          editingId={null}
          overflowIds={new Set()}
          onSelect={vi.fn()}
          onBeginEdit={vi.fn()}
          onCommitEdit={vi.fn()}
          onCancelEdit={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </I18nextProvider>,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows both panes of a row at zoomed points, with the artwork pending', async () => {
    const [page] = await seedPages(1)
    const block = await seedBlock(page)
    renderView({ pages: [page], blocks: [block], zoom: 1.5 })

    const original = screen.getByTestId('pane-original')
    const translated = screen.getByTestId('pane-translated')
    for (const pane of [original, translated]) {
      expect(pane).toHaveAttribute('data-page-index', '0')
      expect(pane.style.width).toBe(`${612 * 1.5}pt`)
      expect(pane.style.height).toBe(`${792 * 1.5}pt`)
    }
    // No source document rendered in this environment: the pane shows the
    // placeholder sheet, never a broken image.
    expect(original.querySelector('.skeleton-shimmer')).not.toBeNull()
    expect(original.querySelector('img')).toBeNull()
    // The translated pane carries the text layer over its artwork.
    expect(translated.querySelector('[data-testid="editor-block"]')).not.toBeNull()
  })

  it('drops the right pane in translated view and the left one in original view', async () => {
    const [page] = await seedPages(1)
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <SplitView
          projectId={PROJECT_ID}
          pages={[page]}
          blocks={[]}
          view="split"
          zoom={1}
          selected={new Set()}
          editingId={null}
          overflowIds={new Set()}
          onSelect={vi.fn()}
          onBeginEdit={vi.fn()}
          onCommitEdit={vi.fn()}
          onCancelEdit={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </I18nextProvider>,
    )
    expect(screen.getByTestId('pane-original')).toBeInTheDocument()
    expect(screen.getByTestId('pane-translated')).toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18n}>
        <SplitView
          projectId={PROJECT_ID}
          pages={[page]}
          blocks={[]}
          view="translated"
          zoom={1}
          selected={new Set()}
          editingId={null}
          overflowIds={new Set()}
          onSelect={vi.fn()}
          onBeginEdit={vi.fn()}
          onCommitEdit={vi.fn()}
          onCancelEdit={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </I18nextProvider>,
    )
    expect(screen.queryByTestId('pane-original')).toBeNull()
    expect(screen.getByTestId('pane-translated')).toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18n}>
        <SplitView
          projectId={PROJECT_ID}
          pages={[page]}
          blocks={[]}
          view="original"
          zoom={1}
          selected={new Set()}
          editingId={null}
          overflowIds={new Set()}
          onSelect={vi.fn()}
          onBeginEdit={vi.fn()}
          onCommitEdit={vi.fn()}
          onCancelEdit={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </I18nextProvider>,
    )
    expect(screen.getByTestId('pane-original')).toBeInTheDocument()
    expect(screen.queryByTestId('pane-translated')).toBeNull()
  })

  it('draws a page under its own blocks only', async () => {
    const pages = await seedPages(2)
    const first = await seedBlock(pages[0])
    const second = await seedBlock(pages[1])
    renderView({ pages, blocks: [first, second] })

    const rows = screen.getAllByTestId('page-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector(`[data-block-id="${first.id}"]`)).not.toBeNull()
    expect(rows[0].querySelector(`[data-block-id="${second.id}"]`)).toBeNull()
    expect(rows[1].querySelector(`[data-block-id="${second.id}"]`)).not.toBeNull()
  })

  it('routes a block click to selection and an empty-pane click to clearing it', async () => {
    const [page] = await seedPages(1)
    const block = await seedBlock(page)
    const onSelect = vi.fn()
    const onClearSelection = vi.fn()
    renderView({ pages: [page], blocks: [block], onSelect, onClearSelection })

    fireEvent.click(screen.getByTestId('editor-block'))
    expect(onSelect).toHaveBeenCalledWith(block.id, false)

    // The overlay that swallows clicks between blocks: its own target only.
    const overlay = screen.getByTestId('editor-block').parentElement?.parentElement
    expect(overlay).not.toBeNull()
    fireEvent.click(overlay as HTMLElement)
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('reports the first visible page as the list comes up', async () => {
    const pages = await seedPages(2)
    const onVisiblePage = vi.fn()
    renderView({ pages, blocks: [], onVisiblePage })
    expect(onVisiblePage).toHaveBeenCalledWith(pages[0].index)
  })
})
