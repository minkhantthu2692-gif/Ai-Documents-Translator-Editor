/**
 * Figure crop rendering (Phase 9b).
 *
 * Walks the collected document, asks the analysis worker to cut every figure
 * rectangle out of its page's background render, and returns the crops keyed
 * by `figureKey`. Pages with no figures are never rendered at all, which is
 * the whole point: a 300-page report with four diagrams costs four raster
 * passes, not three hundred.
 *
 * A page that fails is skipped rather than failing the export — the same
 * bargain `renderPageImages` makes. Text is always more important than art.
 */

import { analysisClient } from '@/pdf/analysisClient'
import { ensureProjectDocument } from '@/pdf/projectAnalysis'
import { figureTargets } from './figureArt'
import type { ExportDocument } from './types'

export interface RenderFigureCropsOptions {
  projectId: string
  /** The already-collected document — the figure boxes come from here. */
  doc: ExportDocument
  /** PDF points → canvas pixels, the same scale the page art uses (2 ≈ 144 dpi). */
  scale: number
  /** Parallel page requests against the analysis worker. */
  concurrency?: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Renders every figure-bearing page and returns the crops in document order.
 * An empty array means either "this document has no figures" or "none of them
 * could be rendered" — the caller cannot tell, and does not need to: both
 * produce an export with no embedded pictures.
 */
export async function renderFigureCrops(
  options: RenderFigureCropsOptions,
): Promise<Array<{ key: string; blob: Blob }>> {
  const targets = figureTargets(options.doc)
  if (targets.length === 0) return []

  const byPage = new Map<number, typeof targets>()
  for (const target of targets) {
    const bucket = byPage.get(target.pageIndex)
    if (bucket) bucket.push(target)
    else byPage.set(target.pageIndex, [target])
  }

  let fileId: string
  try {
    const opened = await ensureProjectDocument(options.projectId)
    fileId = opened.fileId
  } catch {
    options.onProgress?.(byPage.size, byPage.size)
    return []
  }

  const pages = [...byPage.keys()]
  const total = pages.length
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4))
  const results: Array<Array<{ key: string; blob: Blob }> | null> = new Array(total).fill(null)
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const position = cursor
      cursor += 1
      if (position >= total) return
      if (options.signal?.aborted) return
      const pageIndex = pages[position]
      const wanted = byPage.get(pageIndex) ?? []
      try {
        const crops = await analysisClient.renderFigures(
          fileId,
          pageIndex,
          options.scale,
          wanted.map((target) => ({ key: target.key, bbox: target.bbox })),
          { ...(options.signal ? { signal: options.signal } : {}) },
        )
        results[position] = crops
      } catch {
        results[position] = null
      } finally {
        done += 1
        options.onProgress?.(done, total)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
    .filter((entry): entry is Array<{ key: string; blob: Blob }> => entry !== null)
    .flat()
}
