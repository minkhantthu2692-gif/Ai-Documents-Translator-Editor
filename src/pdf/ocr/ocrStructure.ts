/**
 * OCR result → the same `PageBlock[]` the text path produces.
 *
 * tesseract reports line boxes in **pixels of the rendered image** (top-left
 * origin); the structure pass works in **page points** (also top-left). The
 * conversion divides by the render scale and re-enters the ordinary pipeline
 * through `groupItemsIntoLines` — one synthetic text item per OCR line — so
 * OCR text inherits heading detection, skip rules, list markers, margins and
 * reading order for free. `forceStyle` (added exactly for this) labels the
 * result `OCR` instead of inventing font names.
 *
 * "Hybrid" mixed pages are resolved here too: the OCR-derived blocks are
 * merged with the text-layer blocks, dropping any OCR block that mostly
 * overlaps text we already extracted (that's just the recogniser re-reading
 * the page's own type).
 */

import { ensureUnicode } from '@/core/zawgyi'
import type { OcrLine, OcrPageData } from '@/ocr/ocrTypes'
import { groupItemsIntoLines, type GroupedLine, type TextItemLike } from '../lineGrouping'
import { lineId } from '../stableId'
import { structurePage, type PageBlock, type StructureOptions } from '../structure'

/** Lines the recogniser is this sure about (0..100) before we keep them. */
export const OCR_MIN_CONFIDENCE = 35

export interface OcrStructureOptions {
  pageIndex: number
  /** Page width in points **as rendered** (rotation-adjusted). */
  pageWidth: number
  /** Page height in points **as rendered** (rotation-adjusted). */
  pageHeight: number
  /** Render scale used for recognition (pixels per point). */
  scale: number
  ctx?: StructureOptions['ctx']
  headerTexts?: Iterable<string>
  footerTexts?: Iterable<string>
  /** Convert Zawgyi-encoded OCR output to Unicode first. */
  convertZawgyi?: boolean
  /** Drop lines below this confidence (default `OCR_MIN_CONFIDENCE`). */
  minConfidence?: number
}

export interface OcrPageContent {
  blocks: PageBlock[]
  lineCount: number
  charCount: number
}

/** Flattens tesseract's block tree into lines, low-confidence noise dropped. */
export function ocrLines(data: OcrPageData | null, minConfidence = OCR_MIN_CONFIDENCE): OcrLine[] {
  const lines: OcrLine[] = []
  for (const block of data?.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        if (typeof line?.text !== 'string') continue
        if (line.text.trim().length === 0) continue
        if (typeof line.confidence === 'number' && line.confidence < minConfidence) continue
        if (!line.bbox) continue
        const { x0, y0, x1, y1 } = line.bbox
        if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) continue
        if (x1 - x0 <= 0 || y1 - y0 <= 0) continue
        lines.push(line)
      }
    }
  }
  return lines
}

/**
 * One synthetic text item per OCR line: pixel box → page points, with the
 * baseline placed so `groupItemsIntoLines`' top-left conversion round-trips
 * exactly (`y = pageHeight − baselineY − height`).
 */
export function ocrItems(lines: OcrLine[], options: OcrStructureOptions): TextItemLike[] {
  const scale = options.scale > 0 ? options.scale : 1
  return lines.map((line) => {
    const x = line.bbox.x0 / scale
    const yTop = line.bbox.y0 / scale
    const width = (line.bbox.x1 - line.bbox.x0) / scale
    const height = (line.bbox.y1 - line.bbox.y0) / scale
    return {
      str: line.text,
      // [a b c d e f]: unit axes, origin at the baseline (= box bottom).
      transform: [1, 0, 0, height, x, options.pageHeight - yTop - height],
      width,
      height,
    }
  })
}

/** OCR pixels → grouped lines in page points, ready for `structurePage`. */
export function ocrToLines(data: OcrPageData | null, options: OcrStructureOptions): GroupedLine[] {
  const items = ocrItems(ocrLines(data, options.minConfidence), options)
  const grouped = groupItemsIntoLines(items, {
    pageIndex: options.pageIndex,
    pageHeight: options.pageHeight,
    forceStyle: { fontFamily: 'OCR', color: '#000000' },
  })
  if (!options.convertZawgyi) return grouped
  return grouped.map((line) => {
    const repaired = ensureUnicode(line.text)
    if (!repaired.converted) return line
    return {
      ...line,
      text: repaired.text,
      id: lineId(options.pageIndex, line.bbox, repaired.text),
    }
  })
}

/** Full OCR page → ordered blocks, through the ordinary structure pass. */
export function ocrToBlocks(
  data: OcrPageData | null,
  options: OcrStructureOptions,
): OcrPageContent {
  const lines = ocrToLines(data, options)
  const blocks = structurePage(lines, {
    pageIndex: options.pageIndex,
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    ctx: options.ctx,
    headerTexts: new Set(options.headerTexts ?? []),
    footerTexts: new Set(options.footerTexts ?? []),
  })
  return {
    blocks,
    lineCount: lines.length,
    charCount: lines.reduce((sum, line) => sum + line.text.replace(/\s+/g, '').length, 0),
  }
}

/** Fraction of the smaller box that the two boxes share. */
function overlapRatio(a: PageBlock['bbox'], b: PageBlock['bbox']): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const intersection = w * h
  const smallest = Math.min(a.w * a.h, b.w * b.h)
  return smallest > 0 ? intersection / smallest : 0
}

/**
 * Hybrid pages: keep the text layer authoritative and append the OCR blocks
 * that cover genuinely different areas (captions, diagram labels, figures),
 * re-numbering the combined reading order.
 */
export function mergeOcrBlocks(textBlocks: PageBlock[], ocrBlocks: PageBlock[]): PageBlock[] {
  if (ocrBlocks.length === 0) return textBlocks
  if (textBlocks.length === 0) return ocrBlocks
  const kept = ocrBlocks.filter(
    (block) => !textBlocks.some((text) => overlapRatio(text.bbox, block.bbox) >= 0.5),
  )
  return [...textBlocks, ...kept].map((block, order) => ({ ...block, order }))
}
