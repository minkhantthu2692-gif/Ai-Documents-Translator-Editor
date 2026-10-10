/**
 * Table-row detection.
 *
 * Split out of `structure.ts` because it is needed by *two* consumers with
 * opposite instincts: the block builder wants to know whether a run of lines is
 * a table, and the reading-order pass wants to know which lines it must leave
 * alone. Both live in modules that would otherwise have to import each other.
 *
 * ### Two questions, two answers — and the page break between them
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
 * A third input, `TableContinuation`, exists for the one shape neither can
 * reach alone: a table cut by a page break can leave the next page with a
 * single row, and one row has nothing to recur against. The row is then judged
 * against the *table it came from* — same number of cells, same left edge —
 * rather than against itself. It is offered, never assumed: `tableForLines`
 * still answers `null` for every line that does not measure out that way.
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

/**
 * The table the previous page ended with, in the one form the next page needs.
 *
 * A page break cuts a table in the middle of a run of rows, and the rows that
 * land on the next page are judged on their own: one leftover row has no second
 * row to agree with, so `tableForLines` reads it as a long word space and the
 * page opens with a paragraph of cell text. The previous table is the evidence
 * that such a row is a row — this carries just enough of it to check that the
 * lines at the top of the next page are cut the way *that* table was cut.
 */
export interface TableContinuation {
  /** Cells per row that table had. */
  width: number
  /** x its left edge started at — every row began there. */
  left: number
}

