/**
 * EPUB 3 export builder (Phase 4).
 *
 * Assembles a spec-shaped EPUB 3 container with JSZip, no DOM involved:
 *
 * - `mimetype` first and STORE-compressed, then `META-INF/container.xml`
 * - `OEBPS/content.opf` — dc metadata, `dcterms:modified`, manifest + spine
 * - `OEBPS/nav.xhtml` — EPUB 3 navigation document, chapters grouped from
 *   content pages (at most 20 pages each) and labelled `Page N` / `Page N–M`
 * - `OEBPS/css/main.css` — body font stack, optional base64 `@font-face`
 *   payloads, `.block.rtl` and `.source` rules
 * - `OEBPS/text/chap_N.xhtml` — valid XHTML: escaped text, `xml:lang` per
 *   paragraph, `dir="rtl"` + `block rtl` classes on right-to-left blocks, and
 *   the source paragraph (`class="source block"`) before the translation when
 *   `includeOriginal` is on
 *
 * Every piece of user-supplied text goes through `escapeHtml`, so chapters
 * parse as XML in `DOMParser` (and in epubcheck) unchanged.
 */

import JSZip from 'jszip'
import { directionOf } from '@/lib/text'
import {
  DEFAULT_FONT_STACK,
  contentPages,
  cssFontName,
  escapeHtml,
  fontStackFor,
  headingOffset,
  langTag,
  listPrefix,
  pageBlocks,
  textOf,
} from './shared'
import type { ExportBlock, ExportDocument, ExportPage } from './types'

/** Options the export worker fills from the export dialog. */
export interface EpubOptions {
  title: string
  author: string
  lang: string
  includeOriginal: boolean
  /** CSS font-family list used by the chapters (Myanmar must be listed). */
  fontStack: string
  /** Optional base64 font payload: { fileName, mimeType, base64 }[] injected as @font-face src url(data:...). */
  fonts?: Array<{ fileName: string; mimeType: string; base64: string }>
}

/** Source pages per chapter — keeps the navigation document small. */
const PAGES_PER_CHAPTER = 20

/**
 * Level of the deepest structural heading a chapter prints above its blocks:
 * each page opens with an `<h2>Page N</h2>`, so the document's own headings
 * have to start at `h3`. Anything deeper than `h6` clamps (see `headingOffset`).
 */
const CHAPTER_LEVELS_ABOVE = 2

/** EPUB requires this exact first entry, stored uncompressed. */
const MIMETYPE = 'application/epub+zip'

const CONTAINER_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
  '  <rootfiles>',
  '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
  '  </rootfiles>',
  '</container>',
  '',
].join('\n')

