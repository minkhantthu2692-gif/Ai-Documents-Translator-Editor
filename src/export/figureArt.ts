/**
 * Figure pixels for the formats that embed standalone pictures (Phase 9b).
 *
 * A `FigureRef` on a block is only a box: `src/pdf/figures.ts` decides *which*
 * picture a paragraph owns, and this module turns that box into bytes a
 * builder can hand to `ImageRun`, an EPUB manifest entry or a Markdown image
 * link. Three pieces live here because all three builders must agree on them
 * or the same document would export differently in every format:
 *
 *  - **identity** — `figureKey` names one crop, and the crop rendered in the
 *    analysis worker is looked up by that same key;
 *  - **size** — a figure keeps its printed size (points, at 96 dpi for CSS and
 *    DOCX pixels) and shrinks only when it would overhang the text column;
 *  - **side** — a figure is emitted on the side of its block where it was
 *    painted, so a picture *above* a caption still appears above it.
 *
 * Pure data handling: no DOM, no worker state, safe in Vitest.
 */

import { toBase64 } from '@/fonts'
import { CAPTION_LABEL } from '@/pdf/figures'
import type { BBox } from '@/pdf/stableId'
import type { ExportBlock, ExportDocument } from './types'

/**
 * Widest a figure may be printed, in PDF points. A US-Letter or A4 text column
 * is about 450–480pt once an inch of margin is taken off each side, so this
 * keeps a full-bleed diagram inside the column in both without the builder
 * needing to know the page size.
 */
export const MAX_FIGURE_WIDTH_PT = 480

/** Alt text cap — long enough for a caption, short enough for a screen reader. */
const ALT_LIMIT = 180

/** Stable identity of one figure on one block: `${blockId}#${figureIndex}`. */
export function figureKey(blockId: string, index: number): string {
  return `${blockId}#${index}`
}

/** One crop the analysis worker should cut out of a page. */
export interface FigureTarget {
  key: string
  /** 0-based page the crop comes from. */
  pageIndex: number
  bbox: BBox
}

/**
 * Every figure in the document, in page order and then in block order, keyed
 * so a builder can find it again while walking the same blocks.
 */
export function figureTargets(doc: ExportDocument): FigureTarget[] {
  const out: FigureTarget[] = []
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      block.figures.forEach((figure, index) => {
        out.push({ key: figureKey(block.id, index), pageIndex: page.index, bbox: figure.bbox })
      })
    }
  }
  return out
}

/** Pages that carry at least one figure, in ascending order. */
export function figurePages(doc: ExportDocument): number[] {
  const pages = new Set<number>()
  for (const target of figureTargets(doc)) pages.add(target.pageIndex)
  return [...pages].sort((a, b) => a - b)
}

/** A cropped figure, ready for a builder to embed. */
export interface FigureArt {
  key: string
  /** PNG bytes exactly as the worker encoded them. */
  bytes: Uint8Array
  /** The same bytes as a data URI, for the formats that inline images. */
  dataUrl: string
}

/**
 * Turns the crops the analysis worker returned into embeddable art. A crop
 * that came back empty is dropped rather than embedded as a zero-byte file —
 * an export loses one picture instead of producing a document that a reader
 * refuses to open.
 */
export async function loadFigureArt(
  crops: readonly { key: string; blob: Blob }[],
): Promise<FigureArt[]> {
  const out: FigureArt[] = []
  for (const crop of crops) {
    const bytes = await blobBytes(crop.blob)
    if (bytes.byteLength === 0) continue
    out.push({
      key: crop.key,
      bytes,
      dataUrl: `data:image/png;base64,${toBase64(bytes.buffer as ArrayBuffer)}`,
    })
  }
  return out
}

/**
 * `Blob` → bytes. `arrayBuffer()` is missing on older Safari and on the jsdom
 * build Vitest runs under, and `FileReader` is the same bytes on both — the
 * fallback is not a nicety, it is the only path in the test suite.
 */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer())
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('figure crop could not be read'))
    reader.readAsArrayBuffer(blob)
  })
}

/** Key → art, so a builder's per-block lookup stays O(1). */
export function figureArtMap(figures: readonly FigureArt[] | undefined): Map<string, FigureArt> {
  const out = new Map<string, FigureArt>()
  for (const art of figures ?? []) out.set(art.key, art)
  return out
}

export interface FigureSize {
  /** Print width in PDF points, already clamped to the column. */
  widthPt: number
  heightPt: number
  /** The same size in CSS pixels (96 dpi) — what DOCX and CSS ask for. */
  widthPx: number
  heightPx: number
}

/**
 * The size to display a figure at, in points and in CSS pixels.
 *
 * A picture keeps the size it had on the page; only an over-wide one shrinks,
 * and it shrinks proportionally so a chart never becomes a stretched strip.
 */
export function figureSize(bbox: BBox, maxWidthPt: number = MAX_FIGURE_WIDTH_PT): FigureSize {
  const natural = Math.max(1, bbox.w)
  const widthPt = Math.max(1, Math.min(natural, Math.max(24, maxWidthPt)))
  const heightPt = Math.max(1, bbox.h * (widthPt / natural))
  return {
    widthPt: round2(widthPt),
    heightPt: round2(heightPt),
    widthPx: Math.max(1, Math.round(widthPt * (96 / 72))),
    heightPx: Math.max(1, Math.round(heightPt * (96 / 72))),
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Which side of its block a figure belongs on.
 *
 * `anchorFigures` pairs a picture with the text nearest to it, and that text
 * can sit either side: a labelled caption below the picture, or — when there
 * is no caption at all — the first paragraph after it. Emitting every figure
 * in the same place would move half of them across their own text, so the
 * builder compares midpoints. A picture printed straight through a headline
 * (a title over a chart) still lands above it, which is where it reads best.
 */
export function figureGoesBefore(block: ExportBlock, bbox: BBox): boolean {
  return bbox.y + bbox.h / 2 <= block.y + block.height / 2
}

/**
 * Alt text for a figure.
 *
 * Only a captioned figure has words of its own — the block that owns it *is*
 * the caption, so its text can be reused. Anything else gets an empty alt,
 * which is the correct signal that a picture carries no information the
 * surrounding text does not already give. (`FigureRef` deliberately holds no
 * caption of its own; see `src/pdf/figures.ts`.)
 */
export function figureAlt(block: ExportBlock): string {
  const text = block.sourceText.trim()
  if (!CAPTION_LABEL.test(text)) return ''
  return text.length > ALT_LIMIT ? `${text.slice(0, ALT_LIMIT - 1)}…` : text
}
