/**
 * Reading order for a page's body lines.
 *
 * The flat line list of a PDF arrives in content-stream order, which is not
 * reading order: a two-column paper, a newspaper spread or a newsletter with a
 * full-width title all interleave badly once lines are naively sorted by y.
 *
 * Two facts drive this module:
 *
 *  1. **Columns must be ordered column-by-column, not row-by-row.** Sorting a
 *     multi-column page top-to-bottom alternates left and right on every line,
 *     which reads as nonsense and translates as nonsense.
 *  2. **A line that spans the gutter belongs to no column.** Titles, section
 *     rules, pull-quotes and full-width paragraphs cross the empty strip
 *     between columns. They are *zone boundaries*: everything above them is
 *     read as one zone, everything below as the next. Treating them as column
 *     members is what previously disabled column detection outright — one
 *     spanning title anywhere on the page and the whole page fell back to
 *     row-by-row order.
 *
 * So the algorithm is: find the gutter and the lines crossing it, cut the page
 * into zones at those spanning lines, and order each zone's column members
 * left-to-right (recursively, so three and four column layouts work).
 *
 * Every line in is returned exactly once — no line may be dropped, reordered
 * into oblivion, or duplicated, because the blocks built from this feed the
 * translator and the exporter. `orderBodyLines` is total: any ambiguity falls
 * back to plain top-to-bottom order rather than an answer that might lose
 * content.
 */

import type { GroupedLine, LineRun } from './lineGrouping'
import { looksLikeTableRow } from './rowSplit'
import { lineId, type BBox } from './stableId'

/** Lines required on *both* sides of a gutter before it is believed. */
const MIN_LINES_PER_SIDE = 3
/** Fewer body lines than this never carry a column layout. */
const MIN_LINES = MIN_LINES_PER_SIDE * 2
/** A column gutter must be at least this wide, in points. */
const MIN_GUTTER = 8
/** Separation the two cluster means must reach, as a fraction of page width. */
const MIN_MEAN_SPREAD = 0.2
/** Lloyd passes before the cluster means are taken as converged. */
const KMEANS_PASSES = 8
/** Further splits a column group may take: 2 → up to four columns. */
const MAX_SPLITS = 2
/** How many times a spanning line may be peeled off before giving up. */
const STRADDLE_PASSES = 3
/** Slack (pt) allowing a line flush with a band edge to still count as inside. */
const EDGE_EPSILON = 1

/** Top-to-bottom, then left-to-right — the fallback order for everything. */
const byReadingOrder = (a: GroupedLine, b: GroupedLine): number =>
  a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x

/** Lines in reading order (page top first, then left to right on a tie). */
export function sortReadingOrder(lines: GroupedLine[]): GroupedLine[] {
  return [...lines].sort(byReadingOrder)
}

function centerX(line: GroupedLine): number {
  return line.bbox.x + line.bbox.w / 2
}

/**
 * Midpoint of the vertical gutter between two clusters of line centres.
 *
 * Two-pass k-means on line centres: seed the means at the outermost centres
 * and alternate until they stop moving. Returns `null` when the means settle
 * closer together than a fifth of the page width (no real column structure)
 * or when one side ends up too small to be a column.
 *
 * Shared with `structure.ts`, whose two-way `detectColumns` and complexity
 * `countColumns` still own their own bridge check — this only locates the
 * midpoint, so there is one k-means in the codebase, not two.
 */
export function kmeansMidpoint(lines: GroupedLine[], pageWidth: number): number | null {
  if (lines.length < MIN_LINES || pageWidth <= 0) return null

  const centers = lines.map(centerX).sort((a, b) => a - b)
  let leftMean = centers[0]
  let rightMean = centers[centers.length - 1]

  for (let pass = 0; pass < KMEANS_PASSES; pass += 1) {
    const left = centers.filter((value) => value <= (leftMean + rightMean) / 2)
    const right = centers.filter((value) => value > (leftMean + rightMean) / 2)
    if (left.length === 0 || right.length === 0) break
    const nextLeft = left.reduce((sum, value) => sum + value, 0) / left.length
    const nextRight = right.reduce((sum, value) => sum + value, 0) / right.length
    if (Math.abs(nextLeft - leftMean) < 0.5 && Math.abs(nextRight - rightMean) < 0.5) {
      leftMean = nextLeft
      rightMean = nextRight
      break
    }
    leftMean = nextLeft
    rightMean = nextRight
  }

  if (rightMean - leftMean < pageWidth * MIN_MEAN_SPREAD) return null
  return (leftMean + rightMean) / 2
}

