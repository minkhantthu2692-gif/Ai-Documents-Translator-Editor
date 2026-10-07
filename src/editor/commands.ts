/**
 * Editor commands (Phase 4).
 *
 * A command is data: an inverse pair of per-block patches plus the history
 * metadata that describes it. Applying, undoing and redoing are the same
 * operation (write one side of the pair), which is what keeps undo/redo exact
 * across blocks, pages and reloads — the authoritative state is always
 * IndexedDB, never the stack.
 */

import { blockRepo } from '@/db/repo-content'
import { revisionRepo } from '@/db/repo-revisions'
import type { BlockRecord } from '@/db/types'
import { normalizeForSearch } from '@/lib/text'
import { useEditorStore } from './store'
import type { BlockChange, BlockPatch, EditorCommand, FindMatch, FindOptions } from './types'

/** Fields a command may write (guards against a stray key reaching Dexie). */
const WRITABLE_FIELDS = new Set<string>([
  'translatedText',
  'sourceText',
  'fontFamily',
  'fontSize',
  'fontSizeMode',
  'lineHeight',
  'color',
  'bold',
  'italic',
  'alignment',
  'status',
  'suggestedText',
  'suggestedModel',
  'suggestedAt',
  'overflow',
])

/** The part of a patch that is actually persisted. */
export function sanitizePatch(patch: BlockPatch): BlockPatch {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (WRITABLE_FIELDS.has(key)) out[key] = value
  }
  return out as BlockPatch
}

/** Pure patch application — used by tests and by optimistic UI updates. */
export function applyPatch(block: BlockRecord, patch: BlockPatch): BlockRecord {
  return { ...block, ...sanitizePatch(patch) }
}

interface Target {
  block: BlockRecord
  pageIndex: number
  patch: BlockPatch
}

/** Builds a command from "current value" pairs, deriving the inverse side. */
export function commandFrom(
  labelKey: string,
  action: EditorCommand['action'],
  targets: Target[],
  actor?: string,
): EditorCommand {
  const changes: BlockChange[] = []
  for (const { block, pageIndex, patch } of targets) {
    const after = sanitizePatch(patch)
    if (Object.keys(after).length === 0) continue
    const current = block as unknown as Record<string, unknown>
    const before = Object.fromEntries(
      Object.keys(after).map((key) => [key, current[key]]),
    ) as BlockPatch
    changes.push({ blockId: block.id, pageIndex, before, after })
  }

  return {
    id: `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    labelKey,
    changes,
    action,
    ...(actor ? { actor } : {}),
  }
}

/** The command that undoes `cmd` (same label, mirrored patches). */
export function invertCommand(cmd: EditorCommand): EditorCommand {
  return {
    ...cmd,
    changes: cmd.changes.map((change) => ({
      ...change,
      before: change.after,
      after: change.before,
    })),
  }
}

/** Two commands touching the same blocks cannot be interleaved by undo. */
export function conflicts(a: EditorCommand, b: EditorCommand): boolean {
  const ids = new Set(a.changes.map((change) => change.blockId))
  return b.changes.some((change) => ids.has(change.blockId))
}

async function writeSide(changes: BlockChange[], side: 'before' | 'after'): Promise<void> {
  for (const change of changes) {
    const patch = sanitizePatch(change[side])
    if (Object.keys(patch).length === 0) continue
    await blockRepo.update(change.blockId, patch)
  }
}

/**
 * Applies a command, writes its history rows and pushes it onto the undo
 * stack. This is the single entry point every editor action goes through, so
 * auto-save (the Dexie write) and undo availability are automatic.
 */
export async function commitCommand(cmd: EditorCommand): Promise<void> {
  if (cmd.changes.length === 0) return
  await writeSide(cmd.changes, 'after')

  const store = useEditorStore.getState()
  const actor = cmd.actor ?? 'user'
  const projectId = store.projectId ?? ''
  for (const change of cmd.changes) {
    await revisionRepo.record({
      projectId,
      blockId: change.blockId,
      pageIndex: change.pageIndex,
      action: cmd.action,
      before: change.before,
      after: change.after,
      actor,
      note: cmd.labelKey,
    })
  }

  store.push(cmd)
}

/** Re-applies the `after` side of a command (redo). */
export async function redoCommand(cmd: EditorCommand): Promise<void> {
  await writeSide(cmd.changes, 'after')
}

/** Re-applies the `before` side of a command (undo). */
export async function undoCommand(cmd: EditorCommand): Promise<void> {
  await writeSide(cmd.changes, 'before')
}

/* ------------------------------------------------------------------ */
/* Find & replace                                                      */
/* ------------------------------------------------------------------ */

const WORD_CHAR = /[\p{L}\p{N}_]/u

function offsetsOf(text: string, options: FindOptions): number[] {
  const query = options.query
  if (query.length === 0) return []
  const haystack = options.caseSensitive ? text : text.toLowerCase()
  const needle = options.caseSensitive ? query : query.toLowerCase()
  const offsets: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    const end = at + needle.length
    const beforeOk = !options.wholeWord || at === 0 || !WORD_CHAR.test(text[at - 1])
    const afterOk = !options.wholeWord || end >= text.length || !WORD_CHAR.test(text[end])
    if (beforeOk && afterOk) offsets.push(at)
    from = at + Math.max(1, needle.length)
  }
  return offsets
}

/** A block plus the page it sits on (find works on a page-annotated list). */
export type IndexedBlock = BlockRecord & { pageIndex: number }

/** All occurrences of `options.query`, in page/block reading order. */
export function findMatches(blocks: IndexedBlock[], options: FindOptions): FindMatch[] {
  const out: FindMatch[] = []
  for (const block of blocks) {
    for (const field of ['translatedText', 'sourceText'] as const) {
      const text = block[field]
      if (text.length === 0) continue
      for (const start of offsetsOf(text, options)) {
        const from = Math.max(0, start - 24)
        const to = Math.min(text.length, start + options.query.length + 24)
        out.push({
          blockId: block.id,
          pageIndex: block.pageIndex,
          order: block.order,
          start,
          length: options.query.length,
          field,
          preview:
            `${from > 0 ? '…' : ''}${text.slice(from, start)}` +
            `⟦${text.slice(start, start + options.query.length)}⟧` +
            `${text.slice(start + options.query.length, to)}${to < text.length ? '…' : ''}`,
        })
      }
    }
  }
  return out
}

/** Replaces every occurrence in one string, returning the new value. */
export function replaceAllIn(text: string, options: FindOptions): { text: string; count: number } {
  const hits = offsetsOf(text, options)
  if (hits.length === 0) return { text, count: 0 }
  // Right to left so earlier offsets stay valid.
  let out = text
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const start = hits[i]
    out = out.slice(0, start) + options.replacement + out.slice(start + options.query.length)
  }
  return { text: out, count: hits.length }
}

/** Highlights the active match: index of `blockId` in `matches`, if any. */
export function matchIndexOf(matches: FindMatch[], blockId: string): number {
  return matches.findIndex((match) => match.blockId === blockId)
}

/** "Does this text contain the query?" for row highlighting. */
export function matchesQuery(text: string, options: FindOptions): boolean {
  if (options.query.length === 0) return false
  const needle = options.caseSensitive ? options.query : normalizeForSearch(options.query)
  const haystack = options.caseSensitive ? text : normalizeForSearch(text)
  if (!options.wholeWord) return haystack.includes(needle)
  const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = options.caseSensitive ? 'u' : 'iu'
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, flags).test(text)
}
