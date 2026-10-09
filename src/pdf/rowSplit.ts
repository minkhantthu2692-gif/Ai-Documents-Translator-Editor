/**
 * Table-row detection.
 *
 * Split out of `structure.ts` because it is needed by *two* consumers with
 * opposite instincts: the block builder wants to know whether a run of lines is
 * a table, and the reading-order pass wants to know which lines it must leave
 * alone. Both live in modules that would otherwise have to import each other.
 *
 * ### Two questions, two answers
 *
 * **"Is this run of lines a table?"** (`tableForLines`) is asked once a block
 * exists and answered off geometry: pdf.js emits one text item per show-text
 * operator, so every cell of a row arrives as its own run with its own x, and
 * the gap between two cells is layout rather than typography. The block only
 * qualifies when the cut positions *recur across rows* — a table is aligned
 * columns, and one long word space in one line is not a column.
 *
 * **"Must reading order leave this line whole?"** (`looksLikeTableRow`) is
 * asked of one line, before any block exists. It feeds `cutAtBands`, whose job
 * is to cut a row fused across a column gutter back into its columns — and a
 * fused two-column line is geometrically very close to a two-cell table row:
 * same runs, same gaps, same baselines, and the two fixtures that pin this
 * cannot be told apart by gap (28pt against 26pt) or by run count (two against
 * three). What separates them is the *width* of the runs: a table's cells are
 * labels and figures, a column's runs are spans of prose. So this reads both
 * the whole-line whitespace form (which a hand-built fixture and an OCR line
 * have) and, when there is none, the geometry restricted to cell-sized runs.
 * Getting it wrong in the generous direction stops columns being cut apart and
 * costs types 3, 7 and 12; getting it wrong in the strict direction flattens a
 * real table into one paragraph per column. The width test is the axis that
 * lets both stand.
 *
 * The two disagree on purpose, and `structure.test.ts` /
 * `readingOrder.test.ts` between them pin both halves.
 *
 * ### Why the old block-level test had to go
 *
 * It split `line.text` on `/\s{2,}|\t/`. `groupItemsIntoLines` collapses every
 * whitespace run to one space and trims *before* the structure pass ever sees
 * a line, so that pattern could not match a real PDF: table detection was
 * unreachable from any document, and only ever fired on lines a test built by
 * hand. Only geometry survives the collapse, so geometry is what the block
 * builder now reads.
 */

import type { GroupedLine, LineRun } from './lineGrouping'

export interface CellSplit {
  isTable: boolean
  cells: string[]
}

/** A block's table, as the rectangular grid the exporters render. */
export interface TableGrid {
  /** One array of cell strings per row, all the same length. */
  rows: string[][]
}

/**
 * The narrowest gap that cannot be a word space.
 *
 * No text face sets a space at a full em or more — proportional faces run
 * 0.2–0.5 em and monospaced exactly 0.5 — so a gap of one em between two runs
 * sharing a baseline is layout rather than typography, and layout between two
 * things on one baseline is a column.
 */
export function cellGapThreshold(fontSize: number): number {
  return Math.max(fontSize, 4)
}

/** Runs left to right. `runs` are stored in visual order, but RTL is reversed. */
function runsInOrder(line: GroupedLine): LineRun[] {
  return [...(line.runs ?? [])].sort((a, b) => a.x - b.x)
}

/**
 * The x each cell boundary of one line falls on: the left edge of every run
 * preceded by a cell-sized gap.
 *
 * Empty when the line has no runs to judge (a line built by hand in a test, or
 * by OCR) or no gap wide enough.
 */
export function cellBoundaries(line: GroupedLine): number[] {
  const ordered = runsInOrder(line)
  if (ordered.length < 2) return []
  const threshold = cellGapThreshold(line.style.fontSize)
  const boundaries: number[] = []
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const gap = ordered[index].x - (previous.x + previous.w)
    if (gap >= threshold) boundaries.push(ordered[index].x)
  }
  return boundaries
}

/**
 * The cells of one line, or `null` when the line is not a row.
 *
 * Geometry when the line carries runs; the whole-line whitespace form when it
 * does not, which is the only form a hand-built fixture or an OCR line can
 * have. Either way the answer is the same shape, so the block builder never
 * has to know where the line came from.
 */
