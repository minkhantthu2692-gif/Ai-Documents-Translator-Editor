/**
 * Line → block structure extraction.
 *
 * Turns the flat line list of a page into ordered, translatable blocks:
 *   - reading order (column detection first, then top-to-bottom)
 *   - paragraph merging (font, indent, vertical gap, list markers)
 *   - footnote regions (small, marked type under the text block — see
 *     `footnotes.ts`, which has to run before any merging decision)
 *   - header / footer bands (repeated-across-pages detection + page labels)
 *   - table rows (aligned multi-column short cells)
 *   - alignment and line-spacing estimation
 *   - skip-rule classification and placeholder tokenisation per block
 *
 * Pure functions: the worker feeds them pdf.js output, tests feed them literals.
 */

import { classifyLine, type SkipContext, type SkipRule } from './skipRules'
import { tokenizePlaceholders, type Placeholder } from './placeholders'
import { headingLevelFor, sizeLadder } from './headings'
import { medianFontSize, type GroupedLine, type LineStyle } from './lineGrouping'
import { kmeansMidpoint, orderBodyLines, splitMergedLines } from './readingOrder'
import { footnoteMarker, markFootnoteRegions } from './footnotes'
import {
  codeBlockText,
  isMonospaceFamily,
  looksLikeCodeBlock,
  looksLikeCodeLine,
} from './codeBlocks'
import { rowCells, tableForLines, type TableContinuation } from './rowSplit'
import { blockId, type BBox } from './stableId'

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'caption'
  | 'footnote'
  | 'shape'
  | 'code'
  | 'form-field'
  | 'annotation'
export type BlockRegion = 'body' | 'header' | 'footer'
export type BlockAlignment = 'left' | 'center' | 'right' | 'justified'

export interface BlockLine {
  id: string
  text: string
  bbox: BBox
  style: LineStyle
}

/**
 * One hyperlink occurrence: the words an annotation covered and where it
 * goes. Lives here rather than in `links.ts` so the block shape does not have
 * to import from the module that fills it; `links.ts` re-exports it.
 */
export interface LinkRef {
  /** Always a substring of the block it is attached to. */
  text: string
  url: string
}

/**
 * One figure anchored to a block: an image the page painted, paired with the
 * text it belongs to. Lives here rather than in `figures.ts` so the block shape
 * does not have to import from the module that fills it.
 *
 * It records *where* the picture is and how big it was, never pixels — the
 * exporter crops the page art through `bbox`, which keeps every block row
 * small enough to round-trip through IndexedDB and the sync sheet.
 */
export interface FigureRef {
  /** Rectangle in page space (top-left origin), identical to `bbox`'s frame. */
  bbox: BBox
  /** Native raster size in pixels, when the operator list reported it. */
  pixelWidth: number | null
  pixelHeight: number | null
}

export interface PageBlock {
  id: string
  kind: BlockKind
  region: BlockRegion
  /** Reading order index within the page (0-based). */
  order: number
  text: string
  bbox: BBox
  lines: BlockLine[]
  alignment: BlockAlignment
  /** Set when the block must not be translated, with the rule that decided it. */
  skipRule: SkipRule | null
  placeholders: Placeholder[]
  /** Bullet / numbering marker captured from the first line (`•`, `1.`, …). */
  listMarker: string | null
  /**
   * The cells of a `kind === 'table'` block as data — one array of cell
   * strings per row, every row the same length. `null` for every other kind.
   *
   * It is kept beside `text` rather than instead of it: `text` is what the
   * model sees and what a fallback renderer prints (` \t ` between cells), and
   * it must stay byte-identical for the translation cache to hit. This is what
   * the exporters draw a real table from.
   */
  tableCells: string[][] | null
  /**
   * How many columns each cell of a `kind === 'table'` block covers, parallel
   * to `tableCells` — `null` when nothing on the table spans anything.
   *
   * A merged cell holds the number of columns it covers, the cells it covers
   * hold `0`, an ordinary cell holds `1`; the merged cell's text stays in the
   * start column, where the PDF drew it. The grid stays a rectangle, because
   * that is what `text` was built from and what the exporters lay out.
   *
   * Carried beside `tableCells` for the same reason: it describes the *source*
   * geometry, while what a renderer prints comes back from the model and may
   * no longer line up with it — so a renderer applies these only to a printed
   * grid of the shape they were measured on.
   */
  tableSpans: number[][] | null
  /**
   * 1..6 when `kind === 'heading'`, else null — the depth of the heading
   * inside the document's own ladder (`headings.ts`). A level means nothing on
   * its own, so exporters should render it relative to the other headings they
   * are already emitting, never as an absolute size.
   */
  headingLevel: number | null
  /**
   * External `/Link` annotations that landed on this block, in reading order.
   * Always an array (possibly empty) so a caller never tests for `undefined`.
   * Each `text` is a substring of `text`, which is what lets an exporter wrap
   * it without re-parsing the string.
   */
  links: LinkRef[]
  /**
   * The figures this block carries, top to bottom. Always an array (possibly
   * empty) so a caller never tests for `undefined`.
   *
   * An empty array is the normal case: most pages have no figure, and the ones
   * that do get matched to the paragraph they illustrate (`figures.ts`) rather
   * than becoming blocks of their own — a picture has no words to translate, so
   * giving it a block would hand the model something it cannot change while
   * splitting the paragraph it sits next to.
   */
  figures: FigureRef[]
  /** Estimated line spacing as a multiple of the font size (≥ 1). */
  lineSpacing: number
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  color: string
}

