/**
 * Helpers shared by every export builder.
 *
 * All functions are pure: `ExportDocument` in, string/number out. Nothing here
 * touches the DOM, so the builders run inside the export worker and inside
 * Vitest unchanged.
 */

import { safeLinkUrl, type LinkRef } from '@/pdf/links'
import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportBlock,
  type ExportDocument,
  type ExportFormat,
  type ExportOptions,
  type ExportPage,
} from './types'

/** Fallback chain appended after a block's own family (Myanmar must shape). */
export const DEFAULT_FONT_STACK = '"Noto Sans Myanmar", "Padauk", sans-serif'

/** Escapes text for an HTML text node or attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Quotes a font family for use inside a CSS `font-family` value. */
export function cssFontName(family: string): string {
  const trimmed = family.trim()
  if (trimmed.length === 0) return 'sans-serif'
  return /^[-A-Za-z0-9]+$/.test(trimmed) ? trimmed : `"${trimmed.replace(/"/g, '')}"`
}

/**
 * Full CSS font-family list for one block: its own family first, then the
 * export font stack (which always carries Myanmar-capable families so
 * ligatures and stacked consonants render even when the PDF font is Latin).
 */
export function fontStackFor(
  block: ExportBlock,
  options?: Pick<ExportOptions, 'fontStack'>,
): string {
  const primary = cssFontName(block.fontFamily)
  const extra = options?.fontStack?.trim() ?? ''
  const rest = extra.length > 0 ? `${extra}, ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK
  return rest.includes(primary) ? rest : `${primary}, ${rest}`
}

/** Blocks that actually carry text, in reading order. */
export function pageBlocks(page: ExportPage): ExportBlock[] {
  return [...page.blocks]
    .filter((block) => (block.translatedText || block.sourceText).trim().length > 0)
    .sort((a, b) => a.order - b.order)
}

/** Pages that carry at least one text block, in index order. */
export function contentPages(doc: ExportDocument): ExportPage[] {
  return doc.pages.filter((page) => pageBlocks(page).length > 0)
}

/** The text a format should show for a block (honours `includeOriginal`). */
export function textOf(
  block: ExportBlock,
  includeOriginal: boolean,
): {
  source: string
  target: string
  /** What goes in the primary column. */
  primary: string
} {
  const source = block.sourceText
  const target = block.translatedText.length > 0 ? block.translatedText : block.sourceText
  return { source, target, primary: includeOriginal ? source : target }
}

/**
 * Bullet prefix for plain-text formats (`•  `, `1.  `), empty when there is no
 * marker or when `text` already carries it.
 *
 * A parsed list line holds its bullet **twice**: inside the text pdf.js handed
 * us (the glyph really is part of the line) and in `listMarker`, which every
 * builder puts back in front. Translation keeps the copy out of the target —
 * prompt rule 3 — but the source fallback is shown verbatim, so a prefix that
 * blindly prepended printed `• • item` for every not-yet-translated block (and
 * for any model that ignored the rule). Pass the text you are about to prefix
 * and the call becomes idempotent: the marker appears exactly once, whichever
 * of the two copies it came from.
 *
 * The test needs the marker to be a genuine *prefix* — `1.` must not swallow
 * `1.5` — so the rest of the text has to start at a word boundary.
 */
export function listPrefix(block: ExportBlock, text?: string): string {
  if (!block.listMarker) return ''
  const marker = block.listMarker.trim()
  if (marker.length === 0) return ''
  if (text !== undefined) {
    const body = text.trimStart()
    const rest = body.slice(marker.length)
    if (body.startsWith(marker) && (body === marker || /^\s/.test(rest))) return ''
  }
  return `${marker} `
}

/**
 * Heading level a builder should actually emit for `block`.
 *
 * The extracted level counts *inside the document's own headings* (1..6) but
 * every structural heading a builder puts above them — the document title, an
 * optional `## Page N` — occupies the levels before it. Offsetting keeps the
 * block's own hierarchy intact while making sure no block heading lands on the
 * same level as one of them; the result is clamped to six because that is as
 * deep as HTML, docx and Markdown go, so only the deepest pair collide.
 *
 * Returns null for anything that is not a heading.
 */
export function headingOffset(block: ExportBlock, levelsAbove: number): number | null {
  if (block.headingLevel === null) return null
  return Math.min(6, Math.max(1, block.headingLevel) + Math.max(0, levelsAbove))
}

/** How a builder escapes the stretches of text between links. */
export type LinkPlain = (segment: string) => string

/** Wraps one anchor, already proven safe to navigate to. */
export type LinkWrap = (url: string, anchor: string) => string

/** A stretch of a block's text: ordinary, or the target of one link. */
export interface LinkSegment {
  text: string
  /** null = ordinary text; otherwise the URL this stretch points at. */
  url: string | null
}

/**
 * Splits `text` into ordinary stretches and linked anchors.
 *
 * An annotation never tells us *which* words it covered — `links.ts` recovers
 * them geometrically and stores them as substrings of the block's source text.
 * A translation moves those words somewhere else (or replaces them), so the
 * match is attempted against whatever this builder is about to print and, when
 * the words are gone, against a literal occurrence of the URL, which is the
 * one thing a model reliably keeps.
 *
 * Two rules keep the output safe: a link fires at most once even though it is
 * offered twice (words first, URL second), and the leftmost match wins so two
 * anchors can never overlap — an `<a>` inside an `<a>`, or a Markdown link
 * label cut in half.
 */
export function linkSegments(text: string, links: readonly LinkRef[]): LinkSegment[] {
  if (text.length === 0 || links.length === 0) return [{ text, url: null }]

  // Each link is offered as the words it covered, then — if that is not what
  // came out of the translation — as the URL verbatim.
  const offered: Array<{ link: LinkRef; needle: string }> = []
  for (const link of links) {
    if (safeLinkUrl(link.url) === null) continue
    if (link.text.trim().length > 0) offered.push({ link, needle: link.text })
    if (link.url.length > 0 && link.url !== link.text) offered.push({ link, needle: link.url })
  }
  if (offered.length === 0) return [{ text, url: null }]

  const segments: LinkSegment[] = []
  const fired = new Set<LinkRef>()
  let cursor = 0
  for (;;) {
    let best: { link: LinkRef; needle: string; index: number } | null = null
    for (const candidate of offered) {
      if (fired.has(candidate.link)) continue
      const index = text.indexOf(candidate.needle, cursor)
      if (index < 0) continue
      const wins =
        best === null ||
        index < best.index ||
        (index === best.index && candidate.needle.length > best.needle.length)
      if (wins) best = { link: candidate.link, needle: candidate.needle, index }
    }
    if (best === null) break
    if (best.index > cursor) segments.push({ text: text.slice(cursor, best.index), url: null })
    segments.push({ text: best.needle, url: best.link.url })
    fired.add(best.link)
    cursor = best.index + best.needle.length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), url: null })
  return segments.length > 0 ? segments : [{ text, url: null }]
}

