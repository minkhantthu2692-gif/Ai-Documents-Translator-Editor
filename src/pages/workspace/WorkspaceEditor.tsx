/**
 * Workspace editor (Phase 4).
 *
 * The glue between the persisted document and the split view: it opens the
 * session, keeps the live blocks/pages flowing from Dexie, wires the keyboard,
 * maintains the find highlights and the overflow badges, and routes every user
 * gesture through the command stack so the whole session stays undoable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import type { VirtuosoHandle } from 'react-virtuoso'
import { pageRepo } from '@/db/repo-content'
import type { PageRecord } from '@/db/types'
import { commandFrom, commitCommand, findMatches, type IndexedBlock } from '@/editor/commands'
import { loadEditorBlocks, patchTargets } from '@/editor/blocks'
import { findOverflowing, applyBlockStyle } from '@/editor/fontControls'
import { redo, undo } from '@/editor/history'
import { shortcutFor, shouldPreventDefault, type ShortcutId } from '@/editor/keyboard'
import { acceptSuggestion, rejectSuggestion, retranslate } from '@/editor/retranslate'
import { useEditorStore } from '@/editor/store'
import type { FindMatch } from '@/editor/types'
import { toast } from '@/stores/toastStore'
import { FindReplaceBar } from './FindReplaceBar'
import { ExportDialog } from './ExportDialog'
import { EditorToolbar } from './EditorToolbar'
import { SplitView } from './SplitView'
import type { BlockHighlight } from './BlockLayer'

/** Shortcuts that still make sense while typing inside a block. */
const WHILE_TYPING: ShortcutId[] = ['find', 'replace', 'export']

export interface WorkspaceEditorProps {
  projectId: string
}