export interface Band {
  /** Lines entirely to the left of the gutter. */
  left: GroupedLine[]
  /** Lines entirely to the right of the gutter. */
  right: GroupedLine[]
  /** Lines occupying the gutter — titles, rules, full-width paragraphs. */
  spanning: GroupedLine[]
}

/**
 * Splits lines into `left`, `right` and `spanning` around the page's gutter,
 * or returns `null` when there is no clean gutter to speak of.
 *
 * Two things have to be disentangled at once. A full-width title sits *inside*
 * the left cluster by centre, and if its right edge is allowed to stand as the
 * band's left edge then the band lands past the right cluster and no gutter is
 * ever found — one spanning title used to disable column detection for the
 * whole page. Conversely on a three-column page the cluster really does
 * contain the middle column, and its right edge *is* the band.
 *
 * So the band is measured from cluster membership first, and only when the two
 * sides overlap are the offending lines peeled off and the measurement redone.
 * A genuine middle column never overlaps; a title always does.
 *
 * The three parts are disjoint and cover `lines` exactly.
 */
export function findBand(lines: GroupedLine[], pageWidth: number): Band | null {
  if (lines.length < MIN_LINES || pageWidth <= 0) return null
  const midpoint = kmeansMidpoint(lines, pageWidth)
  if (midpoint === null) return null

  let left = lines.filter((line) => centerX(line) <= midpoint)
  let right = lines.filter((line) => centerX(line) > midpoint)
  if (left.length < MIN_LINES_PER_SIDE || right.length < MIN_LINES_PER_SIDE) return null

  for (let attempt = 0; attempt < STRADDLE_PASSES; attempt += 1) {
    if (left.length < MIN_LINES_PER_SIDE || right.length < MIN_LINES_PER_SIDE) return null
    const bandLeft = Math.max(...left.map((line) => line.bbox.x + line.bbox.w))
    const bandRight = Math.min(...right.map((line) => line.bbox.x))

    if (bandRight - bandLeft >= MIN_GUTTER) {
      return partitionByBand(lines, bandLeft, bandRight)
    }

    // The clusters overlap: the culprit is a line reaching across the other
    // side. Peel whichever side owns a *proper* subset of such lines — a side
    // where every line crosses has no gutter to offer and must not be emptied.
    const fromLeft = new Set(left.filter((line) => line.bbox.x + line.bbox.w >= bandRight))
    if (fromLeft.size > 0 && fromLeft.size < left.length) {
      left = left.filter((line) => !fromLeft.has(line))
      continue
    }
    const fromRight = new Set(right.filter((line) => line.bbox.x <= bandLeft))
    if (fromRight.size > 0 && fromRight.size < right.length) {
      right = right.filter((line) => !fromRight.has(line))
      continue
    }
    return null
  }
  return null
}

/** Places every line against a measured band: entirely left, right, or across it. */
function partitionByBand(lines: GroupedLine[], bandLeft: number, bandRight: number): Band | null {
  const isLeft = (line: GroupedLine): boolean =>
    line.bbox.x + line.bbox.w <= bandLeft + EDGE_EPSILON
  const isRight = (line: GroupedLine): boolean => line.bbox.x >= bandRight - EDGE_EPSILON

  const left = lines.filter(isLeft)
  const right = lines.filter(isRight)
  if (left.length < MIN_LINES_PER_SIDE || right.length < MIN_LINES_PER_SIDE) return null
  return { left, right, spanning: lines.filter((line) => !isLeft(line) && !isRight(line)) }
}

/* ------------------------------------------------------------------ */
/* Gutters between raw text runs                                       */
/*                                                                     */
/* Everything above works on whole lines, but a line is not a reliable */
/* unit for this: clustering is baseline-driven with no horizontal     */
/* limit, so two columns laid out on a shared grid arrive as ONE line  */
/* whose bounding box spans the fold. The gutter is then invisible —   */
/* not merely missed, but provably absent from the geometry.           */
/*                                                                     */
/* The runs inside the line still know where the empty strip is, so    */
/* this section works one level down. (This sweep moved here from      */
/* `layoutComplexity.ts`: that module imports `structure.ts`, which     */
/* imports this one, so sharing it the other way would have closed a    */
/* module cycle. Both granularities now live beside each other.)        */
/* ------------------------------------------------------------------ */