/** Shared XHTML5 skeleton: declaration, doctype, `lang` + `xml:lang` root. */
function xhtml(
  title: string,
  lang: string,
  head: readonly string[],
  body: readonly string[],
): string {
  const safeLang = escapeHtml(lang)
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="${safeLang}" xml:lang="${safeLang}">`,
    '<head>',
    `  <title>${escapeHtml(title)}</title>`,
    '  <meta charset="utf-8"/>',
    ...head,
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** Splits content pages into chapters of at most `PAGES_PER_CHAPTER`. */
function groupPages(pages: ExportPage[]): ExportPage[][] {
  const chapters: ExportPage[][] = []
  for (let start = 0; start < pages.length; start += PAGES_PER_CHAPTER) {
    chapters.push(pages.slice(start, start + PAGES_PER_CHAPTER))
  }
  return chapters
}

/** `Page 7` for a single page, `Page 1–20` for a run of pages. */
function chapterLabel(pages: ExportPage[]): string {
  const first = (pages[0]?.index ?? 0) + 1
  const last = (pages[pages.length - 1]?.index ?? 0) + 1
  return first === last ? `Page ${first}` : `Page ${first}–${last}`
}

/** One paragraph: classes (`source`/`block`/`rtl`), lang, direction and style. */
function paragraph(
  text: string,
  classes: readonly string[],
  lang: string,
  style: string,
  heading: number | null = null,
): string {
  const rtl = directionOf(text) === 'rtl'
  const all = rtl ? [...classes, 'rtl'] : classes
  const dir = rtl ? ' dir="rtl"' : ''
  const safeLang = escapeHtml(lang)
  // A heading keeps its classes and inline style and only changes tag, so the
  // reader's own heading stylesheet is what makes it stand out — the same way
  // it did in the source PDF, where it was simply set larger.
  const tag = heading === null ? 'p' : `h${heading}`
  return `<${tag} class="${escapeHtml(all.join(' '))}" xml:lang="${safeLang}" lang="${safeLang}"${dir}${style}>${escapeHtml(text)}</${tag}>`
}

/**
 * The paragraphs for one block: the primary text always first (carrying the
 * list marker), then — with `includeOriginal` — the translation on its own
 * paragraph. Blocks whose text is empty contribute nothing.
 *
 * Exactly one of them carries the heading level, and it is the one holding
 * the translation (falling back to the source when there is no translation
 * yet) — a bilingual book would otherwise list every heading twice.
 */
function blockParagraphs(block: ExportBlock, doc: ExportDocument, options: EpubOptions): string[] {
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
  const headingIndex = Math.max(
    0,
    entries.findIndex((entry) => !entry.source),
  )
  const fontStack = escapeHtml(fontStackFor(block, { fontStack: options.fontStack }))
  const style = ` style="font-family: ${fontStack}"`
  return entries.map((entry, index) => {
    const lang = entry.source ? langTag(doc.sourceLang) : langTag(doc.targetLang)
    const text = index === 0 ? `${listPrefix(block, entry.text)}${entry.text}` : entry.text
    return paragraph(
      text,
      entry.source ? ['source', 'block'] : ['block'],
      lang,
      style,
      index === headingIndex ? headingOffset(block, CHAPTER_LEVELS_ABOVE) : null,
    )
  })
}

/** One chapter: an `<h2>` per source page, then that page's blocks. */
function chapterXhtml(pages: ExportPage[], doc: ExportDocument, options: EpubOptions): string {
  const body: string[] = []
  for (const page of pages) {
    body.push(`  <h2>Page ${page.index + 1}</h2>`)
    for (const block of pageBlocks(page)) {
      for (const line of blockParagraphs(block, doc, options)) {
        body.push(`  ${line}`)
      }
    }
  }
  return xhtml(
    options.title,
    langTag(options.lang),
    ['  <link rel="stylesheet" type="text/css" href="../css/main.css"/>'],
    body,
  )
}

/** EPUB 3 navigation document: one entry per chapter. */
function navXhtml(title: string, lang: string, chapters: readonly ExportPage[][]): string {
  const safeLang = escapeHtml(lang)
  const items = chapters.map(
    (pages, index) =>
      `    <li><a href="text/chap_${index + 1}.xhtml">${escapeHtml(chapterLabel(pages))}</a></li>`,
  )
  const body = [
    '  <nav epub="toc" id="toc">',
    `    <h1>${escapeHtml(title)}</h1>`,
    '    <ol>',
    ...items,
    '    </ol>',
    '  </nav>',
  ]
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${safeLang}" xml:lang="${safeLang}">`,
    '<head>',
    `  <title>${escapeHtml(title)}</title>`,
    '  <meta charset="utf-8"/>',
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** FNV-1a (32-bit) over UTF-16 code units — small, stable, dependency-free. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Deterministic `urn:uuid:` so re-exporting the same snapshot matches. */
function bookIdentifier(doc: ExportDocument): string {
  const seed = `${doc.projectId}|${doc.exportedAt}|${doc.title}`
  let hex = ''
  for (let round = 0; round < 8; round += 1) {
    hex += fnv1a(`${seed}#${round}`).toString(16).padStart(8, '0')
  }
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** `dcterms:modified` must be `YYYY-MM-DDTHH:MM:SSZ` (UTC, no millis). */
function modifiedStamp(exportedAt: number): string {
  const time = Number.isFinite(exportedAt) && exportedAt > 0 ? exportedAt : Date.now()
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** OPF package document: metadata, manifest and spine in reading order. */
function contentOpf(
  doc: ExportDocument,
  options: EpubOptions,
  chapters: readonly ExportPage[][],
): string {
  const lang = langTag(options.lang)
  const manifest = chapters.map(
    (_, index) =>
      `    <item id="chapter-${index + 1}" href="text/chap_${index + 1}.xhtml" media-type="application/xhtml+xml"/>`,
  )
  const spine = chapters.map((_, index) => `    <itemref idref="chapter-${index + 1}"/>`)
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeHtml(lang)}">`,
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="book-id">${bookIdentifier(doc)}</dc:identifier>`,
    `    <dc:title>${escapeHtml(options.title)}</dc:title>`,
    `    <dc:language>${escapeHtml(lang)}</dc:language>`,
    `    <dc:creator>${escapeHtml(options.author)}</dc:creator>`,
    `    <meta property="dcterms:modified">${modifiedStamp(doc.exportedAt)}</meta>`,
    '  </metadata>',
    '  <manifest>',
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="css/main.css" media-type="text/css"/>',
    ...manifest,
    '  </manifest>',
    '  <spine>',
    ...spine,
    '  </spine>',
    '</package>',
    '',
  ].join('\n')
}

/** Chapter stylesheet: `@font-face` data URLs, body stack, rtl/source rules. */
function mainCss(options: EpubOptions): string {
  const bodyStack = options.fontStack.trim().length > 0 ? options.fontStack : DEFAULT_FONT_STACK
  const rules: string[] = []
  for (const font of options.fonts ?? []) {
    const family = cssFontName(font.fileName.replace(/\.[^.]+$/, ''))
    rules.push(
      '@font-face {',
      `  font-family: ${family};`,
      `  src: url(data:${font.mimeType};base64,${font.base64});`,
      '}',
    )
  }
  rules.push(
    'body {',
    `  font-family: ${bodyStack};`,
    '  line-height: 1.7;',
    '}',
    '.block.rtl {',
    '  direction: rtl;',
    '}',
    '.source {',
    '  color: #555;',
    '  font-size: 0.9em;',
    '}',
  )
  return `${rules.join('\n')}\n`
}

/** Returns EPUB bytes (Uint8Array). */
export async function buildEpub(doc: ExportDocument, options: EpubOptions): Promise<Uint8Array> {
  const chapters = groupPages(contentPages(doc))
  const zip = new JSZip()
  // Must stay the first entry: readers verify it without unzipping.
  zip.file('mimetype', MIMETYPE, { compression: 'STORE' })
  zip.file('META-INF/container.xml', CONTAINER_XML)
  zip.file('OEBPS/content.opf', contentOpf(doc, options, chapters))
  zip.file('OEBPS/nav.xhtml', navXhtml(options.title, langTag(options.lang), chapters))
  zip.file('OEBPS/css/main.css', mainCss(options))
  chapters.forEach((pages, index) => {
    zip.file(`OEBPS/text/chap_${index + 1}.xhtml`, chapterXhtml(pages, doc, options))
  })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
