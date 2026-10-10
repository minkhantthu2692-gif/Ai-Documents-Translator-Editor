/**
 * DOCX export builder (Phase 4).
 *
 * Turns an `ExportDocument` into Office Open XML bytes with the `docx`
 * library. The packing path is browser-safe: the installed docx v9 build has
 * no `Packer.toUint8Array`, so bytes are produced with `Packer.toArrayBuffer`
 * and `Packer.toBlob` + `blob.arrayBuffer()` is the fallback — neither touches
 * Node's `Buffer`, so the export worker can hand the `Uint8Array` back as-is.
 *
 * Every run declares the export font (readers without it fall back to their
 * own default), RTL text gets `w:bidi` on the paragraph and `w:rtl` on the run
 * so Arabic/Hebrew shape correctly, and page geometry flows from the first
 * source page (PDF points → twips, 1pt = 20twips).
 *
 * Pure data in, bytes out: no DOM access, so this runs in a worker and under
 * Vitest (jsdom) unchanged.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { directionOf } from '@/lib/text'
import {
  contentPages,
  headingOffset,
  langTag,
  linkSegments,
  listPrefix,
  pageBlocks,
  tableGrid,
  tableSpansFor,
  textOf,
} from './shared'
import type { ExportBlock, ExportDocument } from './types'
import {
  MAX_FIGURE_WIDTH_PT,
  figureAlt,
  figureArtMap,
  figureGoesBefore,
  figureKey,
  figureSize,
} from './figureArt'
import type { FigureArt } from './figureArt'

/** Options the export worker fills from the export dialog. */
export interface DocxOptions {
  /** Document title (core property + first heading when `titleHeading`). */
  title: string
  /** Emit the source paragraph before the translation for each block. */
  includeOriginal: boolean
  /** Prepend the document title as a Heading 1 paragraph. */
  titleHeading: boolean
  /** Font family declared for every run — readers without it fall back. */
  font: string
  /** Also emit a `Page N` heading between pages. */
  pageHeadings: boolean
  /** Emit an explicit page break between source pages. */
  pageBreaks: boolean
  /**
   * Cropped figures keyed by `figureKey`, embedded as inline PNGs on the side
   * of their block where the page painted them. DOCX has no way to reference
   * art that is not packed into the file, so a figure that failed to render
   * simply is not in the document.
   */
  figures?: FigureArt[]
  /**
   * Widest a figure may print, in PDF points. Defaults to the page minus an
   * inch of margin per side — Word's own default, which this builder does not
   * override.
   */
  maxFigureWidthPt?: number
}

/** docx alignment value for one `BlockAlignment`. */
type DocxAlignment = (typeof AlignmentType)[keyof typeof AlignmentType]

/** `BlockAlignment` → docx `AlignmentType` (docx spells justified `BOTH`). */
const ALIGNMENT_BY_BLOCK: Record<ExportBlock['alignment'], DocxAlignment> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justified: AlignmentType.BOTH,
}

/** docx measures font size in half-points: 12pt → 24 (floor: 1pt = 2). */
function halfPoints(fontSize: number): number {
  return Math.max(2, Math.round(fontSize * 2))
}

/** Line-height ratio → docx line spacing in 240ths of a line (`AUTO` rule). */
function lineUnits(lineHeight: number): number {
  return Math.round(Math.max(lineHeight, 1) * 240)
}

/** docx outline level → the `HeadingLevel` enum (1..6, clamped by `headingOffset`). */
const DOCX_HEADING: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
}

/** The editor stores `#rrggbb`; docx wants bare `RRGGBB`. Bad input → undefined. */
function docxColor(color: string): string | undefined {
  const hex = color.trim().replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : undefined
}

/** Word's hyperlink blue — what a reader already expects a link to look like. */
const LINK_COLOR = '0563C1'

/**
 * The face a `kind: 'code'` block is set in.
 *
 * Word wants one family rather than a stack, so this is named outright; it
 * ships with Office on Windows, macOS and the web, and Word substitutes a
 * monospace face for anything it lacks. Every glyph is one advance width, so
 * the indentation measured back off the PDF's bounding boxes still lines up.
 */
const CODE_FONT = 'Courier New'