export interface StructureOptions {
  pageIndex: number
  pageWidth: number
  pageHeight: number
  ctx?: SkipContext
  /** Normalised texts seen as a header on ≥2 pages. */
  headerTexts?: Set<string>
  /** Normalised texts seen as a footer on ≥2 pages. */
  footerTexts?: Set<string>
  /**
   * The document's heading font sizes, largest first — the ladder every page
   * levels its headings against. Supplied by the probe; absent means "rank
   * this page's own headings", which is what a caller without document
   * context (OCR, a unit test) does.
   */
  headingSizes?: readonly number[]
  /**
   * The table the previous page ended with, when this page's first body block
   * may be the rest of it — see `TableContinuation`. Offered to the block
   * builder for that one block only: the evidence is about the top of *this*
   * page, and a table further down is a table of its own.
   */
  continuation?: TableContinuation | null
}

/** Fraction of the page height used for the header / footer bands. */
export const MARGIN_BAND = 0.1

const BULLET =
  /^([•‣▪◦●⁃o·\-–—]|\(?\d{1,3}[.)]|\(?[ivxlcdmIVXLCDM]{1,5}[.)]|[①-⑳⑴-⑼]|[၀-၉]{1,3}[.)])\s+/

/** Collapses digits so "Page 3" and "Page 4" count as the same margin line. */
export function normalizeMarginText(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}

/**
 * Finds text that repeats in the top/bottom bands across pages.
 * Needs ≥2 pages; a single page only yields page-label heuristics.
 */
export function detectRepeatingMargins(
  pages: Array<{ lines: GroupedLine[]; pageHeight: number }>,
): {
  headers: Set<string>
  footers: Set<string>
} {
  const headers = new Map<string, number>()
  const footers = new Map<string, number>()

  for (const { lines, pageHeight } of pages) {
    if (pageHeight <= 0) continue
    const seenTop = new Set<string>()
    const seenBottom = new Set<string>()
    for (const line of lines) {
      const normalized = normalizeMarginText(line.text)
      if (normalized.length < 3) continue
      const inTopBand = line.bbox.y + line.bbox.h <= pageHeight * MARGIN_BAND
      const inBottomBand = line.bbox.y >= pageHeight * (1 - MARGIN_BAND)
      if (inTopBand && !seenTop.has(normalized)) {
        seenTop.add(normalized)
        headers.set(normalized, (headers.get(normalized) ?? 0) + 1)
      } else if (inBottomBand && !seenBottom.has(normalized)) {
        seenBottom.add(normalized)
        footers.set(normalized, (footers.get(normalized) ?? 0) + 1)
      }
    }
  }

  const repeat = (counts: Map<string, number>): Set<string> =>
    new Set([...counts.entries()].filter(([, count]) => count >= 2).map(([text]) => text))

  return { headers: repeat(headers), footers: repeat(footers) }
}

interface ColumnSplit {
  columns: GroupedLine[][]
}

/**
 * Splits lines into at most two columns when there is a clear vertical gutter
 * and both sides carry a meaningful number of lines.
 *
 * This is the *conservative* two-way split: it refuses whenever any line
 * bridges the gutter, which keeps complexity scoring honest. Reading order
 * needs the opposite instinct — a bridging line is a title, not a reason to
 * give up — so `structurePage` orders via `readingOrder.orderBodyLines`
 * instead. Both share `kmeansMidpoint`, so there is one gutter locator.
 */