/** Horizontal extent of one text run. */
export interface RunBox {
  x: number
  w: number
}

/** Runs needed on a page before a column split is believable. */
export const MIN_COLUMN_ITEMS = 8

/** An empty vertical strip between two columns of runs. */
export interface RunGutter {
  /** Centre of the empty band. */
  position: number
  width: number
  /** Runs spanning the band (headers, watermarks) — kept small by design. */
  crossings: number
}

/** One detected band, inclusive of its edges in page points. */
export interface GutterBand {
  left: number
  right: number
}

/**
 * Widest low-crossing empty band: sweeps run endpoints and keeps the band
 * with the fewest crossing runs (ties → widest), requiring text on both
 * sides and a gutter at least `max(6pt, 2% of page width)` wide.
 *
 * Tolerating a small minority of crossing runs is what lets a full-width
 * title sit above two columns without destroying the detection — the title
 * crosses the fold, every real column line does not.
 */
export function bestItemGutter(boxes: RunBox[], pageWidth: number): RunGutter | null {
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
  let best: RunGutter | null = null
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
 * Every band on a page that separates columns, ordered left to right.
 *
 * `bestItemGutter` returns only the single best band, so this recurses on each
 * side to find the rest: one band gives two columns, two give three. Depth is
 * capped so an unbalanced page cannot spin.
 */
export function gutterBands(
  boxes: RunBox[],
  pageWidth: number,
  depth: number = MAX_SPLITS,
): GutterBand[] {
  if (depth <= 0 || boxes.length < MIN_COLUMN_ITEMS) return []
  const gutter = bestItemGutter(boxes, pageWidth)
  if (!gutter) return []

  const left: RunBox[] = []
  const right: RunBox[] = []
  for (const box of boxes) {
    if (box.x + box.w / 2 <= gutter.position) left.push(box)
    else right.push(box)
  }
  if (left.length < 3 || right.length < 3) return []

  const band: GutterBand = {
    left: gutter.position - gutter.width / 2,
    right: gutter.position + gutter.width / 2,
  }
  return [
    ...gutterBands(left, pageWidth, depth - 1),
    band,
    ...gutterBands(right, pageWidth, depth - 1),
  ]
}

/**
 * Cuts lines that merged across a column gutter back into one line per column.
 *
 * A two-column page whose columns share baselines produces one line per *row*,
 * reading `Left half … Right half`. Ordered as-is that interleaves the columns
 * line by line — the exact corruption this whole module exists to prevent — and
 * even a correct order would hand the translator half a sentence from each
 * column glued together. The fix has to happen before ordering, and it can only
 * happen here, where the runs still record where the empty strip is.
 *
 * Guarantees: a line either survives untouched or is replaced by parts that
 * together reproduce its text and cover its extent. Nothing is dropped,
 * duplicated or reordered — except a **table row**, whose cells are cells
 * *because* they ride one baseline, and which is therefore left whole.
 */
export function splitMergedLines(
  lines: GroupedLine[],
  options: { pageWidth: number; pageIndex: number },
): GroupedLine[] {
  const boxes: RunBox[] = []
  for (const line of lines) {
    for (const run of line.runs ?? []) boxes.push({ x: run.x, w: run.w })
  }
  // No sub-line geometry (OCR pages, hand-built fixtures): there is nothing to
  // cut with, and the line-level detector above already reads those correctly.
  if (boxes.length === 0) return lines

  const bands = gutterBands(boxes, options.pageWidth)
  if (bands.length === 0) return lines

  const split: GroupedLine[] = []
  for (const line of lines) {
    split.push(...cutAtBands(line, bands, options.pageIndex))
  }
  return split
}

/** Replaces one line by its column parts, or by itself when it must stay whole. */
function cutAtBands(line: GroupedLine, bands: GutterBand[], pageIndex: number): GroupedLine[] {
  const runs = line.runs
  if (!runs || runs.length < 2) return [line]
  if (looksLikeTableRow(line)) return [line]
  // Runs and itemIndexes are built in the same pass and same order. Without a
  // 1:1 map, slicing one and not the other would silently repeat or lose an
  // item reference — so an inconsistent line is left alone instead.
  if (line.itemIndexes.length !== 0 && line.itemIndexes.length !== runs.length) return [line]

  // A band is crossed by the *gap* between two adjacent runs. The min/max form
  // keeps this correct for right-to-left lines, whose runs are stored
  // right-to-left rather than in ascending x.
  const cuts: number[] = []
  for (let i = 1; i < runs.length; i += 1) {
    const before = Math.min(runs[i - 1].x + runs[i - 1].w, runs[i].x + runs[i].w)
    const after = Math.max(runs[i - 1].x, runs[i].x)
    if (bands.some((band) => before <= band.left && band.right <= after)) cuts.push(i)
  }
  if (cuts.length === 0) return [line]

  const edges = [0, ...cuts, runs.length]
  const parts: GroupedLine[] = []
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const from = edges[index]
    const to = edges[index + 1]
    parts.push(lineOfRuns(runs.slice(from, to), line, line.itemIndexes.slice(from, to), pageIndex))
  }
  return parts
}

