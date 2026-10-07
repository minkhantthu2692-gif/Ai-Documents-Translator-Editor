/**
 * Helpers shared by every export builder.
 *
 * All functions are pure: `ExportDocument` in, string/number out. Nothing here
 * touches the DOM, so the builders run inside the export worker and inside
 * Vitest unchanged.
 */

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

/** Bullet prefix for plain-text formats (`•  `, `1.  `), empty when none. */
export function listPrefix(block: ExportBlock): string {
  if (!block.listMarker) return ''
  const marker = block.listMarker.trim()
  return marker.length > 0 ? `${marker} ` : ''
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