export function detectColumns(lines: GroupedLine[], pageWidth: number): ColumnSplit {
  const byReadingOrder = (a: GroupedLine, b: GroupedLine): number =>
    a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x

  if (lines.length < 6 || pageWidth <= 0) {
    return { columns: [[...lines].sort(byReadingOrder)] }
  }

  const midpoint = kmeansMidpoint(lines, pageWidth)
  if (midpoint === null) return { columns: [lines] }

  const left = lines.filter((line) => line.bbox.x + line.bbox.w / 2 <= midpoint)
  const right = lines.filter((line) => line.bbox.x + line.bbox.w / 2 > midpoint)
  if (left.length < 3 || right.length < 3) return { columns: [lines] }

  // The gutter must be real: no line may bridge it.
  const leftRight = Math.max(...left.map((line) => line.bbox.x + line.bbox.w))
  const rightLeft = Math.min(...right.map((line) => line.bbox.x))
  if (rightLeft - leftRight < 8) return { columns: [lines] }

  const sortedLeft = [...left].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  const sortedRight = [...right].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  return { columns: [sortedLeft, sortedRight] }
}

/**
 * Counts the page's text columns (1..maxColumns) by recursively re-splitting
 * each side with the same two-way detector — a clean split into two columns
 * is tried again per side, which recovers three- and four-column layouts.
 * `structurePage` deliberately keeps the plain two-way split (left column
 * fully before right); this count only feeds layout-complexity scoring.
 * The cap is applied at the end so unbalanced splits cannot undercount.
 */
export function countColumns(lines: GroupedLine[], pageWidth: number, maxColumns = 4): number {
  if (maxColumns <= 1 || lines.length < 6 || pageWidth <= 0) return 1
  const { columns } = detectColumns(lines, pageWidth)
  if (columns.length === 1) return 1
  let count = 0
  for (const column of columns) count += countColumns(column, pageWidth, maxColumns)
  return Math.min(count, maxColumns)
}

/**
 * Leading inside a paragraph: the smallest recurring positive gap, which stays
 * stable whether the page has two lines or two hundred. Falls back to the
 * median of every gap when nothing is tighter than one text line.
 */
function medianLineGap(lines: GroupedLine[]): number {
  if (lines.length < 2) return 0
  const sorted = [...lines].sort((a, b) => a.bbox.y - b.bbox.y)
  const gaps: Array<{ gap: number; fontSize: number }> = []
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]
    const current = sorted[i]
    const gap = current.bbox.y - (previous.bbox.y + previous.bbox.h)
    if (gap > 0 && gap < previous.style.fontSize * 3) {
      gaps.push({ gap, fontSize: previous.style.fontSize })
    }
  }
  if (gaps.length === 0) return 0
  const leading = gaps.filter((entry) => entry.gap <= entry.fontSize * 1.35)
  const pool = leading.length > 0 ? leading : gaps
  const values = pool.map((entry) => entry.gap).sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}

/** True when the line sits inside the page-number / separator pattern. */
function looksLikePageLabel(text: string): boolean {
  const decision = classifyLine(text, {})
  return decision.rule === 'number'
}

/** Classifies a line's band: body, header or footer. */
function regionOf(line: GroupedLine, options: StructureOptions): BlockRegion {
  const { pageHeight } = options
  const inTopBand = line.bbox.y + line.bbox.h <= pageHeight * MARGIN_BAND
  const inBottomBand = line.bbox.y >= pageHeight * (1 - MARGIN_BAND)
  const normalized = normalizeMarginText(line.text)
  if (inTopBand && (options.headerTexts?.has(normalized) || looksLikePageLabel(line.text))) {
    return 'header'
  }
  if (inBottomBand && (options.footerTexts?.has(normalized) || looksLikePageLabel(line.text))) {
    return 'footer'
  }
  return 'body'
}

