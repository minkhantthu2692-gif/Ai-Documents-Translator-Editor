/**
 * Layout complexity analysis feeding page classification.
 *
 * A page with a usable text layer is still hard to translate when it is not
 * one column of paragraphs: newspapers, magazines, slides, sidebars, rotated
 * text and watermarks all break reading order. This module scores those
 * signals so `classifyPage()` can flag the page `complex` — the class keeps
 * the text-extraction method but tells the pipeline that structure needs care.
 *
 * Pure functions: `probeDocument` feeds them grouped lines, tests feed
 * literals.
 */

import { medianFontSize, type GroupedLine, type TextItemLike } from './lineGrouping'
import { countColumns, looksLikeTableRow } from './structure'
import type { BBox } from './stableId'

export type ComplexityReason =
  /** Three or more text columns (newspaper, magazine). */
  | 'columns3'
  /** Exactly two text columns (academic paper — mild). */
  | 'multicolumn'
  /** Text boxes stacked on top of each other (sidebars, watermarks). */
  | 'overlap'
  /** Text drawn at an angle, or the whole page rotated. */
  | 'rotation'
  /** Several aligned-cell rows (tables). */
  | 'tables'
  /** Huge headings vs body text (slides, brochures). */
  | 'size-spread'
  /** Image-heavy page (figures, diagrams, charts). */
  | 'images'

export interface LayoutSignals {
  /** Text columns detected on the page (1..MAX_COLUMNS). */
  columns: number
  /** Share of lines whose box overlaps another line's box, 0..1. */
  overlapRatio: number
  /** Share of lines drawn at a non-horizontal angle, 0..1. */
  rotatedLineRatio: number
  /** Page-level /Rotate value in degrees (0 for upright pages). */
  pageRotation: number
  /** Lines matching the aligned-cells table pattern. */
  tableRowCount: number
  /** Largest font size ÷ median font size on the page. */
  sizeRatio: number
  /** Painted image operations on the page. */
  imageCount: number
}

export interface LayoutComplexity {
  /** 0..1 weighted score, rounded to two decimals. */
  score: number
  /** Reasons that raised the score, in descending weight order. */
  reasons: ComplexityReason[]
  /** True when the score reaches the complex-layout threshold. */
  complex: boolean
}

/** A text-bearing page at or above this score is classified `complex`. */
export const COMPLEX_THRESHOLD = 0.45
/** A line pair counts as overlapping when the intersection covers this share of the smaller box. */
export const OVERLAP_PAIR_SHARE = 0.15
/** …and overlap only counts once this share of the page's lines is involved. */
export const OVERLAP_MIN_RATIO = 0.12
/** Rotated text only counts once a quarter of the page's lines are angled. */
export const ROTATED_MIN_RATIO = 0.25
/** Table-like rows needed to raise the tables reason. */
export const TABLE_MIN_ROWS = 4
/** Largest ÷ median font size needed to raise the size-spread reason. */
export const SIZE_SPREAD_MIN = 3
/** Images needed to raise the images reason. */
export const IMAGE_MIN_COUNT = 4
/** Column detection cap (structure keeps its two-way reading-order split). */
export const MAX_COLUMNS = 4

const WEIGHTS = {
  columns3: 0.5,
  overlap: 0.45,
  rotation: 0.3,
  rotationPageOnly: 0.1,
  'size-spread': 0.15,
  multicolumn: 0.1,
  tables: 0.1,
  images: 0.1,
} as const

/** Page rotation in [0, 360). */
function normalizeRotation(degrees: number): number {
  const normalised = degrees % 360
  return normalised < 0 ? normalised + 360 : normalised
}

/**
 * Weights the layout signals into a 0..1 score with the reasons that raised
 * it. Reasons are collected in descending weight order so output is stable.
 */
