/**
 * Block layer render tests: the translated text layer over the page artwork.
 *
 * Blocks reach the layer the way the app builds them — `blockRepo.upsert`
 * fills every default the layer reads (fonts, geometry, status), and
 * `loadEditorBlocks` adds the page index — so each test states only what it
 * is actually about: positioning, selection, the inline editor's commit and
 * revert, and the badges.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import type { BlockRecord } from '@/db/types'
import { loadEditorBlocks } from '@/editor/blocks'
import type { IndexedBlock } from '@/editor/commands'
import { CODE_FONT_STACK } from '@/pdf/codeBlocks'
import { BlockLayer, blockStyle, type BlockHighlight } from './BlockLayer'

const PROJECT_ID = 'prj_block_layer'
const SOURCE = 'Breaking news from the city'
const TRANSLATION = 'မြို့မှ နောက်ဆုံးရ သတင်းများ'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

/** Seeds blocks through the repository and returns the blocks it added. */
async function seed(input: Array<Partial<BlockRecord>>): Promise<IndexedBlock[]> {
  const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0, width: 612, height: 792 })
  const ids: string[] = []
  for (const [order, extra] of input.entries()) {
    const record = await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order,
      ...extra,
    })
    ids.push(record.id)
  }
  const all = await loadEditorBlocks(PROJECT_ID)
  return all.filter((block) => ids.includes(block.id))
}

interface LayerOptions {
  blocks: IndexedBlock[]
  selected?: ReadonlySet<string>
  editingId?: string | null
  overflowIds?: ReadonlySet<string>
  matches?: Map<string, BlockHighlight[]>
}

/** Renders the layer and hands back the spies it calls. */
function renderLayer(options: LayerOptions) {
  const onSelect = vi.fn()
  const onBeginEdit = vi.fn()
  const onCommitEdit = vi.fn()
  const onCancelEdit = vi.fn()
  const handlers = { onSelect, onBeginEdit, onCommitEdit, onCancelEdit }
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <BlockLayer
        blocks={options.blocks}
        selected={options.selected ?? new Set()}
        editingId={options.editingId ?? null}
        overflowIds={options.overflowIds ?? new Set()}
        {...(options.matches ? { matches: options.matches } : {})}
        onSelect={onSelect}
        onBeginEdit={onBeginEdit}
        onCommitEdit={onCommitEdit}
        onCancelEdit={onCancelEdit}
      />
    </I18nextProvider>,
  )
  return { ...handlers, container: rendered.container }
}