/** One run carrying the block's font, size, emphasis and script direction. */
function blockRun(text: string, block: ExportBlock, font: string, breakBefore = false): TextRun {
  const color = docxColor(block.color)
  return new TextRun({
    text,
    font,
    size: halfPoints(block.fontSize),
    // Word discards a bare `\n` inside a run, so a snippet whose lines were
    // joined with newlines would arrive as one unbroken sentence. Each line
    // after the first gets its own run carrying an explicit `<w:br/>`.
    ...(breakBefore ? { break: 1 } : {}),
    ...(block.bold ? { bold: true } : {}),
    ...(block.italic ? { italics: true } : {}),
    ...(color ? { color } : {}),
    ...(directionOf(text) === 'rtl' ? { rightToLeft: true } : {}),
  })
}

/**
 * The paragraph's children: ordinary stretches as runs, anchors as
 * `ExternalHyperlink`s.
 *
 * Word keeps a hyperlink's run-level properties, so an anchor in a Burmese
 * paragraph shapes exactly like the rest of it — same font, size, emphasis,
 * direction. The colour and underline are written out rather than inherited
 * from Word's built-in `Hyperlink` character style, because that style only
 * exists inside Word: LibreOffice and Google Docs render `<w:rStyle
 * w:val="Hyperlink"/>` as nothing at all, and a link a reader cannot see is a
 * link nobody clicks.
 */
function blockChildren(
  text: string,
  block: ExportBlock,
  font: string,
): Array<TextRun | ExternalHyperlink> {
  const runs: Array<TextRun | ExternalHyperlink> = []
  for (const segment of linkSegments(text, block.links)) {
    if (segment.url === null) {
      // One run per line. Only a plain stretch can be split — a hyperlink is
      // a single run, and breaking it apart would lose the anchor.
      segment.text
        .split('\n')
        .forEach((part, index) => runs.push(blockRun(part, block, font, index > 0)))
      continue
    }
    runs.push(
      new ExternalHyperlink({
        children: [
          new TextRun({
            text: segment.text,
            font,
            size: halfPoints(block.fontSize),
            ...(block.bold ? { bold: true } : {}),
            ...(block.italic ? { italics: true } : {}),
            ...(directionOf(segment.text) === 'rtl' ? { rightToLeft: true } : {}),
            color: LINK_COLOR,
            underline: {},
          }),
        ],
        link: segment.url,
      }),
    )
  }
  return runs
}

/** A hairline rule: low-contrast grey, the way a table is ruled on paper. */
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' }

/**
 * One grid for one rendered column (source, then target in a bilingual
 * export), held as *rows* rather than as a built `Table` so the rows of a page
 * that continues over a break can still join it. See `buildChildren`.
 */
interface TablePart {
  grid: string[][]
  /** Measured on `grid` as it was printed, or `null`; see `tableSpansFor`. */
  spans: number[][] | null
  /** The block these rows were printed from — line spacing and links live here. */
  block: ExportBlock
}

/**
 * One grid as the rows of a real Word table, widened to `columns`.
 *
 * Every cell is a `TableCell` — the first row included. Which row (if any) is
 * the header is not something the extractor knows and Word does not require
 * one, so nothing is promoted: Markdown is the only format that must, because
 * its grammar will not parse a table without a header line.
 *
 * The columns are equal. `tableCells` carries cell *text*, not cell boxes, so
 * the PDF's own column widths are not available here — and equal columns are
 * the honest guess: right for the many tables that are evenly ruled, readable
 * for the rest. HTML at least has the block's width to divide up.
 *
 * Word spells the horizontal merge `w:gridSpan`; `docx` names it after the
 * property it writes — `columnSpan`. A merged cell is drawn once and the
 * cells it covers are not drawn at all, or the row comes out a column wider
 * than its neighbours. `tableSpansFor` answers `null` when the printed grid
 * is no longer the shape the spans were measured on, and every cell then
 * stands on its own.
 *
 * `columns` is the width the *whole* table settled on (see `tableOf`); a grid
 * narrower than it is padded at the end with empty cells, so rows printed from
 * different halves of the same table still offer the same column count —
 * which is the one thing Word checks before deciding the file needs repair.
 */
function tableRows(part: TablePart, columns: number, font: string): TableRow[] {
  const spacing = { line: lineUnits(part.block.lineHeight), lineRule: LineRuleType.AUTO }
  const spans = part.spans
  return part.grid.map((cells, rowIndex) => {
    const drawn = cells
      .map((cell, column) => {
        const span = spans ? (spans[rowIndex][column] ?? 1) : 1
        if (span === 0) return null
        return new TableCell({
          ...(span > 1 ? { columnSpan: span } : {}),
          children: [new Paragraph({ spacing, children: blockChildren(cell, part.block, font) })],
        })
      })
      .filter((child): child is TableCell => child !== null)
    const padding = Array.from(
      { length: Math.max(0, columns - cells.length) },
      () =>
        new TableCell({
          children: [new Paragraph({ spacing, children: [new TextRun({ text: '', font })] })],
        }),
    )
    return new TableRow({ children: [...drawn, ...padding] })
  })
}

