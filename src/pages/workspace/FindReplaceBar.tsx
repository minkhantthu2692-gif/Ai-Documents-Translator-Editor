/**
 * Find & replace bar (Phase 4).
 *
 * The query, the options and the current match live in the editor store, so
 * the bar and the page canvas always agree on which occurrence is active.
 * Replacing only ever writes `translatedText` — the extracted source text
 * belongs to the PDF — and every replacement lands as a single undoable
 * `find-replace` command.
 */

import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Input } from '@/components/ui'
import { IconChevronLeft, IconChevronRight, IconClose, IconSearch } from '@/components/layout/icons'
import { patchTargets } from '@/editor/blocks'
import {
  commandFrom,
  commitCommand,
  findMatches,
  replaceAllIn,
  type IndexedBlock,
} from '@/editor/commands'
import { useEditorStore } from '@/editor/store'
import type { FindMatch } from '@/editor/types'
import { toast } from '@/stores/toastStore'

export interface FindReplaceBarProps {
  /** Every block in reading order, loaded (and refreshed) by the parent. */
  blocks: IndexedBlock[]
  /** Called whenever the active match changes so the page can scroll to it. */
  onNavigate?: (match: FindMatch) => void
}

export function FindReplaceBar({ blocks, onNavigate }: FindReplaceBarProps) {
  const { t } = useTranslation()
  const findOpen = useEditorStore((state) => state.findOpen)
  const find = useEditorStore((state) => state.find)
  const matchIndex = useEditorStore((state) => state.matchIndex)
  const matchCount = useEditorStore((state) => state.matchCount)
  const setFind = useEditorStore((state) => state.setFind)
  const setFindOpen = useEditorStore((state) => state.setFindOpen)
  const setMatchState = useEditorStore((state) => state.setMatchState)

  const queryRef = useRef<HTMLInputElement>(null)
  const onNavigateRef = useRef(onNavigate)
  const matches = useMemo(() => findMatches(blocks, find), [blocks, find])
  const matchesRef = useRef(matches)
  const navigatedRef = useRef<{ matches: FindMatch[]; index: number } | null>(null)

  // Pages usually pass an inline arrow — a ref keeps a parent re-render from
  // re-firing the navigation on its own.
  useEffect(() => {
    onNavigateRef.current = onNavigate
  })

  // Latest matches for the reset below, which keys on `find` alone so a block
  // reload never throws the current match away.
  useEffect(() => {
    matchesRef.current = matches
  })

  // Focus the query when the bar opens (its first mount included).
  useEffect(() => {
    if (findOpen) queryRef.current?.focus()
  }, [findOpen])

  // Query or options changed ⇒ the counter starts over.
  useEffect(() => {
    if (find.query.length === 0) {
      setMatchState(0, 0)
      return
    }
    const state = useEditorStore.getState()
    const count = matchesRef.current.length
    if (state.matchCount !== count || state.matchIndex !== 0) setMatchState(count, 0)
  }, [find, setMatchState])

  const fire = useCallback(
    (index: number) => {
      const match = matches[index]
      if (!match) return
      const last = navigatedRef.current
      if (last && last.matches === matches && last.index === index) return
      navigatedRef.current = { matches, index }
      onNavigateRef.current?.(match)
    },
    [matches],
  )

  const activeIndex =
    matches.length === 0 ? 0 : Math.min(Math.max(matchIndex, 0), matches.length - 1)

  // Tell the page which match is current (open, query change, prev/next).
  useEffect(() => {
    if (!findOpen || matches.length === 0) return
    fire(Math.min(Math.max(matchIndex, 0), matches.length - 1))
  }, [findOpen, matchIndex, matches, fire])

  const currentMatch = matches.length === 0 ? null : matches[activeIndex]
  const shownIndex = matchCount === 0 ? 0 : Math.min(Math.max(matchIndex, 0), matchCount - 1) + 1

  function goTo(index: number): void {
    if (matches.length === 0) return
    const next = ((index % matches.length) + matches.length) % matches.length
    setMatchState(matches.length, next)
    fire(next)
  }

  function closeBar(): void {
    navigatedRef.current = null
    setFindOpen(false)
  }

  /** Replaces the current match (source-text matches are read-only). */
  function replaceCurrent(): void {
    if (!currentMatch || currentMatch.field !== 'translatedText') return
    const block = blocks.find((candidate) => candidate.id === currentMatch.blockId)
    if (!block) return
    const from = currentMatch.start
    const to = currentMatch.start + currentMatch.length
    const nextText =
      block.translatedText.slice(0, from) + find.replacement + block.translatedText.slice(to)
    const targets = patchTargets([block], [block.id], () => ({ translatedText: nextText }))
    if (targets.length === 0) return
    void commitCommand(
      commandFrom('editor.cmd.findReplace', 'find-replace', targets, 'user'),
    ).catch(() => toast('warning', t('toast.failed')))
  }

  /** One command across every block whose translation changed. */
  function replaceAll(): void {
    if (find.query.length === 0) return
    const replaced = new Map<string, string>()
    let count = 0
    for (const block of blocks) {
      const result = replaceAllIn(block.translatedText, find)
      if (result.count === 0) continue
      count += result.count
      replaced.set(block.id, result.text)
    }
    if (count === 0) return
    const ids = [...replaced.keys()]
    const targets = patchTargets(blocks, ids, (block) => ({
      translatedText: replaced.get(block.id) ?? block.translatedText,
    }))
    if (targets.length === 0) return
    void commitCommand(commandFrom('editor.cmd.findReplace', 'find-replace', targets, 'user'))
      .then(() =>
        toast('success', t('editor.find.replacedTitle'), t('editor.find.replacedBody', { count })),
      )
      .catch(() => toast('warning', t('toast.failed')))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeBar()
      return
    }
    const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey
    if (event.key !== 'Enter' || !unmodified) {
      // Ctrl/Cmd+Enter is the only chord this bar claims; every other
      // combination (Alt+Enter, Ctrl+K, …) stays with the browser.
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault()
        replaceAll()
      }
      return
    }
    event.preventDefault()
    if (event.shiftKey) goTo(activeIndex - 1)
    else goTo(activeIndex + 1)
  }

  if (!findOpen) return null

  const noMatches = matches.length === 0
  const replaceDisabled = !currentMatch || currentMatch.field !== 'translatedText'

  return (
    <div
      role="search"
      aria-label={t('editor.find.title')}
      onKeyDown={handleKeyDown}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2"
    >
      <div className="w-56">
        <Input
          ref={queryRef}
          value={find.query}
          onChange={(event) => setFind({ query: event.target.value })}
          placeholder={t('editor.find.queryPlaceholder')}
          aria-label={t('editor.find.queryPlaceholder')}
          iconLeft={<IconSearch />}
        />
      </div>

      <span aria-live="polite" className="min-w-16 text-center text-xs tabular-nums text-muted">
        {t('editor.find.counter', { index: shownIndex, count: matchCount })}
      </span>

      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          label={t('editor.find.previous')}
          icon={<IconChevronLeft />}
          disabled={noMatches}
          onClick={() => goTo(activeIndex - 1)}
        />
        <IconButton
          size="sm"
          label={t('common.next')}
          icon={<IconChevronRight />}
          disabled={noMatches}
          onClick={() => goTo(activeIndex + 1)}
        />
      </div>

      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant={find.caseSensitive ? 'secondary' : 'ghost'}
          aria-pressed={find.caseSensitive}
          onClick={() => setFind({ caseSensitive: !find.caseSensitive })}
        >
          {t('editor.find.caseSensitive')}
        </Button>
        <Button
          size="sm"
          variant={find.wholeWord ? 'secondary' : 'ghost'}
          aria-pressed={find.wholeWord}
          onClick={() => setFind({ wholeWord: !find.wholeWord })}
        >
          {t('editor.find.wholeWord')}
        </Button>
      </div>

      <div className="w-56">
        <Input
          value={find.replacement}
          onChange={(event) => setFind({ replacement: event.target.value })}
          placeholder={t('editor.find.replacePlaceholder')}
          aria-label={t('editor.find.replacePlaceholder')}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          disabled={replaceDisabled}
          title={replaceDisabled ? t('editor.find.sourceReadOnly') : undefined}
          onClick={replaceCurrent}
        >
          {t('editor.find.replace')}
        </Button>
        <Button size="sm" variant="primary" disabled={noMatches} onClick={replaceAll}>
          {t('editor.find.replaceAll')}
        </Button>
        <IconButton size="sm" label={t('common.close')} icon={<IconClose />} onClick={closeBar} />
      </div>
    </div>
  )
}
