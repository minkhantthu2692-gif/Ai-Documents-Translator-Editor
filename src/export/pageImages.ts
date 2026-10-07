/**
 * Page image rendering for export (Phase 4).
 *
 * Renders the *background* of every page (graphics and figures with the text
 * masked out) through the analysis worker, so the export can put real page
 * art behind the absolutely positioned translation. Rendering happens off the
 * main thread already; this module only staggers the requests so 300 pages
 * stay responsive.
 */

import { analysisClient } from '@/pdf/analysisClient'
import { ensureProjectDocument } from '@/pdf/projectAnalysis'

export interface RenderedImage {
  /** 0-based page index. */
  index: number
  blob: Blob
}

export interface RenderImagesOptions {
  projectId: string
  /** 0-based page indexes to render. */
  pageIndexes: number[]
  /** PDF points → canvas pixels (2 ≈ 144 dpi). */
  scale: number
  /** `background` erases the text layer, `thumbnail` keeps everything. */
  mode?: 'background' | 'thumbnail'
  /** Parallel requests against the analysis worker. */
  concurrency?: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Renders pages and returns them in index order. A page that fails (locked
 * document, cancelled render) is skipped rather than failing the export —
 * text is always more important than artwork.
 */
export async function renderPageImages(options: RenderImagesOptions): Promise<RenderedImage[]> {
  const total = options.pageIndexes.length
  if (total === 0) return []

  let fileId: string
  try {
    const opened = await ensureProjectDocument(options.projectId)
    fileId = opened.fileId
  } catch {
    options.onProgress?.(total, total)
    return []
  }

  const mode = options.mode ?? 'background'
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4))
  const results: Array<RenderedImage | null> = new Array(total).fill(null)
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const position = cursor
      cursor += 1
      if (position >= total) return
      if (options.signal?.aborted) return
      const index = options.pageIndexes[position]
      try {
        const blob = await analysisClient.render(fileId, index, options.scale, mode, {
          ...(options.signal ? { signal: options.signal } : {}),
        })
        results[position] = { index, blob }
      } catch {
        results[position] = null
      } finally {
        done += 1
        options.onProgress?.(done, total)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results.filter((entry): entry is RenderedImage => entry !== null)
}

/** Formats whose bytes are made of page images (they cannot skip rendering). */
export function needsImages(format: string): boolean {
  return (
    format === 'images' ||
    format === 'pdf-raster' ||
    format === 'html' ||
    format === 'pdf' ||
    format === 'bilingual-pdf'
  )
}
