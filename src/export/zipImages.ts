/**
 * Per-page image pack (Phase 4).
 *
 * One PNG/JPG per page inside a ZIP, plus a `manifest.json` describing the
 * run — the format people drop straight into a slide deck or an archiving
 * pipeline. Each file is the composited page (artwork + translation), exactly
 * like the raster PDF sheets, so both raster outputs always agree.
 */

import JSZip from 'jszip'
import { compositePage } from './composite'
import type { ExportDocument, ExportImageFormat } from './types'

export interface ImagesZipOptions {
  format: ExportImageFormat
  /** Pixels per PDF point (from `ExportOptions.imageScale`). */
  scale: number
  fontStack: string
  quality?: number
  onFile?: (done: number, total: number) => void
}

export interface ZipImage {
  index: number
  blob: Blob
}

function padWidth(pageCount: number): number {
  return Math.max(3, String(Math.max(1, pageCount)).length)
}

export function pageFileName(index: number, pageCount: number, format: ExportImageFormat): string {
  const digits = padWidth(pageCount)
  return `page-${String(index + 1).padStart(digits, '0')}.${format}`
}

export async function buildImagesZip(
  doc: ExportDocument,
  backgrounds: ZipImage[],
  options: ImagesZipOptions,
): Promise<Uint8Array> {
  const zip = new JSZip()
  const byIndex = new Map(backgrounds.map((entry) => [entry.index, entry.blob]))
  const mime = options.format === 'jpg' ? 'image/jpeg' : 'image/png'
  const pages: Array<{ page: number; file: string; hasArtwork: boolean }> = []

  let done = 0
  const total = doc.pages.length
  for (const page of doc.pages) {
    const background = byIndex.get(page.index) ?? null
    const file = pageFileName(page.index, doc.pages.length, options.format)
    const image = await compositePage(page, background, {
      scale: options.scale,
      fontStack: options.fontStack,
      type: mime,
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
    })
    zip.file(file, image)
    pages.push({ page: page.index + 1, file, hasArtwork: background !== null })
    done += 1
    options.onFile?.(done, total)
  }

  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        title: doc.title,
        sourceFile: doc.sourceFileName,
        sourceLang: doc.sourceLang,
        targetLang: doc.targetLang,
        pageCount: doc.pages.length,
        format: options.format,
        scale: options.scale,
        generatedAt: new Date(doc.exportedAt).toISOString(),
        pages,
      },
      null,
      2,
    ),
  )

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
