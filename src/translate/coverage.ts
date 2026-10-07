/**
 * Coverage report — "1,240/1,240 translated, 3 flagged".
 *
 * Recomputed from Dexie on demand (after a run finishes, and whenever the
 * translate page asks for it), never from the queue's in-memory counters, so
 * it is identical after a refresh. The same scope rules as the plan builder
 * decide what counts: skip rules, locks, user edits and the image switch all
 * have to agree between "what we translate" and "what we report".
 */

import { blockRepo, pageRepo } from '@/db/repo-content'
import type { BlockRecord } from '@/db/types'
import { classifyBlock } from './translateQueue'
import type { CoverageReport, PageCoverage, TranslateRunConfig } from './types'

function groupByPage(blocks: BlockRecord[]): Map<string, BlockRecord[]> {
  const byPage = new Map<string, BlockRecord[]>()
  for (const block of blocks) {
    let list = byPage.get(block.pageId)
    if (!list) {
      list = []
      byPage.set(block.pageId, list)
    }
    list.push(block)
  }
  return byPage
}

/** Builds the report for one project (0..100 quality score over confidence). */
export async function buildCoverage(
  projectId: string,
  config: TranslateRunConfig,
): Promise<CoverageReport> {
  const pages = (await pageRepo.listByProject(projectId)).sort((a, b) => a.index - b.index)
  const blocks = await blockRepo.listByProject(projectId)
  const byPage = groupByPage(blocks)

  const perPage: PageCoverage[] = []
  let translated = 0
  let total = 0
  let flagged = 0
  let scoreSum = 0
  let scored = 0

  for (const page of pages) {
    // Same scope as the queue: with image translation off, OCR pages are out.
    if (!config.translateImages && !page.hasTextLayer) continue

    const pageBlocks = (byPage.get(page.id) ?? []).sort((a, b) => a.order - b.order)
    let onPageTotal = 0
    let onPageTranslated = 0
    let onPageFlagged = 0
    let onPageScore = 0
    let onPageScored = 0

    for (const block of pageBlocks) {
      const kind = classifyBlock(block)
      if (kind === 'skip') continue
      onPageTotal += 1
      if (kind !== 'done') continue

      onPageTranslated += 1
      if (block.translationFlag) {
        onPageFlagged += 1
        flagged += 1
      }
      const confidence = block.translationConfidence
      if (typeof confidence === 'number') {
        onPageScore += confidence
        onPageScored += 1
        scoreSum += confidence
        scored += 1
      }
    }

    if (onPageTotal === 0) continue
    total += onPageTotal
    translated += onPageTranslated
    perPage.push({
      pageIndex: page.index,
      translated: onPageTranslated,
      total: onPageTotal,
      flagged: onPageFlagged,
      score: onPageScored > 0 ? Math.round((onPageScore / onPageScored) * 100) : null,
    })
  }

  return {
    projectId,
    translated,
    total,
    flagged,
    failed: Math.max(0, total - translated),
    qualityScore: scored > 0 ? Math.round((scoreSum / scored) * 100) : 0,
    perPage,
  }
}