describe('BlockLayer', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-blocklayer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the translation, falling back to the source when there is none', async () => {
    const blocks = await seed([
      { sourceText: SOURCE, translatedText: TRANSLATION },
      { sourceText: SOURCE, translatedText: '' },
    ])
    renderLayer({ blocks })

    expect(screen.getByText(TRANSLATION)).toBeInTheDocument()
    // Once: the untranslated block falls back, the translated one does not.
    expect(screen.getAllByText(SOURCE)).toHaveLength(1)
  })

  it('positions every block in points, in its own face, on its own page', async () => {
    const [only] = await seed([
      {
        sourceText: SOURCE,
        translatedText: TRANSLATION,
        x: 72,
        y: 100,
        width: 200,
        height: 14,
        fontSize: 11,
        fontFamily: 'Times',
      },
    ])
    renderLayer({ blocks: [only] })

    const node = screen.getByTestId('editor-block')
    expect(node).toHaveAttribute('data-block-id', only.id)
    expect(node).toHaveAttribute('data-page-index', '0')
    expect(node.style.left).toBe('72pt')
    expect(node.style.top).toBe('100pt')
    expect(node.style.width).toBe('200pt')
    expect(node.style.minHeight).toBe('14pt')
    expect(node.style.fontSize).toBe('11pt')
    expect(node.style.fontFamily).toContain('Times')
  })

  it('styles the exotic cases through blockStyle: code stack, RTL, justify', async () => {
    const [code] = await seed([{ kind: 'code', sourceText: 'const x = 1' }])
    expect(blockStyle(code).fontFamily).toBe(CODE_FONT_STACK)
    expect(blockStyle(code).tabSize).toBe(4)

    const [rtl] = await seed([{ sourceText: SOURCE, translatedText: 'مرحبا بالعالم' }])
    expect(blockStyle(rtl).direction).toBe('rtl')

    const [justified] = await seed([{ sourceText: SOURCE, alignment: 'justified' }])
    expect(blockStyle(justified).textAlign).toBe('justify')
  })

  it('selects on click, additively with ctrl or shift', async () => {
    const [only] = await seed([{ sourceText: SOURCE, translatedText: TRANSLATION }])
    const { onSelect } = renderLayer({ blocks: [only] })
    const node = screen.getByTestId('editor-block')

    fireEvent.click(node)
    expect(onSelect).toHaveBeenLastCalledWith(only.id, false)
    fireEvent.click(node, { ctrlKey: true })
    expect(onSelect).toHaveBeenLastCalledWith(only.id, true)
    fireEvent.click(node, { shiftKey: true })
    expect(onSelect).toHaveBeenLastCalledWith(only.id, true)
  })

  it('begins an edit on double-click, but never on a locked block', async () => {
    const [open, locked] = await seed([
      { sourceText: SOURCE, translatedText: TRANSLATION },
      { sourceText: SOURCE, translatedText: TRANSLATION, status: 'locked' },
    ])
    const { container, onBeginEdit } = renderLayer({ blocks: [open, locked] })
    const nodeOf = (id: string): HTMLElement => {
      const node = container.querySelector(`[data-block-id="${id}"]`)
      expect(node).not.toBeNull()
      return node as HTMLElement
    }

    fireEvent.dblClick(nodeOf(open.id))
    expect(onBeginEdit).toHaveBeenCalledWith(open.id)

    fireEvent.dblClick(nodeOf(locked.id))
    expect(onBeginEdit).toHaveBeenCalledTimes(1)
  })

  it('commits the inline editor on blur', async () => {
    const [only] = await seed([{ sourceText: SOURCE, translatedText: TRANSLATION }])
    const { onCommitEdit } = renderLayer({ blocks: [only], editingId: only.id })

    const editor = screen.getByTestId('block-editor')
    expect(editor).toHaveTextContent(TRANSLATION)
    editor.textContent = 'edited in place'
    fireEvent.blur(editor)
    expect(onCommitEdit).toHaveBeenCalledWith(only.id, 'edited in place')
  })

  it('reverts the inline editor on Escape, and the later blur commits nothing', async () => {
    const [only] = await seed([{ sourceText: SOURCE, translatedText: TRANSLATION }])
    const { onCommitEdit, onCancelEdit } = renderLayer({ blocks: [only], editingId: only.id })

    const editor = screen.getByTestId('block-editor')
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(onCancelEdit).toHaveBeenCalledTimes(1)

    fireEvent.blur(editor)
    expect(onCommitEdit).not.toHaveBeenCalled()
  })

  it('marks selection and overflow, and badges a pending suggestion', async () => {
    const [only] = await seed([
      {
        sourceText: SOURCE,
        translatedText: TRANSLATION,
        suggestedText: 'suggested words',
        suggestedModel: 'gemini-2.0-flash',
        suggestedAt: Date.now() - 60_000,
      },
    ])
    renderLayer({
      blocks: [only],
      selected: new Set([only.id]),
      overflowIds: new Set([only.id]),
    })

    const node = screen.getByTestId('editor-block')
    expect(node).toHaveAttribute('data-selected', 'true')
    expect(node).toHaveAttribute('data-overflow', 'true')
    expect(screen.getByTitle(label('editor.block.suggestionBadge'))).toBeInTheDocument()
    expect(screen.getByTitle(label('editor.block.overflowBadge'))).toBeInTheDocument()
  })

  it('wraps find matches in mark elements, the active one emphasised', async () => {
    const [only] = await seed([{ sourceText: SOURCE, translatedText: 'city news today' }])
    const matches = new Map<string, BlockHighlight[]>([
      [
        only.id,
        [
          { start: 0, length: 4, active: false },
          { start: 5, length: 4, active: true },
        ],
      ],
    ])
    renderLayer({ blocks: [only], matches })

    const marks = screen.getByTestId('editor-block').querySelectorAll('mark')
    expect(marks).toHaveLength(2)
    expect(marks[0]).toHaveTextContent('city')
    expect(marks[0].className).toContain('bg-warning')
    expect(marks[1]).toHaveTextContent('news')
    expect(marks[1].className).toContain('bg-primary')
  })
})