/**
 * `linkSegments` with the markup already applied.
 *
 * `plain` is what every non-link stretch becomes, which is how HTML escapes
 * text without the anchors being double-escaped by the same pass. Builders
 * that emit objects instead of strings (docx) call `linkSegments` directly.
 */
export function applyLinks(
  text: string,
  links: readonly LinkRef[],
  wrap: LinkWrap,
  plain: LinkPlain = (segment) => segment,
): string {
  return linkSegments(text, links)
    .map((segment) =>
      segment.url === null ? plain(segment.text) : wrap(segment.url, segment.text),
    )
    .join('')
}

export interface DocumentStats {
  pages: number
  blocks: number
  translated: number
  untranslated: number
  overflow: number
  suggestions: number
  locked: number
}

export function documentStats(doc: ExportDocument): DocumentStats {
  const stats: DocumentStats = {
    pages: doc.pages.length,
    blocks: 0,
    translated: 0,
    untranslated: 0,
    overflow: 0,
    suggestions: 0,
    locked: 0,
  }
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.sourceText.trim().length === 0 && block.translatedText.trim().length === 0) continue
      stats.blocks += 1
      if (block.translatedText.trim().length > 0) stats.translated += 1
      else stats.untranslated += 1
      if (block.overflow) stats.overflow += 1
      if (block.hasSuggestion) stats.suggestions += 1
      if (block.status === 'locked') stats.locked += 1
    }
  }
  return stats
}

export function isDocumentEmpty(doc: ExportDocument): boolean {
  return documentStats(doc).blocks === 0
}

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  pdf: 'pdf',
  'pdf-raster': 'pdf',
  'bilingual-pdf': 'pdf',
  docx: 'docx',
  html: 'html',
  markdown: 'md',
  text: 'txt',
  epub: 'epub',
  json: 'json',
  csv: 'csv',
  tsv: 'tsv',
  images: 'zip',
}

export const FORMAT_MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  'pdf-raster': 'application/pdf',
  'bilingual-pdf': 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  text: 'text/plain;charset=utf-8',
  epub: 'application/epub+zip',
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  tsv: 'text/tab-separated-values;charset=utf-8',
  images: 'application/zip',
}

/**
 * `My Report (v2).pdf` → `my-report-v2` — safe on every OS, keeps the words.
 */
export function slugify(input: string, fallback = 'document'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return slug.length > 0 ? slug.slice(0, 60) : fallback
}

/** File name (with extension) an artifact should be saved as. */
export function fileNameFor(options: ExportOptions, format: ExportFormat): string {
  const base = options.fileName.trim().length > 0 ? options.fileName : 'document'
  return `${base}.${FORMAT_EXTENSIONS[format]}`
}

export function resolvedOptions(partial?: Partial<ExportOptions>): ExportOptions {
  return { ...DEFAULT_EXPORT_OPTIONS, ...partial }
}

/** pt → CSS units (1pt = 1/72in = 1px at the 96dpi CSS reference). */
export function pt(value: number): string {
  return `${round(value, 3)}pt`
}

/** px → pt for the print frame (browsers print in physical units). */
export function pxToPt(px: number): number {
  return round((px * 72) / 96, 3)
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** BCP-47-ish language tag for `lang=`/`xml:lang=` attributes. */
export function langTag(code: string): string {
  const trimmed = (code || '').trim()
  if (trimmed.length === 0) return 'en'
  if (trimmed.length <= 3) return trimmed.toLowerCase()
  const [main, ...rest] = trimmed.split(/[-_]/)
  return [main.toLowerCase(), ...rest.map((part) => part.toUpperCase())].join('-')
}
