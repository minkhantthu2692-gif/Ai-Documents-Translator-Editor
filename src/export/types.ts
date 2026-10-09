/**
 * Export payload types (Phase 4).
 *
 * The main thread collects an `ExportDocument` from IndexedDB (plain data,
 * structured-cloneable) and hands it to the export worker, which builds the
 * file. Every builder in `src/export/*` is a pure function of this document so
 * it can be unit tested without a DOM or a worker.
 */

import type {
  BlockAlignment,
  BlockKind,
  BlockRegion,
  BlockStatus,
  PageContentClass,
} from '@/db/types'
import type { Placeholder } from '@/pdf/placeholders'
import type { LinkRef } from '@/pdf/structure'
import type { SkipRule } from '@/pdf/skipRules'

/** Bump when the payload shape changes in a way old workers cannot read. */
export const EXPORT_SCHEMA = 1

export type ExportFormat =
  /** Print-optimized HTML in a hidden iframe → browser print-to-PDF. */
  | 'pdf'
  /** Page canvases embedded as images in a PDF (pixel-accurate, not selectable). */
  | 'pdf-raster'
  /** Side-by-side / interleaved source+translation through the print frame. */
  | 'bilingual-pdf'
  | 'docx'
  | 'html'
  | 'markdown'
  | 'text'
  | 'epub'
  | 'json'
  | 'csv'
  | 'tsv'
  /** One PNG/JPG per page, zipped. */
  | 'images'

export type ExportImageFormat = 'png' | 'jpg'
export type BilingualMode = 'side-by-side' | 'interleaved'
export type TextDirection = 'ltr' | 'rtl'

/** Formats whose bytes are produced inside the export worker. */
export const WORKER_FORMATS: readonly ExportFormat[] = [
  'pdf-raster',
  'docx',
  'html',
  'markdown',
  'text',
  'epub',
  'json',
  'csv',
  'tsv',
  'images',
]

export interface ExportBlock {
  id: string
  order: number
  kind: BlockKind
  region: BlockRegion
  status: BlockStatus
  alignment: BlockAlignment
  /** Geometry in PDF points relative to the page. */
  x: number
  y: number
  width: number
  height: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  color: string
  bold: boolean
  italic: boolean
  listMarker: string | null
  /**
   * 1..6 when `kind === 'heading'`, else null. The number is only meaningful
   * relative to the other headings in the document, so a builder that already
   * emits structural headings of its own (a title, a `## Page N`) must offset
   * by them rather than print the raw level — see `headingOffset` in
   * `shared.ts`.
   */
  headingLevel: number | null
  /**
   * External `/Link` annotations that landed on this block, in reading order.
   * Every `text` is a substring of `sourceText` — that is what lets a builder
   * wrap it without re-parsing the string — but it is a substring of
   * `translatedText` only when the model kept the words, which is why the
   * helpers in `shared.ts` fall back to wrapping a literal occurrence of the
   * URL itself.
   */
  links: LinkRef[]
  sourceText: string
  translatedText: string
  characterCount: number
  skipRule: SkipRule | null
  placeholders: Placeholder[]
  /** Arabic/Hebrew (or any RTL run) → right-to-left layout in every format. */
  direction: TextDirection
  /** Effective size after auto-fit (null = untouched, uses `fontSize`). */
  fittedFontSize: number | null
  /** Text measured taller/wider than the original bbox. */
  overflow: boolean
  /** Pending AI suggestion, so an export can report "N unreviewed blocks". */
  hasSuggestion: boolean
}

export interface ExportPage {
  index: number
  width: number
  height: number
  rotation: number
  contentClass: PageContentClass
  blocks: ExportBlock[]
}

export interface ExportDocument {
  schema: number
  projectId: string
  title: string
  sourceFileName: string
  sourceLang: string
  targetLang: string
  pageCount: number
  exportedAt: number
  templateId: string | null
  pages: ExportPage[]
}

export interface ExportOptions {
  format: ExportFormat
  /** Used by `bilingual-pdf` (and by `html` when `includeOriginal` is on). */
  bilingual: BilingualMode
  /** Bilingual exports: put the source text beside/before the translation. */
  includeOriginal: boolean
  /** File name without extension. */
  fileName: string
  imageFormat: ExportImageFormat
  /** Render scale for raster pages (2 ≈ 144 dpi). */
  imageScale: number
  /**
   * Font substituted for families the browser does not have when the
   * pre-export font check reported `EXPORT_FONT_MISSING`.
   */
  fontFallback: string
  /** Extra CSS font-family list appended to every text run (export only). */
  fontStack: string
  /**
   * Embed the rendered page graphics (figures, rules, watermarks) behind the
   * text. Off → a text-only file that is much smaller; on → the page looks
   * like the original PDF.
   */
  includeImages: boolean
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'html',
  bilingual: 'side-by-side',
  includeOriginal: false,
  fileName: 'document',
  imageFormat: 'png',
  imageScale: 2,
  fontFallback: 'Noto Sans',
  fontStack: '',
  includeImages: true,
}

export type ExportStage = 'collect' | 'render' | 'build' | 'package' | 'write'

export interface ExportProgress {
  stage: ExportStage
  done: number
  total: number
  /** 0..1 across the whole run. */
  ratio: number
}

export type ExportIssueCode =
  | 'EXPORT_FONT_MISSING'
  | 'EXPORT_EMPTY'
  | 'EXPORT_UNSUPPORTED'
  | 'EXPORT_FAILED'
  /**
   * The export ran without a canvas to measure text with, so block reflow was
   * placed from a metric-free estimate. The file is complete; a block may sit
   * a line further down (or up) than it needed to.
   */
  | 'EXPORT_LAYOUT_ESTIMATED'

export interface ExportIssue {
  code: ExportIssueCode
  /** Missing font families (only for `EXPORT_FONT_MISSING`). */
  fonts: string[]
  detail: string
}

/** One built file ready to download. */
export interface ExportArtifact {
  format: ExportFormat
  fileName: string
  mime: string
  blob: Blob
  bytes: number
  /** Non-fatal notes worth showing after the download started. */
  issues: ExportIssue[]
}