function alignmentOf(lines: BlockLine[], pageWidth: number): BlockAlignment {
  if (lines.length === 0) return 'left'
  const lefts = lines.map((line) => line.bbox.x)
  const rights = lines.map((line) => line.bbox.x + line.bbox.w)
  const centers = lines.map((line) => line.bbox.x + line.bbox.w / 2)
  const spread = (values: number[]): number => Math.max(...values) - Math.min(...values)
  const meanCenter = centers.reduce((sum, value) => sum + value, 0) / centers.length
  const nearPageCenter = pageWidth > 0 && Math.abs(meanCenter - pageWidth / 2) <= 20

  if (lines.length === 1) {
    if (nearPageCenter) return 'center'
    if (pageWidth > 0 && rights[0] >= pageWidth * 0.95) return 'right'
    return 'left'
  }
  if (spread(rights) <= 4 && spread(lefts) <= 4) {
    return lines.length >= 3 && spread(lefts) <= 2 ? 'justified' : 'left'
  }
  if (spread(centers) <= 3 && nearPageCenter) return 'center'
  if (pageWidth > 0 && spread(rights) <= 4 && rights.every((right) => right >= pageWidth * 0.93)) {
    return 'right'
  }
  return 'left'
}

function mergedBBox(lines: GroupedLine[]): BBox {
  const x = Math.min(...lines.map((line) => line.bbox.x))
  const y = Math.min(...lines.map((line) => line.bbox.y))
  const right = Math.max(...lines.map((line) => line.bbox.x + line.bbox.w))
  const bottom = Math.max(...lines.map((line) => line.bbox.y + line.bbox.h))
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    w: Math.round((right - x) * 100) / 100,
    h: Math.round((bottom - y) * 100) / 100,
  }
}

