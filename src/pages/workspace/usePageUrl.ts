/**
 * Page artwork for the split view (Phase 4).
 *
 * Both panes are backed by a rendered page: `thumbnail` for the original
 * (the PDF as it looks today) and `background` for the translated pane (the
 * artwork with the original text erased, ready for our own text on top).
 *
 * Requests go through the analysis worker and the shared object-URL LRU, and
 * are cancelled when a row leaves the virtualised window — scrolling a
 * 300-page document must not queue 300 renders.
 */

import { useEffect, useState } from 'react'
import { analysisClient } from '@/pdf/analysisClient'
import { ensureProjectDocument } from '@/pdf/projectAnalysis'
import { getCachedUrl, putCachedUrl, renderCacheKey } from '@/pdf/renderCache'

/**
 * Page points → pixels for the pane artwork. Fixed (not tied to the zoom) so
 * one render serves every zoom level — the text layer is DOM text and stays
 * crisp regardless; only the graphics scale.
 */
export const PAGE_IMAGE_SCALE = 1.5

export type PageImageMode = 'thumbnail' | 'background'

/** Opens the project's source PDF once and hands back its worker file id. */
export function useProjectFileId(projectId: string | null): string | null {
  const [fileId, setFileId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!projectId) {
      setFileId(null)
      return undefined
    }
    ensureProjectDocument(projectId)
      .then((opened) => {
        if (alive) setFileId(opened.fileId)
      })
      .catch(() => {
        if (alive) setFileId(null)
      })
    return () => {
      alive = false
    }
  }, [projectId])

  return fileId
}

/** Object URL for one rendered page, fetched on demand and cancellable. */
export function usePageUrl(
  fileId: string | null,
  pageIndex: number,
  mode: PageImageMode,
): string | null {
  const key = fileId ? renderCacheKey(fileId, pageIndex, mode, PAGE_IMAGE_SCALE) : null
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!fileId || !key) {
      setUrl(null)
      return undefined
    }
    const cached = getCachedUrl(key)
    if (cached) {
      setUrl(cached)
      return undefined
    }

    let settled = false
    let alive = true
    analysisClient
      .render(fileId, pageIndex, PAGE_IMAGE_SCALE, mode)
      .then((blob) => {
        settled = true
        const next = putCachedUrl(key, blob)
        if (alive) setUrl(next)
      })
      .catch(() => {
        settled = true
      })

    return () => {
      alive = false
      if (!settled) analysisClient.cancelRender(fileId, pageIndex)
    }
  }, [fileId, key, pageIndex, mode])

  return url
}
