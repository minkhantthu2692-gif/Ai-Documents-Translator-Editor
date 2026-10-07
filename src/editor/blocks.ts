/**
 * Editor block loading (Phase 4).
 *
 * The workspace, the find bar and the inspector all need the same thing: the
 * project's blocks annotated with their page index, in reading order, plus a
 * way to turn "apply this patch to those blocks" into the target list
 * `commandFrom` expects. One place, one ordering, one set of rules.
 */

import { blockRepo, pageRepo } from '@/db/repo-content'
import type { IndexedBlock } from './commands'
import type { BlockPatch } from './types'

/** `pageId → 0-based page index`, for revision rows and find results. */
export async function pageIndexMap(projectId: string): Promise<Map<string, number>> {
  const pages = await pageRepo.listByProject(projectId)
  return new Map(
    [...pages]
      .sort((a, b) => a.index - b.index)
      .map((page, position) => [page.id, page.index ?? position]),
  )
}

export interface LoadBlocksOptions {
  /** Restrict to these page indexes (0-based). */
  pageIndexes?: number[]
  /** Restrict to these block ids. */
  blockIds?: string[]
}

/** Every block of the project in reading order, annotated with its page. */
export async function loadEditorBlocks(
  projectId: string,
  options: LoadBlocksOptions = {},
): Promise<IndexedBlock[]> {
  const [blocks, pageOf] = await Promise.all([
    blockRepo.listByProject(projectId),
    pageIndexMap(projectId),
  ])
  const wantedPages = options.pageIndexes ? new Set(options.pageIndexes) : null
  const wantedIds = options.blockIds ? new Set(options.blockIds) : null

  return blocks
    .map((block) => ({ ...block, pageIndex: pageOf.get(block.pageId) ?? 0 }))
    .filter((block) => (wantedPages ? wantedPages.has(block.pageIndex) : true))
    .filter((block) => (wantedIds ? wantedIds.has(block.id) : true))
    .sort((a, b) => a.pageIndex - b.pageIndex || a.order - b.order)
}

/** Block ids the given scope selects (`null` = every loaded block). */
export function idsForScope(
  blocks: IndexedBlock[],
  scope: 'block' | 'page' | 'document',
  options: { selection?: string[]; activePage?: number | null } = {},
): string[] {
  if (scope === 'document') return blocks.map((block) => block.id)
  if (scope === 'page') {
    const page = options.activePage
    if (page === null || page === undefined) return options.selection ?? []
    return blocks.filter((block) => block.pageIndex === page).map((block) => block.id)
  }
  return options.selection ?? []
}

/** Builds the target list for a patch, skipping blocks that already match. */
export function patchTargets(
  blocks: IndexedBlock[],
  ids: string[],
  patchOf: (block: IndexedBlock) => BlockPatch,
): Array<{ block: IndexedBlock; pageIndex: number; patch: BlockPatch }> {
  const wanted = new Set(ids)
  const out: Array<{ block: IndexedBlock; pageIndex: number; patch: BlockPatch }> = []
  for (const block of blocks) {
    if (!wanted.has(block.id)) continue
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patchOf(block))) {
      if ((block as unknown as Record<string, unknown>)[key] !== value) patch[key] = value
    }
    if (Object.keys(patch).length === 0) continue
    out.push({ block, pageIndex: block.pageIndex, patch: patch as BlockPatch })
  }
  return out
}