/** True when two lines belong to the same paragraph. */
function canMerge(
  previous: GroupedLine,
  next: GroupedLine,
  context: { gap: number; medianSize: number; bodyGap: number },
): boolean {
  const styleA = previous.style
  const styleB = next.style
  if (Math.abs(styleA.fontSize - styleB.fontSize) > Math.max(1, context.medianSize * 0.15)) {
    return false
  }
  if (styleA.bold !== styleB.bold) return false
  if (styleA.fontFamily !== styleB.fontFamily) return false
  if (styleA.color !== styleB.color) return false
  if (Math.abs(styleA.rotation - styleB.rotation) > 1) return false

  // In a monospaced face a step sideways is a *column*, and columns are what a
  // snippet is built out of: the 2–4 space step of a nesting level must not
  // open a new paragraph. A monospaced advance is 0.5–0.6 em, which makes five
  // em about eight columns — room enough for the steps most styles use. Only
  // *both* lines being monospaced widens the tolerance, so a serif line beside
  // a snippet still splits. Reading order has already cut rows fused across a
  // column gutter back apart (`splitMergedLines`), so a two-column page cannot
  // be re-fused here.
  const monospaced = isMonospaceFamily(styleA.fontFamily) && isMonospaceFamily(styleB.fontFamily)
  const indentTolerance = monospaced
    ? Math.max(4, styleA.fontSize * 5)
    : Math.max(4, styleA.fontSize * 0.5)
  if (Math.abs(previous.bbox.x - next.bbox.x) > indentTolerance) return false

  const referenceGap = context.bodyGap > 0 ? context.bodyGap : styleA.fontSize * 0.6
  if (context.gap > referenceGap * 1.5) return false
  if (context.gap < -styleA.fontSize * 0.5) return false // overlapping → same visual row
  if (BULLET.test(next.text.trim())) return false

  // The `;` that closes most code lines is not the end of a sentence, so a gap
  // that would otherwise part two statements from each other leaves them be.
  if (!(looksLikeCodeLine(previous) && looksLikeCodeLine(next))) {
    const endsSentence = /[.!?:;"'”’]$/.test(previous.text.trim())
    if (endsSentence && context.gap > referenceGap * 1.15) return false
  }
  return true
}

/**
 * Builds ordered blocks from the lines of one page.
 */
export function structurePage(lines: GroupedLine[], options: StructureOptions): PageBlock[] {
  if (lines.length === 0) return []

  const bodyCandidates = lines.filter((line) => regionOf(line, options) === 'body')
  const medianSize = medianFontSize(bodyCandidates.length > 0 ? bodyCandidates : lines)
  const bodyGap = medianLineGap(bodyCandidates)

  // --- reading order -------------------------------------------------------
  // Two steps, in this order. First undo any line that merged across a column
  // gutter — columns sharing a baseline arrive as one line *per row*, and no
  // amount of ordering can recover columns fused into a single line. Then
  // order what is left: columns left to right, cut into zones by any line that
  // spans the gutter, so a title above two columns precedes both rather than
  // sitting inside one.
  const orderedBody: GroupedLine[] = orderBodyLines(
    splitMergedLines(bodyCandidates, options),
    options.pageWidth,
  )
  // Footnote regions are marked on the *ordered* body, so a note's
  // continuation lines are the ones that directly follow its opener and the
  // ids match the lines the block builder is about to see. Doing it earlier
  // would mark lines that `splitMergedLines` then replaced with column parts.
  const footnoteIds = markFootnoteRegions(orderedBody, {
    pageHeight: options.pageHeight,
    medianSize,
  })
  // Ids of the lines that reached the body. A line split into column parts is
  // deliberately absent — its parts are here instead, and the original cannot
  // resurface as a margin line because it was already filtered to the body.
  const bodyIds = new Set(orderedBody.map((line) => line.id))
  const marginLines = lines
    .filter((line) => !bodyIds.has(line.id))
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  const headers = marginLines.filter((line) => regionOf(line, options) === 'header')
  const footers = marginLines.filter((line) => regionOf(line, options) === 'footer')
  // Reading order: running heads, body, page labels.
  const ordered = [...headers, ...orderedBody, ...footers]

  // --- merge into blocks ---------------------------------------------------
  interface OpenBlock {
    region: BlockRegion
    /** The line that opened this block sits inside a footnote region. */
    footnote: boolean
    lines: GroupedLine[]
  }
  const blocks: OpenBlock[] = []

  for (const line of ordered) {
    const region = regionOf(line, options)
    const footnote = footnoteIds.has(line.id)
    // Every note begins a block. Continuations of the *same* note carry no
    // marker (see `markFootnoteRegions`), so this splits note from note
    // without ever splitting a note in half — and it does so even when two
    // adjacent notes are set identically and close enough that `canMerge`
    // would happily read them as one paragraph.
    const opensNote = footnote && footnoteMarker(line.text) !== null
    const current = blocks[blocks.length - 1]
    // A footnote is its own block whatever the geometry says: a note that
    // shares the paragraph's size, indent and leading is still not part of the
    // paragraph, and letting it in would bury its marker mid-sentence.
    if (!current || current.region !== region || current.footnote !== footnote || opensNote) {
      blocks.push({ region, footnote, lines: [line] })
      continue
    }
    const previous = current.lines[current.lines.length - 1]
    const gap = line.bbox.y - (previous.bbox.y + previous.bbox.h)
    const context = { gap, medianSize, bodyGap }
    // Columns of a table align horizontally — allow small x jumps for them.
    // Footnote lines are excluded: citation spacing reads as cells to the row
    // detector, but a note is prose. Each line is judged on its own runs, since
    // the block is not yet known to be a table; `tableForLines` decides that
    // later, once there are enough rows to look for alignment across.
    const previousRow = rowCells(previous) !== null
    const currentRow = rowCells(line) !== null
    if (
      region === 'body' &&
      !footnote &&
      previousRow &&
      currentRow &&
      Math.abs(gap) <= previous.style.fontSize * 1.2
    ) {
      current.lines.push(line)
      continue
    }
    if (region === 'body' && canMerge(previous, line, context)) {
      current.lines.push(line)
      continue
    }
    blocks.push({ region, footnote, lines: [line] })
  }

  // --- materialise ---------------------------------------------------------
  const result: PageBlock[] = []
  // The evidence a previous page's table left behind is about the top of *this*
  // page, so it is spent on the first body block and nowhere else: whatever
  // opens the body is what a cut table would leave, and a block further down is
  // a table of its own however many cells it has.
  let bodySeen = false
  for (const open of blocks) {
    const first = open.lines[0]
    const bbox = mergedBBox(open.lines)
    const isFootnote = open.footnote
    // A code snippet is decided ahead of the list, table and size rules: a
    // `for (const x of xs) {` line can look like a bullet and an aligned block
    // of `|` like a table, and both readings would wreck the indentation the
    // block is about to get back from its own geometry.
    const isCode = open.region === 'body' && !isFootnote && looksLikeCodeBlock(open.lines)
    const opensBody = open.region === 'body' && !bodySeen
    if (open.region === 'body') bodySeen = true
    // A table is *aligned columns across rows*, so it can only be judged once
    // the whole run is here. One line with a wide gap is a long word space; the
    // same gap recurring at the same x on three lines is a column.
    const grid =
      open.region === 'body' && !isFootnote && !isCode
        ? tableForLines(open.lines, opensBody ? options.continuation : null)
        : null
    const isTableRow = grid !== null
    const tableCells = grid ? grid.rows : null
    /** Only set when a cell actually straddles a column: see `TableGrid.spans`. */
    const tableSpans = grid ? grid.spans : null
    const isList =
      !isCode &&
      !isTableRow &&
      open.region === 'body' &&
      !isFootnote &&
      BULLET.test(open.lines[0].text.trim())
    const marker = isList ? (open.lines[0].text.trim().match(BULLET)?.[1] ?? null) : null

    const text = isCode
      ? codeBlockText(open.lines)
      : isTableRow && grid
        ? grid.rows.map((row) => row.join(' \t ')).join('\n')
        : open.lines.map((line) => line.text).join('\n')

    const sizeRatio = medianSize > 0 ? first.style.fontSize / medianSize : 1
    let kind: BlockKind = 'paragraph'
    if (open.region !== 'body') kind = 'paragraph'
    else if (isFootnote) kind = 'footnote'
    else if (isCode) kind = 'code'
    else if (isTableRow) kind = 'table'
    else if (isList) kind = 'list'
    else if (sizeRatio >= 1.25 && text.replace(/\s+/g, ' ').length <= 140) kind = 'heading'
    else if (sizeRatio <= 0.82 && text.replace(/\s+/g, ' ').length <= 220) kind = 'caption'
    else if (sizeRatio >= 1.05 && text.replace(/\s+/g, ' ').length <= 60) kind = 'heading'

    const decision = classifyLine(text.replace(/\n/g, ' ').trim(), options.ctx ?? {})
    const placeholderResult = tokenizePlaceholders(text)
    const rawSpacing =
      open.lines.length > 1 && first.style.fontSize > 0
        ? mergedBBox(open.lines).h / open.lines.length / first.style.fontSize
        : 1.4
    const spacing =
      Number.isFinite(rawSpacing) && rawSpacing >= 1 ? Math.round(rawSpacing * 100) / 100 : 1.4

    result.push({
      id: blockId(options.pageIndex, bbox, text),
      kind,
      region: open.region,
      order: 0,
      text,
      bbox,
      lines: open.lines.map((line) => ({
        id: line.id,
        text: line.text,
        bbox: line.bbox,
        style: line.style,
      })),
      alignment: alignmentOf(
        open.lines.map((line) => ({
          id: line.id,
          text: line.text,
          bbox: line.bbox,
          style: line.style,
        })),
        options.pageWidth,
      ),
      // A code block is never handed to the model, even when its flattened
      // text happens to read as prose line-by-line: `x = 1` four times over
      // scores below the per-line threshold and would come back translated.
      skipRule: decision.skip ? decision.rule : isCode ? 'code' : null,
      placeholders: placeholderResult.placeholders,
      listMarker: marker,
      /** Cells as data: `rows × columns`, rectangular, empty string for a gap. */
      tableCells,
      tableSpans,
      headingLevel: null,
      links: [],
      figures: [],
      lineSpacing: Number.isFinite(spacing) ? spacing : 1.4,
      fontFamily: first.style.fontFamily,
      fontSize: first.style.fontSize,
      bold: first.style.bold,
      italic: first.style.italic,
      color: first.style.color,
    })
  }

  // Blocks that are only a page label lose to the paragraph rules above.
  result.forEach((block, index) => {
    block.order = index
  })
  assignHeadingLevels(result, options.headingSizes ?? [])
  return result
}

/**
 * Depth for every heading on the page.
 *
 * `kind === 'heading'` is a yes/no verdict about one line against one page's
 * body size; the level is a *comparison*, and comparing only within a page is
 * what turns `3.2 Methods` into a level-1 heading on the pages where its
 * chapter title is not present. The document ladder wins whenever the probe
 * supplied one and this page's own headings only fill the gap.
 */
function assignHeadingLevels(blocks: PageBlock[], tiers: readonly number[]): void {
  const headings = blocks.filter((block) => block.kind === 'heading')
  if (headings.length === 0) return
  const ladder = tiers.length > 0 ? tiers : sizeLadder(headings.map((block) => block.fontSize))
  for (const block of headings) {
    block.headingLevel = headingLevelFor(block.fontSize, ladder)
  }
}