export function rowCells(line: GroupedLine): string[] | null {
  if (line.runs && line.runs.length >= 1) {
    const boundaries = cellBoundaries(line)
    if (boundaries.length === 0) return null
    const edges = [-Infinity, ...boundaries, Infinity]
    const ordered = runsInOrder(line)
    const cells = edges.slice(0, -1).map((left, index) => {
      const right = edges[index + 1]
      return ordered
        .filter((run) => run.x >= left && run.x < right)
        .map((run) => run.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    })
    return cells.every((cell) => cell.length > 0) ? cells : null
  }
  const legacy = splitRow(line)
  return legacy.isTable ? legacy.cells : null
}

/**
 * The table a run of lines makes, or `null` when they are not one.
 *
 * A table is *aligned columns*, so the boundaries have to recur: a cut
 * position shared by most of the lines becomes a column, and a cut that only
 * one row has is a long word space in that row and nothing more. Clustering
 * within half a character keeps a right-aligned column's per-row drift in one
 * bucket while leaving two genuine columns apart.
 *
 * Every line must offer at least one boundary. A line with none is prose that
 * wandered into the block, and a block of prose beside a table is not a table.
 *
 * Rows built without geometry — hand-built fixtures, OCR — cannot be checked
 * for alignment, so they fall back to agreeing on a column count, which is the
 * weaker claim the legacy test already made.
 */
export function tableForLines(lines: readonly GroupedLine[]): TableGrid | null {
  if (lines.length < 2) return null
  if (lines.every((line) => line.runs && line.runs.length > 0)) {
    return alignedTable(lines)
  }

  const rows = lines.map((line) => rowCells(line))
  if (rows.some((cells) => cells === null)) return null
  const grid = rows as string[][]
  const width = Math.max(...grid.map((cells) => cells.length))
  if (width < 2) return null
  if (grid.some((cells) => cells.length !== width)) return null
  return { rows: grid }
}

/** Geometric half of `tableForLines`: cut positions that recur across rows. */
function alignedTable(lines: readonly GroupedLine[]): TableGrid | null {
  const perLine = lines.map((line) => cellBoundaries(line))
  if (perLine.some((boundaries) => boundaries.length === 0)) return null

  const tolerance = Math.max(lines[0].style.fontSize * 0.5, 4)
  const clusters: Array<{ at: number; hits: number }> = []
  for (const boundaries of perLine) {
    for (const at of boundaries) {
      const near = clusters.find((cluster) => Math.abs(cluster.at - at) <= tolerance)
      if (near) {
        near.at = (near.at * near.hits + at) / (near.hits + 1)
        near.hits += 1
      } else {
        clusters.push({ at, hits: 1 })
      }
    }
  }

  // Two rows out of three agreeing is enough; a table whose middle row wraps
  // onto two lines still has its columns.
  const required = Math.max(1, Math.ceil(lines.length * 0.6))
  const columns = clusters
    .filter((cluster) => cluster.hits >= required)
    .map((cluster) => Math.round(cluster.at))
    .sort((a, b) => a - b)
  if (columns.length === 0) return null

  const edges = [-Infinity, ...columns, Infinity]
  const rows = lines.map((line) => {
    const ordered = runsInOrder(line)
    return edges.slice(0, -1).map((left, index) => {
      const right = edges[index + 1]
      return ordered
        .filter((run) => run.x >= left && run.x < right)
        .map((run) => run.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    })
  })
  // A row has to be at least half filled to belong to this grid.
  //
  // Every line here has a boundary of its own — that is why it merged into the
  // block — so the question is only whether its runs landed on *these*
  // columns. An empty cell is ordinary (a blank middle column is exactly why
  // the rows get padded), but a row with one cell filled out of three had a
  // wide gap somewhere over on the left and is a line of prose that happened
  // to sit beside a table, not a row of it.
  const filledRequired = Math.ceil((columns.length + 1) / 2)
  if (rows.some((cells) => cells.filter((cell) => cell.length > 0).length < filledRequired)) {
    return null
  }
  return { rows }
}

/**
 * The cells of a line when its text carries them as text.
 *
 * This is the original test and it is kept for exactly two callers: the
 * reading-order pass, and the no-geometry fallback in `rowCells`. See the
 * module header for why reading order must not be given the geometric answer.
 */
export function splitRow(line: GroupedLine): CellSplit {
  const raw = line.text
  const parts = raw.split(/\s{2,}|\t/)
  if (parts.length < 2) return { isTable: false, cells: [raw] }
  const cells = parts.map((part) => part.trim()).filter(Boolean)
  const allShort = cells.every((cell) => cell.length <= MAX_CELL)
  if (cells.length < 2 || !allShort) return { isTable: false, cells: [raw] }
  return { isTable: true, cells }
}

/** A cell longer than this is a sentence that happens to have a wide space. */
const MAX_CELL = 40

/**
 * Conservative per-line answer for the reading-order pass — see the header.
 *
 * Two readings, either of which protects the line:
 *
 *  1. the whole-line whitespace form the original test asked for, which is
 *     what a hand-built fixture or a line an OCR engine produced has;
 *  2. geometry where **every run is cell-sized** — narrower than eight ems,
 *     so a label or a number rather than a clause.
 *
 * The second one is needed because of the first one's blindness: a real PDF's
 * cells arrive as separate positioned show-text operators, `groupItemsIntoLines`
 * puts them on one line, and then `splitMergedLines` sees a vertical band that
 * no line on the page crosses and cuts the row straight down it — turning a
 * table into one paragraph per column. Requiring cell-sized runs is what keeps
 * the *other* caller honest: a genuine column gutter is crossed by lines whose
 * runs are spans of prose, and those are not cells however aligned they are.
 * Neither fixture can tell the two apart by gap (28pt against 26pt) or by run
 * count (two against three), which is exactly why width is the axis used here.
 */
export function looksLikeTableRow(line: GroupedLine): boolean {
  if (splitRow(line).isTable) return true
  return cellSizedRuns(line) && cellBoundaries(line).length > 0
}

/**
 * True when every run of `line` is narrow enough to be a cell rather than a
 * span of a text column.
 *
 * Eight ems: a label, a figure, a short phrase. Past that a run carries a
 * clause, and a line made of clauses is prose that happens to be split by a
 * gutter. Proportional faces set roughly 0.5 em per character at the average,
 * so the limit is about sixteen characters — wide enough for `restocked` and
 * `backorder`, far short of a filled column.
 */
function cellSizedRuns(line: GroupedLine): boolean {
  const runs = line.runs
  if (!runs || runs.length < 2) return false
  const limit = cellGapThreshold(line.style.fontSize) * 8
  return runs.every((run) => run.w <= limit)
}