/**
 * Every grid held open for one column, as a single Word table.
 *
 * A table cut by a page break is still one table — Word paginates a `w:tbl`
 * that is taller than a page all by itself — so the two halves are joined
 * here rather than emitted as two tables that butt up against each other and
 * show a seam where the break was. The widest grid sets the column count.
 */
function tableOf(parts: TablePart[], font: string): Table {
  let columns = 0
  for (const part of parts) {
    for (const cells of part.grid) columns = Math.max(columns, cells.length)
  }
  const rows = parts.flatMap((part) => tableRows(part, columns, font))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: TABLE_BORDER,
      bottom: TABLE_BORDER,
      left: TABLE_BORDER,
      right: TABLE_BORDER,
      insideHorizontal: TABLE_BORDER,
      insideVertical: TABLE_BORDER,
    },
    rows,
  })
}

/** One grid as an open part, spans measured on the grid exactly as printed. */
function tablePartOf(grid: string[][], block: ExportBlock): TablePart {
  return { grid, spans: tableSpansFor(block, grid), block }
}

/** True when a block child is a table waiting for the rest of its rows. */
function isTablePart(part: Paragraph | TablePart): part is TablePart {
  return 'grid' in part
}

/** One paragraph: alignment, RTL direction, line spacing, one run per stretch. */
function blockParagraph(
  text: string,
  block: ExportBlock,
  font: string,
  heading: number | null = null,
): Paragraph {
  const rtl = directionOf(text) === 'rtl'
  return new Paragraph({
    alignment: ALIGNMENT_BY_BLOCK[block.alignment],
    ...(rtl ? { bidirectional: true } : {}),
    ...(heading !== null ? { heading: DOCX_HEADING[heading] } : {}),
    spacing: { line: lineUnits(block.lineHeight), lineRule: LineRuleType.AUTO },
    children: blockChildren(text, block, font),
  })
}

/**
 * The children one block contributes: the primary text first (carrying the
 * list marker), then — with `includeOriginal` — the translation on its own
 * paragraph. Blocks whose text is empty contribute nothing.
 *
 * A `kind === 'table'` block contributes open `TablePart`s instead of
 * paragraphs — rows without a `Table` around them yet, so `buildChildren` can
 * decide whether these rows continue the table above a page break or start a
 * new one. An entry whose text has no cells left in it stays a paragraph (see
 * the branch below), and a block that mixes the two is never a continuation of
 * anything: every entry has to be tabular for the rows to be joined.
 *
 * Exactly one paragraph per block can carry an outline level, and it is the
 * one holding the translation: in a bilingual export the source sits beside
 * it, and a reader navigating by heading wants to land on what the document
 * was turned into, not on the text they already had.
 */
function blockParagraphs(block: ExportBlock, options: DocxOptions): Array<Paragraph | TablePart> {
  const { source, target, primary } = textOf(block, options.includeOriginal)
  const entries: Array<{ text: string; source: boolean }> = []
  if (options.includeOriginal) {
    if (source.trim().length > 0) entries.push({ text: source, source: true })
    if (target.trim().length > 0 && target.trim() !== source.trim()) {
      entries.push({ text: target, source: false })
    }
  } else if (primary.trim().length > 0) {
    entries.push({ text: primary, source: false })
  }
  if (entries.length === 0) return []

  // A table is a table, in both columns of a bilingual export. An entry whose
  // text has no cells left in it — a model that answered a table with one
  // sentence — falls back to a paragraph rather than emitting an empty grid,
  // and if no entry is tabular the whole block falls through.
  if (block.kind === 'table') {
    const grids = entries.map((entry) => tableGrid(entry.text))
    if (grids.some((grid) => grid !== null)) {
      return entries.map((entry, index) => {
        const grid = grids[index]
        return grid
          ? tablePartOf(grid, block)
          : blockParagraph(entry.text, block, options.font, null)
      })
    }
  }

  // The title occupies Heading 1 and an optional `Page N` Heading 2, so the
  // document's own headings start below whichever of those is being emitted.
  const levelsAbove = options.pageHeadings ? 2 : options.titleHeading ? 1 : 0
  const heading = headingOffset(block, levelsAbove)
  const headingIndex = Math.max(
    0,
    entries.findIndex((entry) => !entry.source),
  )
  const marker = listPrefix(block, entries[0].text)
  // Word takes a single family, not a stack, so the code face is named
  // outright: Courier New ships with Office on every platform. It has no
  // Myanmar coverage, but a block only reaches this path after the detector
  // read its lines as Latin code.
  const font = block.kind === 'code' ? CODE_FONT : options.font
  const isCode = block.kind === 'code'

  return entries.map((entry, index) => {
    // A snippet's first line is a statement, not a list item, and never a
    // heading: the size rule that promotes a short line runs *before* the
    // ladder that writes `headingLevel`, so the outline level is held back
    // here as well.
    const text = !isCode && index === 0 ? `${marker}${entry.text}` : entry.text
    return blockParagraph(
      text,
      block,
      font,
      isCode ? null : index === headingIndex ? heading : null,
    )
  })
}

