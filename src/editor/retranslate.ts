/**
 * Inline re-translation service (Phase 4).
 *
 * The inspector's "re-translate" and "ask for an alternative" buttons and the
 * toolbar's page/selection re-translate all funnel through here. Every result
 * goes through `commitCommand`, so an inline run is undoable, is written to
 * the revision history and auto-saves exactly like a manual edit — and a
 * locked or skipped block is never touched (`loadReTranslatableBlocks`
 * excludes them before the request is even made).
 */

import { blockRepo } from '@/db/repo-content'
import { translateInline, loadReTranslatableBlocks } from '@/translate/inline'
import type { BlockRecord } from '@/db/types'
import { loadEditorBlocks, pageIndexMap } from './blocks'
import { commandFrom, commitCommand } from './commands'
import { textMeasurer } from './autofit'
import { autoFitEnabled, translationLayoutPatch } from './layout'
import { loadTranslateConfig } from './templates'
import type { IndexedBlock } from './commands'
import type { BlockPatch } from './types'

export interface RetranslateOptions {
  projectId: string
  /** Explicit block ids (selection re-translate). */
  blockIds?: string[]
  /** All blocks of one page (page re-translate). */
  pageId?: string
  /** Override the configured model — this is how "alternatives" differ. */
  model?: string
  /** `apply` writes the translation, `suggest` parks it as a suggestion. */
  mode: 'apply' | 'suggest'
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface RetranslateResult {
  /** Blocks whose text changed. */
  changed: number
  /** Blocks skipped (locked, skipped, empty source, no permission to touch). */
  skipped: number
  model: string
  requests: number
}

function pageIndexFor(block: BlockRecord, pageOf: Map<string, number>): number {
  return pageOf.get(block.pageId) ?? 0
}

/**
 * Runs an inline translation and persists it as one undoable command.
 * Returns `changed: 0` without calling the model when nothing is eligible.
 */
export async function retranslate(options: RetranslateOptions): Promise<RetranslateResult> {
  const eligible = await loadReTranslatableBlocks(options.projectId, {
    ...(options.pageId ? { pageId: options.pageId } : {}),
    ...(options.blockIds ? { blockIds: options.blockIds } : {}),
  })
  const requested = options.blockIds?.length ?? (options.pageId ? 1 : 0)
  if (eligible.length === 0) {
    return { changed: 0, skipped: requested, model: options.model ?? '', requests: 0 }
  }

  const base = await loadTranslateConfig(options.projectId)
  const config = options.model ? { ...base, model: options.model } : base
  const pageOf = await pageIndexMap(options.projectId)
  const byId = new Map(eligible.map((block) => [block.id, block]))

  const result = await translateInline({
    projectId: options.projectId,
    config,
    blocks: eligible,
    pageIndexOf: (block) => pageIndexFor(block, pageOf),
    writeTm: options.mode === 'apply',
    onProgress: options.onProgress,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const now = Date.now()
  // Only the applied translation changes the layout — a suggestion parked in
  // the inspector has not been put on the page yet.
  const measure = options.mode === 'apply' && (await autoFitEnabled()) ? textMeasurer() : null
  const targets: Array<{ block: BlockRecord; pageIndex: number; patch: BlockPatch }> = []
  for (const line of result.lines) {
    const block = byId.get(line.id)
    if (!block) continue
    if (options.mode === 'apply') {
      if (block.translatedText === line.text) continue
      const patch: BlockPatch = {
        translatedText: line.text,
        status: 'edited',
        suggestedText: null,
        suggestedModel: null,
        suggestedAt: null,
      }
      // Same command, same undo step: the re-fit travels with the text that
      // caused it instead of landing as a second entry in History.
      if (measure) {
        const fit = translationLayoutPatch(block, line.text, measure)
        if (fit) Object.assign(patch, fit)
      }
      targets.push({
        block,
        pageIndex: pageIndexFor(block, pageOf),
        patch,
      })
    } else {
      if (block.suggestedText === line.text) continue
      targets.push({
        block,
        pageIndex: pageIndexFor(block, pageOf),
        patch: {
          suggestedText: line.text,
          suggestedModel: result.model,
          suggestedAt: now,
        },
      })
    }
  }

  if (targets.length > 0) {
    const action = options.mode === 'apply' ? 'retranslate' : 'suggest'
    await commitCommand(
      commandFrom(
        options.mode === 'apply' ? 'editor.cmd.retranslate' : 'editor.cmd.suggest',
        action,
        targets,
        result.model,
      ),
    )
  }

  return {
    changed: targets.length,
    skipped: Math.max(0, requested - eligible.length),
    model: result.model,
    requests: result.requests,
  }
}

/** Moves `suggestedText` into `translatedText` (undoable). */
export async function acceptSuggestion(
  projectId: string,
  blockId: string,
): Promise<{ accepted: boolean }> {
  const [block, pageOf] = await Promise.all([blockRepo.get(blockId), pageIndexMap(projectId)])
  if (!block || block.suggestedText === null) return { accepted: false }
  const suggested = block.suggestedText
  const patch: BlockPatch = {
    translatedText: suggested,
    status: 'edited',
    suggestedText: null,
    suggestedModel: null,
    suggestedAt: null,
  }
  if (await autoFitEnabled()) {
    const fit = translationLayoutPatch(block, suggested, textMeasurer())
    if (fit) Object.assign(patch, fit)
  }
  await commitCommand(
    commandFrom(
      'editor.cmd.accept',
      'accept-suggestion',
      [{ block, pageIndex: pageOf.get(block.pageId) ?? 0, patch }],
      'user',
    ),
  )
  return { accepted: true }
}

/** Discards a pending suggestion without touching the translation. */
export async function rejectSuggestion(
  projectId: string,
  blockId: string,
): Promise<{ rejected: boolean }> {
  const [block, pageOf] = await Promise.all([blockRepo.get(blockId), pageIndexMap(projectId)])
  if (!block || block.suggestedText === null) return { rejected: false }
  await commitCommand(
    commandFrom(
      'editor.cmd.reject',
      'reject-suggestion',
      [
        {
          block,
          pageIndex: pageOf.get(block.pageId) ?? 0,
          patch: { suggestedText: null, suggestedModel: null, suggestedAt: null },
        },
      ],
      'user',
    ),
  )
  return { rejected: true }
}

/** Locks/unlocks a block (a locked block is excluded from re-translation). */
export async function setBlockLock(
  projectId: string,
  blockId: string,
  locked: boolean,
): Promise<void> {
  const [block, pageOf] = await Promise.all([blockRepo.get(blockId), pageIndexMap(projectId)])
  if (!block) return
  const next = locked ? 'locked' : 'edited'
  if (block.status === next) return
  await commitCommand(
    commandFrom(
      locked ? 'editor.cmd.lock' : 'editor.cmd.unlock',
      locked ? 'lock' : 'unlock',
      [{ block, pageIndex: pageOf.get(block.pageId) ?? 0, patch: { status: next } }],
      'user',
    ),
  )
}

/** Loads the active block with its page index (the inspector's data source). */
export async function loadBlock(
  projectId: string,
  blockId: string,
): Promise<IndexedBlock | undefined> {
  const blocks = await loadEditorBlocks(projectId, { blockIds: [blockId] })
  return blocks[0]
}