/**
 * Builds the line for one contiguous slice of a line's runs.
 *
 * The bounding box and id are derived exactly the way `groupItemsIntoLines`
 * derives them from a member set, so a part carries the id it would have had
 * had it been a separate visual line all along.
 */
function lineOfRuns(
  slice: LineRun[],
  source: GroupedLine,
  itemIndexes: number[],
  pageIndex: number,
): GroupedLine {
  const minX = Math.min(...slice.map((run) => run.x))
  const maxX = Math.max(...slice.map((run) => run.x + run.w))
  const bbox: BBox = {
    x: Math.round(minX * 100) / 100,
    y: source.bbox.y,
    w: Math.round((maxX - minX) * 100) / 100,
    h: source.bbox.h,
  }
  const text = slice
    .map((run) => run.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    id: lineId(pageIndex, bbox, text),
    text,
    bbox,
    style: source.style,
    itemIndexes,
    runs: slice,
  }
}

/**
 * Orders one zone's column members left to right, recursing so three- and
 * four-column layouts come out in newspaper order.
 *
 * A sub-group that still contains spanning lines means the split is not clean,
 * so it falls back to plain order rather than guessing where they belong — and
 * keeps every line either way.
 */
function orderColumns(
  lines: GroupedLine[],
  pageWidth: number,
  splitsLeft: number = MAX_SPLITS,
): GroupedLine[] {
  if (splitsLeft <= 0 || lines.length < MIN_LINES) return sortReadingOrder(lines)
  const band = findBand(lines, pageWidth)
  if (!band || band.spanning.length > 0) return sortReadingOrder(lines)
  return [
    ...orderColumns(band.left, pageWidth, splitsLeft - 1),
    ...orderColumns(band.right, pageWidth, splitsLeft - 1),
  ]
}

/**
 * Reading order for a page's body: zones cut by spanning lines, columns
 * ordered left to right inside each zone.
 *
 * Returns every input line exactly once, in reading order.
 */
export function orderBodyLines(lines: GroupedLine[], pageWidth: number): GroupedLine[] {
  if (lines.length < MIN_LINES || pageWidth <= 0) return sortReadingOrder(lines)
  const band = findBand(lines, pageWidth)
  if (!band) return sortReadingOrder(lines)

  // Cut zones at the spanning lines. Membership is compared by object
  // identity, not by id: two visually identical lines share an id, and set
  // semantics keyed on it would silently drop one of them.
  const spanning = new Set<GroupedLine>(band.spanning)
  const segments: Array<{ lines: GroupedLine[]; boundary: GroupedLine | null }> = []
  let current: GroupedLine[] = []
  for (const line of sortReadingOrder(lines)) {
    if (spanning.has(line)) {
      segments.push({ lines: current, boundary: line })
      current = []
    } else {
      current.push(line)
    }
  }
  segments.push({ lines: current, boundary: null })

  const ordered: GroupedLine[] = []
  for (const segment of segments) {
    ordered.push(...orderColumns(segment.lines, pageWidth))
    if (segment.boundary) ordered.push(segment.boundary)
  }
  return ordered
}
