/**
 * Side-by-side workspace (Phase 4).
 *
 * One virtualised list of page rows; each row holds the original page (left)
 * and the translated page (right) as two panes of the *same* row, so their
 * scroll is synced by construction — there is no per-pane scroll position to
 * keep in agreement.
 *
 * Both panes are `width × zoom` layout boxes with a `pt`-sized inner sheet
 * under `transform: scale(zoom)`: the artwork is raster (one render serves
 * every zoom level) while the text layer is DOM text and stays crisp.
 */

import { useCallback, useMemo, useRef, type ReactNode, type Ref } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useTranslation } from 'react-i18next'
import type { PageRecord } from '@/db/types'
import type { IndexedBlock } from '@/editor/commands'
import type { EditorView } from '@/editor/types'
import { BlockLayer, type BlockHighlight } from './BlockLayer'
import { usePageUrl, useProjectFileId } from './usePageUrl'

const EMPTY_BLOCKS: IndexedBlock[] = []

/** Visible index range reported by the virtualiser. */
interface VisibleRange {
  startIndex: number
  endIndex: number
}

export interface SplitViewProps {
  /** Project id — resolves the source document the panes render from. */
  projectId: string | null
  pages: PageRecord[]
  blocks: IndexedBlock[]
  view: EditorView
  zoom: number
  selected: ReadonlySet<string>
  editingId: string | null
  overflowIds: ReadonlySet<string>
  matches?: Map<string, BlockHighlight[]>
  onSelect: (id: string, additive: boolean) => void
  onBeginEdit: (id: string) => void
  onCommitEdit: (id: string, text: string) => void
  onCancelEdit: () => void
  onClearSelection: () => void
  /** First visible page — drives the "page" edit scope. */
  onVisiblePage?: (pageIndex: number) => void
  /** Escape hatch so the parent can scroll a specific page into view. */
  scrollerRef?: Ref<VirtuosoHandle>
}

interface PaneProps {
  fileId: string | null
  page: PageRecord
  zoom: number
  mode: 'thumbnail' | 'background'
  testId: string
  badge?: string
  children?: ReactNode
}

function Pane({ fileId, page, zoom, mode, testId, badge, children }: PaneProps) {
  const url = usePageUrl(fileId, page.index, mode)
  const widthPt = Math.max(1, page.width)
  const heightPt = Math.max(1, page.height)

  return (
    <div
      data-testid={testId}
      data-page-index={page.index}
      className="relative shrink-0 overflow-hidden border border-border bg-white"
      style={{ width: `${widthPt * zoom}pt`, height: `${heightPt * zoom}pt` }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: `${widthPt}pt`, height: `${heightPt}pt`, transform: `scale(${zoom})` }}
      >
        {url ? (
          <img src={url} alt="" decoding="async" className="absolute inset-0 h-full w-full" />
        ) : (
          <div className="skeleton-shimmer absolute inset-0" aria-hidden="true" />
        )}
        {children}
      </div>
      {badge ? (
        <span className="absolute left-1 top-1 rounded-md border border-border bg-surface/95 px-1 py-px text-[10px] text-muted">
          {badge}
        </span>
      ) : null}
    </div>
  )
}

interface PageRowProps extends Omit<SplitViewProps, 'pages' | 'projectId' | 'onVisiblePage'> {
  page: PageRecord
  blocks: IndexedBlock[]
  fileId: string | null
}

function PageRow({ page, blocks, fileId, view, zoom, ...rest }: PageRowProps) {
  const { t } = useTranslation()
  const showOriginal = view !== 'translated'
  const showTranslated = view !== 'original'

  return (
    <div
      className="flex flex-col gap-1.5 px-3 pb-4 pt-1"
      data-testid="page-row"
      data-page-index={page.index}
    >
      <div className="flex items-center gap-2 text-[11px] text-faint">
        <span className="tabular-nums">{t('editor.pageNumber', { number: page.index + 1 })}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-wrap items-start gap-4">
        {showOriginal ? (
          <Pane
            fileId={fileId}
            page={page}
            zoom={zoom}
            mode="thumbnail"
            testId="pane-original"
            badge={t('editor.originalPane')}
          />
        ) : null}
        {showTranslated ? (
          <Pane
            fileId={fileId}
            page={page}
            zoom={zoom}
            mode="background"
            testId="pane-translated"
            badge={t('editor.translatedPane')}
          >
            <div
              className="absolute inset-0"
              onClick={(event) => {
                if (event.target === event.currentTarget) rest.onClearSelection()
              }}
            >
              <BlockLayer
                blocks={blocks}
                selected={rest.selected}
                editingId={rest.editingId}
                overflowIds={rest.overflowIds}
                {...(rest.matches ? { matches: rest.matches } : {})}
                onSelect={rest.onSelect}
                onBeginEdit={rest.onBeginEdit}
                onCommitEdit={rest.onCommitEdit}
                onCancelEdit={rest.onCancelEdit}
              />
            </div>
          </Pane>
        ) : null}
      </div>
    </div>
  )
}

export function SplitView({
  pages,
  blocks,
  view,
  zoom,
  projectId,
  onVisiblePage,
  scrollerRef,
  ...rest
}: SplitViewProps) {
  const fileId = useProjectFileId(projectId)
  const lastRange = useRef<VisibleRange | null>(null)
  const notify = useRef(onVisiblePage)
  notify.current = onVisiblePage

  const grouped = useMemo(() => {
    const byPage = new Map<number, IndexedBlock[]>()
    for (const block of blocks) {
      const list = byPage.get(block.pageIndex)
      if (list) list.push(block)
      else byPage.set(block.pageIndex, [block])
    }
    return byPage
  }, [blocks])

  const handleRange = useCallback(
    (range: VisibleRange) => {
      const previous = lastRange.current
      lastRange.current = range
      if (previous && previous.startIndex === range.startIndex) return
      const page = pages[range.startIndex]
      if (page) notify.current?.(page.index)
    },
    [pages],
  )

  if (pages.length === 0) return null

  return (
    <Virtuoso
      ref={scrollerRef}
      data={pages}
      className="min-h-0 flex-1"
      computeItemKey={(_, page) => page.id}
      rangeChanged={handleRange}
      itemContent={(_, page) => (
        <PageRow
          {...rest}
          fileId={fileId}
          page={page}
          blocks={grouped.get(page.index) ?? EMPTY_BLOCKS}
          view={view}
          zoom={zoom}
        />
      )}
    />
  )
}
