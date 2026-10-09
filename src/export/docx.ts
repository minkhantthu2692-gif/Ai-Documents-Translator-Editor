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
  Document,
  HeadingLevel,
  LineRuleType,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
} from 'docx'
import { directionOf } from '@/lib/text'
import { contentPages, headingOffset, langTag, listPrefix, pageBlocks, textOf } from './shared'
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

/** One run carrying the block's font, size, emphasis and script direction. */
function blockRun(text: string, block: ExportBlock, font: string): TextRun {
  const color = docxColor(block.color)
  return new TextRun({
    text,
    font,
    size: halfPoints(block.fontSize),
    ...(block.bold ? { bold: true } : {}),
    ...(block.italic ? { italics: true } : {}),
    ...(color ? { color } : {}),
    ...(directionOf(text) === 'rtl' ? { rightToLeft: true } : {}),
  })
}

/** One paragraph: alignment, RTL direction, line spacing, exactly one run. */
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
    children: [blockRun(text, block, font)],
  })
}

/**
 * The paragraphs for one block: the primary text always first (carrying the
 * list marker), then — with `includeOriginal` — the translation on its own
 * paragraph. Blocks whose text is empty contribute nothing.
 *
 * Exactly one paragraph per block can carry an outline level, and it is the
 * one holding the translation: in a bilingual export the source sits beside
 * it, and a reader navigating by heading wants to land on what the document
 * was turned into, not on the text they already had.
 */
function blockParagraphs(block: ExportBlock, options: DocxOptions): Paragraph[] {
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

  // The title occupies Heading 1 and an optional `Page N` Heading 2, so the
  // document's own headings start below whichever of those is being emitted.
  const levelsAbove = options.pageHeadings ? 2 : options.titleHeading ? 1 : 0
  const heading = headingOffset(block, levelsAbove)
  const headingIndex = Math.max(
    0,
    entries.findIndex((entry) => !entry.source),
  )
  const marker = listPrefix(block, entries[0].text)

  return entries.map((entry, index) => {
    const text = index === 0 ? `${marker}${entry.text}` : entry.text
    return blockParagraph(text, block, options.font, index === headingIndex ? heading : null)
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
function buildChildren(doc: ExportDocument, options: DocxOptions): Paragraph[] {
  const children: Paragraph[] = []
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