export function scoreLayout(signal: LayoutSignals): LayoutComplexity {
  const reasons: ComplexityReason[] = []
  let score = 0
  const add = (reason: ComplexityReason, weight: number): void => {
    score += weight
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (signal.columns >= 3) add('columns3', WEIGHTS.columns3)
  else if (signal.columns === 2) add('multicolumn', WEIGHTS.multicolumn)

  if (signal.overlapRatio >= OVERLAP_MIN_RATIO) add('overlap', WEIGHTS.overlap)

  if (signal.rotatedLineRatio >= ROTATED_MIN_RATIO) add('rotation', WEIGHTS.rotation)
  else if (normalizeRotation(signal.pageRotation) !== 0) add('rotation', WEIGHTS.rotationPageOnly)

  if (signal.sizeRatio >= SIZE_SPREAD_MIN) add('size-spread', WEIGHTS['size-spread'])
  if (signal.tableRowCount >= TABLE_MIN_ROWS) add('tables', WEIGHTS.tables)
  if (signal.imageCount >= IMAGE_MIN_COUNT) add('images', WEIGHTS.images)

  return {
    score: Math.round(Math.min(1, score) * 100) / 100,
    reasons,
    complex: score >= COMPLEX_THRESHOLD,
  }
}

/**
 * Share of lines whose bounding box overlaps another line's box by at least
 * `OVERLAP_PAIR_SHARE` of the smaller box. Normal paragraph flow never
 * overlaps; stacked text boxes, watermarks and angled text do.
 */
export function overlapRatioOf(lines: Array<{ bbox: BBox }>): number {
  if (lines.length < 2) return 0
  const involved = new Set<number>()
  for (let i = 0; i < lines.length - 1; i += 1) {
    const a = lines[i].bbox
    if (a.w <= 0 || a.h <= 0) continue
    const areaA = a.w * a.h
    for (let j = i + 1; j < lines.length; j += 1) {
      const b = lines[j].bbox
      if (b.w <= 0 || b.h <= 0) continue
      const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      if (width <= 0) continue
      const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (height <= 0) continue
      const areaB = b.w * b.h
      const smaller = Math.min(areaA, areaB)
      if (smaller > 0 && width * height >= smaller * OVERLAP_PAIR_SHARE) {
        involved.add(i)
        involved.add(j)
      }
    }
  }
  return involved.size / lines.length
}

/* ------------------------------------------------------------------ */
/* Column detection from raw text runs                                 */
/*                                                                     */
/* Line clustering merges same-baseline runs across column gutters     */
/* (tables rely on that merge), so line-based detection cannot see the */
/* columns of a real multi-column page. The probe therefore detects    */
/* gutters on the raw run boxes instead: an x-band that (almost) no    */
/* run crosses, with text on both sides — headers and watermarks that  */
/* bridge a gutter are tolerated as a small minority of "crossers".    */
/* ------------------------------------------------------------------ */

/** Horizontal extent of one text run. */
export interface ItemBox {
  x: number
  w: number
}

/** Runs needed on a page before a column split is believable. */
export const MIN_COLUMN_ITEMS = 8

/** Axis-aligned x-extent of each pdf.js text run (rotated runs included). */
export function itemBoxesOf(items: TextItemLike[]): ItemBox[] {
  const boxes: ItemBox[] = []
  for (const item of items) {
    const [a, b, c, d, e] = item.transform ?? []
    if (![a, b, c, d, e].every((value) => Number.isFinite(value))) continue
    const horizontal = Math.hypot(a, b) || 1
    const vertical = Math.hypot(c, d) || 1
    const u: [number, number] = [a / horizontal, b / horizontal]
    const v: [number, number] = [c / vertical, d / vertical]
    const width = item.width || 0
    const height = item.height || vertical
    let minX = e
    let maxX = e
    for (const cx of [0, width]) {
      for (const cy of [0, height]) {
        const px = u[0] * cx + v[0] * cy + e
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
      }
    }
    if (maxX - minX > 0) boxes.push({ x: minX, w: maxX - minX })
  }
  return boxes
}

interface Gutter {
  /** Centre of the empty band. */
  position: number
  width: number
  /** Runs spanning the band (headers, watermarks) — kept small by design. */
  crossings: number
}

/**
 * Widest low-crossing empty band: sweeps run endpoints and keeps the band
 * with the fewest crossing runs (ties → widest), requiring text on both
 * sides and a gutter at least `max(6pt, 2% of page width)` wide.
 */
function bestItemGutter(boxes: ItemBox[], pageWidth: number): Gutter | null {
  if (boxes.length < MIN_COLUMN_ITEMS) return null
  const minGap = Math.max(6, pageWidth * 0.02)
  type Event = { x: number; open: boolean }
  const events: Event[] = []
  for (const box of boxes) {
    events.push({ x: box.x, open: true })
    events.push({ x: box.x + box.w, open: false })
  }
  // At equal coordinates a closing run must be processed first so touching
  // runs do not count as crossing the band between them.
  events.sort((p, q) => p.x - q.x || Number(p.open) - Number(q.open))

  let active = 0
  let opened = 0
  let closed = 0
  let best: Gutter | null = null
  const maxCrossings = Math.max(2, Math.floor(boxes.length / 10))

  let index = 0
  while (index < events.length) {
    const start = events[index].x
    while (index < events.length && events[index].x === start) {
      if (events[index].open) {
        active += 1
        opened += 1
      } else {
        active -= 1
        closed += 1
      }
      index += 1
    }
    if (index >= events.length) break
    const end = events[index].x
    const width = end - start
    const onLeft = closed
    const onRight = boxes.length - opened
    if (
      width >= minGap &&
      onLeft >= 3 &&
      onRight >= 3 &&
      active <= maxCrossings &&
      (!best || active < best.crossings || (active === best.crossings && width > best.width))
    ) {
      best = { position: start + width / 2, width, crossings: active }
    }
  }
  return best
}

/**
 * Counts text columns (1..maxColumns) from raw run boxes by recursively
 * splitting at the best gutter — the item-level twin of `countColumns`,
 * used at probe time where lines may already have merged across columns.
 * The cap is applied at the end so unbalanced splits cannot undercount.
 */
export function countItemColumns(boxes: ItemBox[], pageWidth: number, maxColumns = 4): number {
  if (maxColumns <= 1 || pageWidth <= 0) return 1
  return Math.min(countItemColumnsRaw(boxes, pageWidth), maxColumns)
}

function countItemColumnsRaw(boxes: ItemBox[], pageWidth: number): number {
  if (boxes.length < MIN_COLUMN_ITEMS) return 1
  const gutter = bestItemGutter(boxes, pageWidth)
  if (!gutter) return 1
  const left: ItemBox[] = []
  const right: ItemBox[] = []
  for (const box of boxes) {
    const target = box.x + box.w / 2 <= gutter.position ? left : right
    target.push(box)
  }
  if (left.length < 3 || right.length < 3) return 1
  return countItemColumnsRaw(left, pageWidth) + countItemColumnsRaw(right, pageWidth)
}

export interface AnalyzeLayoutContext {
  /** Page width in PDF points (column gutters scale with it). */
  pageWidth: number
  /** Page-level rotation in degrees. */
  pageRotation: number
  /** Painted image operations on the page. */
  imageCount: number
  /**
   * Raw text-run boxes from pdf.js — preferred for column detection, since
   * grouped lines may already have merged across column gutters.
   */
  itemBoxes?: ItemBox[]
}

/** Computes the full layout-complexity verdict for one page's lines. */
export function analyzeLayout(lines: GroupedLine[], ctx: AnalyzeLayoutContext): LayoutComplexity {
  const rows = lines.filter((line) => line.text.trim().length > 0)

  const columns = ctx.itemBoxes
    ? countItemColumns(ctx.itemBoxes, ctx.pageWidth, MAX_COLUMNS)
    : countColumns(rows, ctx.pageWidth, MAX_COLUMNS)
  const overlapRatio = overlapRatioOf(rows)

  let rotated = 0
  let tableRowCount = 0
  for (const line of rows) {
    if (Math.abs(line.style.rotation) > 5) rotated += 1
    if (looksLikeTableRow(line)) tableRowCount += 1
  }

  const median = medianFontSize(rows)
  const largest = rows.reduce(
    (max, line) => Math.max(max, Number.isFinite(line.style.fontSize) ? line.style.fontSize : 0),
    0,
  )
  const sizeRatio = median > 0 && largest > 0 ? largest / median : 1

  return scoreLayout({
    columns,
    overlapRatio,
    rotatedLineRatio: rows.length > 0 ? rotated / rows.length : 0,
    pageRotation: ctx.pageRotation,
    tableRowCount,
    sizeRatio,
    imageCount: ctx.imageCount,
  })
}
