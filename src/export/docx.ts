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
  textOf,
} from './shared'
import type { ExportBlock, ExportDocument } from './types'

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
 * One grid as a real Word table.
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
 */
function blockTable(grid: string[][], block: ExportBlock, font: string): Table {
  const spacing = { line: lineUnits(block.lineHeight), lineRule: LineRuleType.AUTO }
  const rows = grid.map(
    (cells) =>
      new TableRow({
        children: cells.map(
          (cell) =>
            new TableCell({
              children: [new Paragraph({ spacing, children: blockChildren(cell, block, font) })],
            }),
        ),
      }),
  )
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
 * A `kind === 'table'` block contributes `Table`s instead of paragraphs; see
 * `blockTable`.
 *
 * Exactly one paragraph per block can carry an outline level, and it is the
 * one holding the translation: in a bilingual export the source sits beside
 * it, and a reader navigating by heading wants to land on what the document
 * was turned into, not on the text they already had.
 */
function blockParagraphs(block: ExportBlock, options: DocxOptions): Array<Paragraph | Table> {
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
          ? blockTable(grid, block, options.font)
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

/** Title heading, page headings, page breaks and every block, in order. */
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
  for (const page of contentPages(doc)) {
    const blocks = pageBlocks(page)
    if (blocks.length === 0) continue
    if (options.pageBreaks && pagesEmitted > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }))
    }
    if (options.pageHeadings) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: `Page ${page.index + 1}`, font: options.font })],
        }),
      )
    }
    for (const block of blocks) {
      children.push(...blockParagraphs(block, options))
    }
    pagesEmitted += 1
  }
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