export function WorkspaceEditor({ projectId }: WorkspaceEditorProps) {
  const { t } = useTranslation()
  const [exportOpen, setExportOpen] = useState(false)
  const scroller = useRef<VirtuosoHandle | null>(null)

  const pages = useLiveQuery(
    () => pageRepo.listByProject(projectId),
    [projectId],
    [] as PageRecord[],
  )
  const blocks = useLiveQuery(() => loadEditorBlocks(projectId), [projectId], [] as IndexedBlock[])

  const view = useEditorStore((state) => state.view)
  const zoom = useEditorStore((state) => state.zoom)
  const selection = useEditorStore((state) => state.selection)
  const editingId = useEditorStore((state) => state.editingBlockId)
  const overflowIds = useEditorStore((state) => state.overflowIds)
  const find = useEditorStore((state) => state.find)
  const findOpen = useEditorStore((state) => state.findOpen)
  const matchIndex = useEditorStore((state) => state.matchIndex)
  const matchCount = useEditorStore((state) => state.matchCount)
  const activePage = useEditorStore((state) => state.activePage)

  const blocksRef = useRef(blocks)
  blocksRef.current = blocks

  // Session lifecycle: a fresh store per project, cleared on unmount.
  useEffect(() => {
    useEditorStore.getState().open(projectId)
    return () => useEditorStore.getState().close()
  }, [projectId])

  // Overflow badges (debounced — measuring every block on each keystroke
  // would fight the autosave on a 300-page document).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      useEditorStore.getState().setOverflow(findOverflowing(blocks))
    }, 400)
    return () => window.clearTimeout(timer)
  }, [blocks])

  // Find: recompute matches when the query or the document changes.
  const matches = useMemo(() => {
    if (!findOpen || find.query.trim().length === 0) return [] as FindMatch[]
    return findMatches(blocks, find)
  }, [blocks, find, findOpen])

  useEffect(() => {
    if (!findOpen) return
    const clamped = matches.length === 0 ? 0 : Math.min(matchIndex, matches.length - 1)
    if (clamped !== matchIndex || matchCount !== matches.length) {
      useEditorStore.getState().setMatchState(matches.length, clamped)
    }
  }, [matches, findOpen, matchIndex, matchCount])

  const highlight = useMemo(() => {
    const map = new Map<string, BlockHighlight[]>()
    if (matches.length === 0) return map
    matches.forEach((match, index) => {
      if (match.field !== 'translatedText') return
      const list = map.get(match.blockId) ?? []
      list.push({ start: match.start, length: match.length, active: index === matchIndex })
      map.set(match.blockId, list)
    })
    return map
  }, [matches, matchIndex])

  const scrollToMatch = useCallback((match: FindMatch | undefined) => {
    if (!match) return
    scroller.current?.scrollToIndex({ index: match.pageIndex, align: 'center' })
    window.requestAnimationFrame(() => {
      const element = document.querySelector(`[data-block-id="${match.blockId}"]`)
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [])

  const commitEdit = useCallback(async (id: string, text: string) => {
    useEditorStore.getState().setEditing(null)
    const list = blocksRef.current
    const target = patchTargets(list, [id], () => ({
      translatedText: text,
      status: 'edited' as const,
    }))
    if (target.length === 0) return
    await commitCommand(commandFrom('editor.cmd.editText', 'edit-text', target, 'user'))
  }, [])

  const runRetranslate = useCallback(
    async (target: 'selection' | 'page') => {
      const state = useEditorStore.getState()
      const page =
        target === 'page' ? pages.find((entry) => entry.index === state.activePage) : undefined
      if (target === 'selection' && state.selection.length === 0) {
        toast('info', t('editor.retranslate.nothingTitle'), t('editor.retranslate.nothingBody'))
        return
      }
      if (target === 'page' && !page) {
        toast('info', t('editor.retranslate.noPageTitle'), t('editor.retranslate.noPageBody'))
        return
      }

      state.setBusy({ kind: 'retranslate', done: 0, total: 0, ratio: 0 })
      try {
        const result = await retranslate({
          projectId,
          ...(target === 'selection' ? { blockIds: state.selection } : {}),
          ...(page ? { pageId: page.id } : {}),
          mode: 'apply',
          onProgress: (done, total) =>
            useEditorStore.getState().setBusy({
              kind: 'retranslate',
              done,
              total,
              ratio: total > 0 ? done / total : 0,
            }),
        })
        if (result.changed > 0) {
          toast(
            'success',
            t('editor.retranslate.doneTitle'),
            t('editor.retranslate.doneBody', { count: result.changed }),
          )
        } else {
          toast('info', t('editor.retranslate.nothingTitle'), t('editor.retranslate.nothingBody'))
        }
      } catch (error) {
        toast(
          'danger',
          t('editor.retranslate.failedTitle'),
          error instanceof Error ? error.message : String(error),
        )
      } finally {
        useEditorStore.getState().setBusy(null)
      }
    },
    [projectId, pages, t],
  )

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName ?? ''))
      const id = shortcutFor(event)
      if (!id) return
      if (typing && !WHILE_TYPING.includes(id)) return
      if (shouldPreventDefault(id)) event.preventDefault()

      const store = useEditorStore.getState()
      const active = blocksRef.current.find((block) => block.id === store.activeBlockId) ?? null

      const applyWeight = (kind: 'bold' | 'italic'): void => {
        const value = !(active?.[kind] ?? false)
        void applyBlockStyle({
          projectId,
          scope: store.scope,
          selection: store.selection,
          activePage: store.activePage,
          patch: kind === 'bold' ? { bold: value } : { italic: value },
          labelKey: 'editor.cmd.style',
        })
      }

      switch (id as ShortcutId) {
        case 'undo':
          void undo()
          break
        case 'redo':
          void redo()
          break
        case 'find':
        case 'replace':
          store.setFindOpen(true)
          break
        case 'selectAll':
          if (store.activePage !== null) {
            store.setSelection(
              blocksRef.current
                .filter((block) => block.pageIndex === store.activePage)
                .map((block) => block.id),
            )
          }
          break
        case 'bold':
          applyWeight('bold')
          break
        case 'italic':
          applyWeight('italic')
          break
        case 'zoomIn':
          store.zoomIn()
          break
        case 'zoomOut':
          store.zoomOut()
          break
        case 'zoomReset':
          store.resetZoom()
          break
        case 'export':
          setExportOpen(true)
          break
        case 'acceptSuggestion':
          if (store.activeBlockId) {
            void acceptSuggestion(projectId, store.activeBlockId).then((result) => {
              if (result.accepted) toast('success', t('editor.suggestion.acceptedTitle'))
            })
          }
          break
        case 'rejectSuggestion':
          if (store.activeBlockId) {
            void rejectSuggestion(projectId, store.activeBlockId).then((result) => {
              if (result.rejected) toast('info', t('editor.suggestion.rejectedTitle'))
            })
          }
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [projectId, t])

  const activeBlock = useMemo(
    () => blocks.find((block) => block.id === selection[selection.length - 1]) ?? null,
    [blocks, selection],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-editor">
      <EditorToolbar
        projectId={projectId}
        activeBlock={activeBlock}
        onExport={() => setExportOpen(true)}
        onRetranslate={(target) => void runRetranslate(target)}
      />

      <FindReplaceBar blocks={blocks} onNavigate={scrollToMatch} />

      <SplitView
        projectId={projectId}
        pages={pages}
        blocks={blocks}
        view={view}
        zoom={zoom}
        selected={new Set(selection)}
        editingId={editingId}
        overflowIds={new Set(overflowIds)}
        matches={highlight}
        scrollerRef={scroller}
        onSelect={(id, additive) => {
          const store = useEditorStore.getState()
          if (additive) store.toggleSelection(id)
          else store.selectOnly(id)
        }}
        onBeginEdit={(id) => useEditorStore.getState().setEditing(id)}
        onCommitEdit={(id, text) => void commitEdit(id, text)}
        onCancelEdit={() => useEditorStore.getState().setEditing(null)}
        onClearSelection={() => useEditorStore.getState().setActive(null)}
        onVisiblePage={(pageIndex) => {
          const store = useEditorStore.getState()
          if (store.activePage !== pageIndex) store.setActivePage(pageIndex)
        }}
      />

      <div className="sr-only" aria-live="polite">
        {t('editor.status.summary', {
          pages: pages.length,
          blocks: blocks.length,
          matches: findOpen ? matchCount : 0,
          page: activePage !== null ? activePage + 1 : 0,
        })}
      </div>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} projectId={projectId} />
    </div>
  )
}
