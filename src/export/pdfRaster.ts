/**
 * Raster PDF builder (Phase 4).
 *
 * The *other* PDF path: every page becomes one full-bleed image — the page
 * artwork with the translation painted on top — embedded in a PDF whose sheet
 * is the original page size. Layout is therefore exact: no font substitution,
 * no shaping differences, no reflow, and no dialog to confirm (it downloads
 * straight away). The cost is a document with **no text layer**: nothing is
 * selectable, searchable or copyable. The Export dialog states exactly this
 * trade-off next to the print-to-PDF option.
 */

import { PDFDocument } from 'pdf-lib'
import { compositePage } from './composite'
import type { ExportDocument, ExportOptions } from './types'

export interface RasterImage {
  /** 0-based page index of the rendered *background*. */
  index: number
  blob: Blob
}

export interface RasterPdfOptions {
  /** Pixels per PDF point (from `ExportOptions.imageScale`). */
  scale: number
  fontStack: string
  /** JPEG encoder quality for the composited sheets. */
  quality?: number
  /** Called after each page is embedded (progress). */
  onPage?: (done: number, total: number) => void
}

export class RasterPdfError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RasterPdfError'
    this.code = code
  }
}

/**
 * Whether the caller managed to render the page artwork. Exporters report a
 * partial render as a warning rather than failing: a page without artwork is
 * still a page with the translation on it.
 */
export function missingArtwork(doc: ExportDocument, backgrounds: RasterImage[]): number {
  const have = new Set(backgrounds.map((entry) => entry.index))
  return doc.pages.filter((page) => !have.has(page.index)).length
}

export function rasterOptionsFrom(options: ExportOptions): Omit<RasterPdfOptions, 'onPage'> {
  return {
    scale: options.imageScale,
    fontStack: options.fontStack,
    quality: 0.92,
  }
}

/**
 * Builds the PDF. Pages whose background failed to render become a plain
 * white sheet with the text, so page numbers always match the document.
 */
export async function buildRasterPdf(
  doc: ExportDocument,
  backgrounds: RasterImage[],
  options: RasterPdfOptions,
): Promise<Uint8Array> {
  if (doc.pages.length === 0) throw new RasterPdfError('RASTER_EMPTY', 'document has no pages')

  const byIndex = new Map(backgrounds.map((entry) => [entry.index, entry.blob]))
  const pdf = await PDFDocument.create()
  pdf.setTitle(doc.title || doc.sourceFileName || 'Document')
  pdf.setProducer('AI Documents Translator')
  pdf.setCreator('AI Documents Translator')
  pdf.setCreationDate(new Date(doc.exportedAt))

  let done = 0
  const total = doc.pages.length
  for (const page of doc.pages) {
    const sheet = await compositePage(page, byIndex.get(page.index) ?? null, {
      scale: options.scale,
      fontStack: options.fontStack,
      type: 'image/jpeg',
      quality: options.quality ?? 0.92,
    })
    const embedded = await pdf.embedJpg(await sheet.arrayBuffer())
    const pageRef = pdf.addPage([page.width, page.height])
    pageRef.drawImage(embedded, { x: 0, y: 0, width: page.width, height: page.height })
    done += 1
    options.onPage?.(done, total)
  }

  return pdf.save()
}