/**
 * The picture paragraphs for one block, split by the side of the block the
 * page painted them on — a figure above its caption stays above it.
 *
 * Word sizes a drawing in CSS pixels at 96 dpi, so a figure keeps the printed
 * size it had on the page (a PDF point is 96/72 of one) and only an over-wide
 * one shrinks to the text column, proportionally. `altText` is the caption
 * when the block has one: an image with no description is invisible to a
 * screen reader, and an empty description is the honest signal that the
 * picture carries nothing the text does not already say.
 */
function blockFigures(
  block: ExportBlock,
  maxFigureWidthPt: number,
  art: Map<string, FigureArt>,
): { before: Paragraph[]; after: Paragraph[] } {
  if (art.size === 0 || block.figures.length === 0) return { before: [], after: [] }
  const before: Paragraph[] = []
  const after: Paragraph[] = []
  block.figures.forEach((figure, index) => {
    const found = art.get(figureKey(block.id, index))
    if (!found) return
    const size = figureSize(figure.bbox, maxFigureWidthPt)
    const picture = new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      children: [
        new ImageRun({
          type: 'png',
          data: found.bytes,
          transformation: { width: size.widthPx, height: size.heightPx },
          altText: { name: found.key, description: figureAlt(block) },
        }),
      ],
    })
    ;(figureGoesBefore(block, figure.bbox) ? before : after).push(picture)
  })
  return { before, after }
}

/**
 * How wide a figure may print: the page minus an inch of margin per side,
 * which is what Word uses when a section declares none (and this builder
 * declares none). Clamped so a very narrow page still shows something.
 */
function figureColumnWidth(doc: ExportDocument): number {
  const width = doc.pages[0]?.width ?? 0
  return Math.max(72, Math.min(MAX_FIGURE_WIDTH_PT, width - 144))
}

/** First source page geometry (PDF points) → section page size in twips. */
function pageSizeOf(
  doc: ExportDocument,
): { page: { size: { width: number; height: number } } } | undefined {
  const first = doc.pages[0]
  if (!first) return undefined
  const width = Math.round(first.width * 20)
  const height = Math.round(first.height * 20)
  if (width <= 0 || height <= 0) return undefined
  return { page: { size: { width, height } } }
}

/**
 * Title heading, page headings, page breaks and every block, in order.
 *
 * Tables are built *lazily*: a `Table` is not made until the block that ends
 * it is known, because a table cut by a page break is still one table and the
 * rows on the far side of the break arrive a page later. While a table is
 * open, everything else — the `Page N` marker, a running head, a footer — is
 * *deferred* rather than flushed, and lands just after the joined table when
 * it closes. Those are markers printed where they were on their page, and a
 * reader is better served by one unseamed table with the marker a few rows
 * late than by two tables with a seam where the page broke (see
 * `ExportBlock.tableContinuation`).
 */