/** A block's table, as the rectangular grid the exporters render. */
export interface TableGrid {
  /** One array of cell strings per row, all the same length. */
  rows: string[][]
  /**
   * How many columns each cell covers, parallel to `rows` — `null` when no
   * cell on the table spans anything and it is therefore nothing but noise.
   *
   * The encoding is the one every format below already speaks: a merged cell
   * holds the number of columns it covers, the cells it covers hold `0`, and
   * an ordinary cell holds `1`. Rows stay rectangular and the merged cell's
   * text stays in the *start* column, because that is where it was drawn and
   * because the model reads `rows` — a grid whose row lengths changed would
   * stop being a rectangle the moment a renderer tried to lay it out.
   *
   * Only horizontal spans exist. A *vertical* merge would need the height of
   * each cell, and `LineRun` is a rectangle on one baseline: nothing here can
   * tell a cell two rows tall from two cells that happen to be the same width.
   */
  spans: number[][] | null
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
export function tableForLines(
  lines: readonly GroupedLine[],
  continuation?: TableContinuation | null,
): TableGrid | null {
  const detected = detectedTable(lines)
  if (detected) return detected
  if (!continuation) return null
  return continuedTable(lines, continuation)
}

/** `tableForLines`'s own reading: aligned columns, or the text form of them. */
function detectedTable(lines: readonly GroupedLine[]): TableGrid | null {
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
  // Rows arriving as text carry no geometry, so there is nothing to read a
  // merge out of: every cell is exactly one column wide and the exporters are
  // told nothing, which is the same answer they had before spans existed.
  return { rows: grid, spans: null }
}

/**
 * The lines at the top of a page read as rows of the table the page before it
 * ended with — the only reading the recurrence test cannot reach.
 *
 * `detectedTable` asks rows to *agree* with each other, which a table with one
 * row left on the page has no way to do. Here every line is asked to agree with
 * the **previous table** instead: cut into as many cells as that table had, at
 * a left edge that table started from, out of runs that are cells rather than
 * clauses. Every line has to pass, so a paragraph that merely begins flush with
 * the table's margin stays the paragraph it is — the eight-ems run width and
 * the required cell count are what stop prose wearing the table's clothes, and
 * a line that fails costs exactly what it did before: the page opens with the
 * text it opened with.
 *
 * No merge is read here. One row is one row: a span is a *recurring* cut
 * position the alignment clusters produce, and inventing one from a single line
 * would be a guess about geometry nothing observed.
 */
function continuedTable(
  lines: readonly GroupedLine[],
  continuation: TableContinuation,
): TableGrid | null {
  if (lines.length === 0) return null
  const rows: string[][] = []
  for (const line of lines) {
    const cells = continuedRow(line, continuation)
    if (cells === null) return null
    rows.push(cells)
  }
  return { rows, spans: null }
}

/** One line as a row of the previous table, or `null` when it is not one. */
function continuedRow(line: GroupedLine, continuation: TableContinuation): string[] | null {
  const ordered = runsInOrder(line)
  if (ordered.length < 2) return null
  // Every row of that table began where its first column began. A row whose
  // first cell is empty starts further right and cannot be told from a new
  // table's row, so it is left alone rather than guessed at.
  const tolerance = Math.max(4, line.style.fontSize * 0.5)
  if (Math.abs(ordered[0].x - continuation.left) > tolerance) return null
  if (!cellSizedRuns(line)) return null
  const cells = rowCells(line)
  return cells !== null && cells.length === continuation.width ? cells : null
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
  const width = columns.length + 1
  const rows: string[][] = []
  const spans: number[][] = []
  for (const line of lines) {
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
    // A run that starts inside one column and ends inside a later one is the
    // whole of what a *merged* cell looks like from here: one show-text run,
    // drawn wider than the column it begins in. `spansOf` vouches for the rows
    // it can read and refuses the ones it cannot — and a refused row is drawn
    // exactly as it was before spans existed, every cell its own column.
    // Refusing the *table* would cost far more than a merge is worth: one row
    // whose runs overlap (a trailing space in the width, a highlight over the
    // text) leaves a table that is still a table, not a paragraph of tabs.
    const row = spansOf(ordered, columns) ?? Array.from({ length: width }, () => 1)
    rows.push(cells)
    spans.push(row)
  }

  // A row has to be at least half filled to belong to this grid.
  //
  // Every line here has a boundary of its own — that is why it merged into the
  // block — so the question is only whether its runs landed on *these*
  // columns. An empty cell is ordinary (a blank middle column is exactly why
  // the rows get padded), but a row with one cell filled out of three had a
  // wide gap somewhere over on the left and is a line of prose that happened
  // to sit beside a table, not a row of it.
  //
  // A merged cell counts for the columns it covers, or a table whose header
  // reads `Consolidated results` across all three would fail here for having
  // one cell out of three — which is how every such table was lost before.
  const filledRequired = Math.ceil((columns.length + 1) / 2)
  for (let index = 0; index < rows.length; index += 1) {
    const filled = rows[index].reduce(
      (sum, cell, column) => sum + (cell.length > 0 ? spans[index][column] : 0),
      0,
    )
    if (filled < filledRequired) return null
  }

  // And a merge has to be the exception, not the rule. A run of lines whose
  // rows *mostly* cross their own boundaries is a block of prose beside a
  // table — the reader's columns are its sentences — and promoting it would
  // hand the model a grid whose cells are clauses. Half the rows is the line:
  // a table may carry merged headers, a paragraph is nothing but them.
  const mergedRows = spans.filter((row) => row.some((span) => span > 1)).length
  if (mergedRows * 2 > lines.length) return null

  return { rows, spans: spans.some((row) => row.some((span) => span > 1)) ? spans : null }
}

/**
 * How wide each cell of one row is, in columns, or `null` when the row does
 * not describe cells this grid could hold.
 *
 * A cell that begins before a column boundary and ends past it covers the
 * columns it crosses, and that is the only signal a PDF gives for a merge: the
 * cell is drawn as one run which simply starts further left and runs further
 * right than the column it sits in. Everything else on the row is one column
 * wide.
 *
 * Two shapes are refused rather than guessed at, because a wrong guess puts
 * text in a cell it does not belong to — and a refusal costs far less than
 * it looks: the caller draws *this row* flat, which is the reading it had
 * before spans existed, and leaves every other row's merge alone.
 *
 *  - two merges claiming the same column — two texts on one baseline;
 *  - a merge covering a column that another run on the row already sits in.
 *    That is the same lie one step removed, and the one the width test cannot
 *    catch on its own: a run whose *advance* reaches past a boundary — a
 *    trailing space, a highlight laid over the words — while the cell that
 *    begins exactly there is drawn beside it.
 *
 * A run *inside* the cell it merges is ordinary — a merged header drawn as
 * `Quarter` and `Results` a word space apart is one cell, not an overlap.
 */
function spansOf(ordered: readonly LineRun[], columns: readonly number[]): number[] | null {
  const width = columns.length + 1
  const spans = Array.from({ length: width }, () => 1)
  const claimed = new Set<number>()
  const bucketOf = (run: LineRun): number => columns.filter((at) => run.x >= at).length

  for (const run of ordered) {
    const start = bucketOf(run)
    // A boundary strictly inside the run: `>= left` is the next column's, so
    // only what the run actually straddles counts.
    const crossed = columns.filter((at) => at > run.x && at < run.x + run.w).length
    if (crossed === 0) continue
    // The span cannot run off the end of the grid: `start` counts the
    // boundaries the run begins at or before, every boundary it crosses sits
    // at or after that index, and `columns` is sorted — so the last column it
    // can reach is the last one there is. What is worth refusing is a second
    // merge landing in a column this one already took.
    if (claimed.has(start)) return null
    for (let index = start + 1; index <= start + crossed; index += 1) {
      if (claimed.has(index)) return null
      claimed.add(index)
    }
    spans[start] = crossed + 1
    for (let index = start + 1; index <= start + crossed; index += 1) spans[index] = 0
  }
  if (claimed.size === 0) return spans

  for (const run of ordered) {
    if (claimed.has(bucketOf(run))) return null
  }
  return spans
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