function buildChildren(doc: ExportDocument, options: DocxOptions): Array<Paragraph | Table> {
  const children: Array<Paragraph | Table> = []
  if (options.titleHeading && options.title.trim().length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: options.title, font: options.font })],
      }),
    )
  }
  let pagesEmitted = 0
  const art = figureArtMap(options.figures)
  const maxFigureWidthPt = options.maxFigureWidthPt ?? figureColumnWidth(doc)
  /** Rows held open, one list per rendered column (source, then target). */
  let open: TablePart[][] | null = null
  /** Markers waiting for the open table to close, in the order they arrived. */
  let deferred: Array<Paragraph | Table> = []
  const toChild = (part: Paragraph | TablePart): Paragraph | Table =>
    isTablePart(part) ? tableOf([part], options.font) : part
  const emit = (item: Paragraph | Table): void => {
    if (open !== null) deferred.push(item)
    else children.push(item)
  }
  const flush = (): void => {
    if (open === null) return
    for (const parts of open) {
      if (parts.length > 0) children.push(tableOf(parts, options.font))
    }
    open = null
    children.push(...deferred)
    deferred = []
  }
  /** True when `parts` are the next rows of the table held open. */
  const joinsOpen = (block: ExportBlock, parts: Array<Paragraph | TablePart>): boolean =>
    block.kind === 'table' &&
    block.tableContinuation === true &&
    open !== null &&
    parts.length === open.length &&
    parts.every(isTablePart)
  for (const page of contentPages(doc)) {
    const blocks = pageBlocks(page)
    if (blocks.length === 0) continue
    // Does this page open with the rest of the table still held open? The
    // first *body* block is what the mark was set on: a running head prints
    // above it but is not content between the two halves.
    const firstBody = blocks.find((block) => block.region === 'body')
    const continues =
      open !== null &&
      firstBody !== undefined &&
      firstBody.kind === 'table' &&
      firstBody.tableContinuation === true
    if (options.pageBreaks && pagesEmitted > 0) {
      if (!continues) {
        // A table the break did *not* cut ends here, and the break follows it.
        flush()
        children.push(new Paragraph({ children: [new PageBreak()] }))
      }
      // Otherwise the break is spent on the join itself: Word breaks a `w:tbl`
      // taller than a page all by itself, and forcing one after the table
      // would push everything that follows it a page further on than the
      // source had it.
    }
    if (options.pageHeadings) {
      emit(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: `Page ${page.index + 1}`, font: options.font })],
        }),
      )
    }
    for (const block of blocks) {
      const figures = blockFigures(block, maxFigureWidthPt, art)
      if (figures.before.length > 0) {
        // Artwork closes the table: a picture between two halves of one is a
        // reason to draw them as the two blocks they are.
        flush()
        for (const figure of figures.before) emit(figure)
      }
      const parts = blockParagraphs(block, options)
      if (joinsOpen(block, parts)) {
        const target = open ?? []
        parts.forEach((part, index) => {
          if (isTablePart(part)) target[index].push(part)
        })
      } else if (block.region !== 'body') {
        // A running head or a page footer: not content between a table and its
        // continuation, so it waits rather than closing the table.
        for (const part of parts) emit(toChild(part))
      } else {
        flush()
        if (parts.length > 0 && isTablePart(parts[0])) {
          // Rows first: a table starts *open* so the rows waiting on the next
          // page can join it, and anything this block contributes after its
          // table (a bilingual export where the model answered a table with
          // one sentence) waits with the markers — which lands it after the
          // table, where it was. An entry ahead of the table cannot wait, so
          // the table would not be opened at all; that order cannot arise
          // from `blockParagraphs` for a table block, and the fallback keeps
          // its rows correct if it ever does.
          open = parts.map((part) => (isTablePart(part) ? [part] : []))
          for (const part of parts) {
            if (!isTablePart(part)) emit(toChild(part))
          }
        } else {
          for (const part of parts) emit(toChild(part))
        }
      }
      if (figures.after.length > 0) {
        flush()
        for (const figure of figures.after) emit(figure)
      }
    }
    pagesEmitted += 1
  }
  flush()
  return children
}

/**
 * docx v9 exposes no `Packer.toUint8Array`; `toArrayBuffer` is the
 * browser-safe packer in the installed build and `toBlob` + `blob.arrayBuffer`
 * covers builds where it is missing. The primary failure is re-thrown so the
 * real packing error is never hidden by the fallback.
 */
async function packDocument(file: Document): Promise<Uint8Array> {
  try {
    return new Uint8Array(await Packer.toArrayBuffer(file))
  } catch (primary) {
    try {
      const blob = await Packer.toBlob(file)
      return new Uint8Array(await blob.arrayBuffer())
    } catch {
      throw primary
    }
  }
}

/**
 * Builds DOCX bytes (browser-safe: returns a Uint8Array).
 *
 * @throws {Error} `DOCX_FAILED: <detail>` when building or packing fails.
 */
export async function buildDocx(doc: ExportDocument, options: DocxOptions): Promise<Uint8Array> {
  try {
    const document = new Document({
      creator: 'AI Documents Translator',
      title: options.title,
      description: `${langTag(doc.sourceLang)} → ${langTag(doc.targetLang)}`,
      styles: { default: { document: { run: { font: options.font } } } },
      sections: [{ properties: pageSizeOf(doc), children: buildChildren(doc, options) }],
    })
    return await packDocument(document)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`DOCX_FAILED: ${detail}`)
  }
}
