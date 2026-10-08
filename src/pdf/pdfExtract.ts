/**
 * pdf.js-facing extraction.
 *
 * Everything the analysis worker needs from a document, expressed as plain
 * async functions over `PDFDocumentProxy` / `PDFPageProxy`:
 *
 *   readDocumentInfo  — metadata (title, producer, dates, encryption, tagged…)
 *   probeDocument     — every page: text coverage, images, annotations,
 *                       language, content class, plus running-head/foot sets
 *   extractPage       — lines → ordered blocks for a single page
 *
 * The module has no pdf.js *runtime* dependency (types only), which keeps the
 * operator-list maths unit-testable and lets the integration test drive the
 * whole pipeline from Node against the generated fixtures.
 */

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { PageContentClass } from '@/db/types'
import { detectLanguage } from '@/core/langDetect'
import { ensureUnicode, zawgyiProbability } from '@/core/zawgyi'
import { classifyPage, coverageOf, emptyTally, type ContentTally } from './pageClassify'
import { analyzeLayout, itemBoxesOf, type LayoutComplexity } from './layoutComplexity'
import {
  groupItemsIntoLines,
  type GroupedLine,
  type LineStyle,
  type TextItemLike,
} from './lineGrouping'
import {
  detectRepeatingMargins,
  MARGIN_BAND,
  normalizeMarginText,
  structurePage,
  type PageBlock,
  type StructureOptions,
} from './structure'
import { lineId } from './stableId'
import type { SkipContext } from './skipRules'
import {
  addFont,
  assignColors,
  classifyFontName,
  countImages,
  emptyFontStats,
  type FontStats,
  type OpList,
} from './pdfOps'
import { ensurePdfRuntimeSupport } from './pdfRuntime'

// pdf.js needs `Uint8Array.prototype.toHex` for document fingerprints; install
// the shim before anything opens a document.
ensurePdfRuntimeSupport()

/* ------------------------------------------------------------------ */
/* Document metadata                                                   */
/* ------------------------------------------------------------------ */

export interface PdfDocumentInfo {
  pageCount: number
  pdfVersion: string | null
  title: string | null
  author: string | null
  subject: string | null
  keywords: string | null
  creator: string | null
  producer: string | null
  language: string | null
  creationDate: string | null
  modificationDate: string | null
  encrypted: boolean
  tagged: boolean | null
  linearized: boolean | null
  hasAcroForm: boolean | null
  formFieldCount: number
  permissionsRestricted: boolean
  /** Filled in by `probeDocument` once every page has been inspected. */
  fonts: FontStats
}

/**
 * Parses a PDF date string (`D:YYYYMMDDHHmmSSOHH'mm'`) into an ISO string.
 * Unknown parts default to the start of the period; a missing timezone is
 * treated as local time by `Date`.
 */
export function parsePdfDate(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null
  const match =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?'?/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second, zone, zoneHour, zoneMinute] = match
  const base = Date.UTC(
    Number(year),
    Number(month ?? '01') - 1,
    Number(day ?? '01'),
    Number(hour ?? '00'),
    Number(minute ?? '00'),
    Number(second ?? '00'),
  )
  let offsetMs = 0
  if (zone === '+' || zone === '-') {
    offsetMs =
      (Number(zoneHour ?? '00') * 60 + Number(zoneMinute ?? '00')) *
      60_000 *
      (zone === '+' ? -1 : 1)
  }
  const date = new Date(base + offsetMs)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Shape of the font objects pdf.js exposes through `page.commonObjs`. */
interface FontFaceLike {
  loadedName?: string
  bold?: boolean
  italic?: boolean
  isType3Font?: boolean
  missingFile?: boolean
}

interface ObjectStoreLike {
  has(id: string): boolean
  get(id: string): unknown
}

interface PageInternals {
  commonObjs?: ObjectStoreLike
  getAnnotations?: () => Promise<unknown[]>
  cleanup?: () => void
}

export async function readDocumentInfo(doc: PDFDocumentProxy): Promise<PdfDocumentInfo> {
  const meta = (await doc.getMetadata()) as {
    info: Record<string, unknown>
    metadata: { get(path: string): unknown } | null
  }
  const info = meta.info ?? {}
  const text = (key: string): string | null => {
    const value = info[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  const bool = (key: string): boolean | null => (typeof info[key] === 'boolean' ? info[key] : null)

  const markInfo = await doc.getMarkInfo().catch(() => null)
  const permissions = await doc.getPermissions().catch(() => null)

  let formFieldCount = 0
  const getFieldObjects = (
    doc as unknown as { getFieldObjects?: () => Promise<Record<string, unknown[]> | null> }
  ).getFieldObjects
  if (typeof getFieldObjects === 'function') {
    const fields = await getFieldObjects.call(doc).catch(() => null)
    if (fields && typeof fields === 'object') {
      for (const value of Object.values(fields)) {
        formFieldCount += Array.isArray(value) ? value.length : 1
      }
    }
  }

  let language = text('Language')
  const rawMetadata = meta.metadata
  if (!language && rawMetadata && typeof rawMetadata.get === 'function') {
    const fromXmp = rawMetadata.get('dc:language')
    language = typeof fromXmp === 'string' ? fromXmp : null
  }

  return {
    pageCount: doc.numPages,
    pdfVersion: text('PDFFormatVersion'),
    title: text('Title'),
    author: text('Author'),
    subject: text('Subject'),
    keywords: text('Keywords'),
    creator: text('Creator'),
    producer: text('Producer'),
    language,
    creationDate: parsePdfDate(text('CreationDate')),
    modificationDate: parsePdfDate(text('ModDate')),
    encrypted: Boolean(text('EncryptFilterName')),
    tagged: markInfo ? Boolean(markInfo.Marked) : null,
    linearized: bool('IsLinearized'),
    hasAcroForm: bool('IsAcroFormPresent'),
    formFieldCount,
    permissionsRestricted: permissions != null,
    fonts: emptyFontStats(),
  }
}

/* ------------------------------------------------------------------ */
/* Page reading                                                        */
/* ------------------------------------------------------------------ */

interface AnnotationLike {
  subtype?: string
  fieldType?: string
}

interface PreparedPage {
  items: TextItemLike[]
  colors: Array<string | null>
  styles: Array<Partial<LineStyle> | null>
  ops: OpList
  annotations: AnnotationLike[]
  width: number
  height: number
  rotation: number
  /** Internal font id → how the font is embedded (deduped per page). */
  fontClassifications: Map<string, ReturnType<typeof classifyFontName>>
}

/**
 * Reads one page: text items, operator list (colours, images, fonts) and
 * annotations, then aligns per-item colours/styles with the text items.
 */
async function readPage(
  page: PDFPageProxy,
  options: { annotations: boolean },
): Promise<PreparedPage> {
  const internals = page as unknown as PageInternals
  const textContent = await page.getTextContent()
  const rawItems = textContent.items as Array<Partial<TextItemLike>>
  const ops = (await page.getOperatorList()) as unknown as OpList

  const allColors = assignColors(ops, rawItems)
  const store = internals.commonObjs
  const fontClassifications = new Map<string, ReturnType<typeof classifyFontName>>()

  const items: TextItemLike[] = []
  const colors: Array<string | null> = []
  const styles: Array<Partial<LineStyle> | null> = []

  rawItems.forEach((item, index) => {
    if (typeof item.str !== 'string') return
    const prepared = { ...(item as TextItemLike) }
    let style: Partial<LineStyle> | null = null

    const fontId = item.fontName
    if (fontId && store && store.has(fontId)) {
      const font = store.get(fontId) as FontFaceLike | null
      if (font && typeof font === 'object') {
        const name = font.loadedName ?? fontId
        prepared.fontName = name
        style = {
          fontFamily: name,
          bold: font.bold === true,
          italic: font.italic === true,
        }
        if (!fontClassifications.has(fontId)) {
          fontClassifications.set(
            fontId,
            classifyFontName(name, {
              isType3: font.isType3Font === true,
              missingFile: font.missingFile === true,
            }),
          )
        }
      }
    }

    items.push(prepared)
    colors.push(allColors[index] ?? null)
    styles.push(style)
  })

  let annotations: AnnotationLike[] = []
  if (options.annotations) {
    annotations = (await page.getAnnotations().catch(() => [])) as AnnotationLike[]
  }

  const view = page.view
  const width = Math.abs(view[2] - view[0])
  const height = Math.abs(view[3] - view[1])

  return {
    items,
    colors,
    styles,
    ops,
    annotations,
    width,
    height,
    rotation: page.rotate ?? 0,
    fontClassifications,
  }
}

/* ------------------------------------------------------------------ */
/* Probing                                                             */
/* ------------------------------------------------------------------ */

export interface PageProbe {
  index: number
  width: number
  height: number
  rotation: number
  charCount: number
  /** 0..1 share of the page covered by text rectangles. */
  textCoverage: number
  imageCount: number
  annotationCount: number
  formFieldCount: number
  lineCount: number
  contentClass: PageContentClass
  /** Layout-complexity verdict driving the `complex` class. */
  layout: LayoutComplexity
  detectedLanguage: string | null
  detectedConfidence: number
}

export interface ProbeSummary {
  /** Best-effort language of the whole document. */
  documentLanguage: string | null
  documentConfidence: number
  /** 0..1 probability that the sample is Zawgyi-encoded Myanmar. */
  zawgyiProbability: number
  /** True when extracted Myanmar text must be converted to Unicode. */
  convertZawgyi: boolean
  tally: ContentTally
  /** Pages with a usable text layer (`text` + `mixed`). */
  textLayerPages: number
  /** Pages that need OCR before translation. */
  ocrNeededPages: number
  totalChars: number
  totalImages: number
  annotations: number
  formFields: number
  /** Normalised running heads / feet seen on ≥2 pages. */
  headerTexts: string[]
  footerTexts: string[]
}

export interface ProbeResult {
  info: PdfDocumentInfo
  probes: PageProbe[]
  summary: ProbeSummary
}

export interface ProbeOptions {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  /** Cap on the characters sampled for document-level language detection. */
  sampleChars?: number
  /** Free per-page caches as we go (big documents). */
  cleanupPages?: boolean
}

interface AbortError extends Error {
  name: 'AbortError'
}

function abortError(): AbortError {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('analysis aborted', 'AbortError') as AbortError
  }
  const error = new Error('analysis aborted') as AbortError
  error.name = 'AbortError'
  return error
}

const LANG_SAMPLE_PER_PAGE = 400

/** Inspects every page of the document. */
export async function probeDocument(
  doc: PDFDocumentProxy,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const info = await readDocumentInfo(doc)
  const total = doc.numPages
  const probes: PageProbe[] = []
  const pageLines: GroupedLine[][] = []
  const cleanupPages = options.cleanupPages ?? total > 60
  const sampleBudget = options.sampleChars ?? 40_000

  let sample = ''
  let totalChars = 0
  let totalImages = 0
  let annotations = 0
  let formFields = 0
  let fontStats = emptyFontStats()
  const seenFontIds = new Set<string>()

  for (let index = 0; index < total; index += 1) {
    if (options.signal?.aborted) throw abortError()
    const page = await doc.getPage(index + 1)
    const prepared = await readPage(page, { annotations: true })

    const charCount = prepared.items.reduce(
      (sum, item) => sum + item.str.replace(/\s+/g, '').length,
      0,
    )
    const textCoverage = coverageOf(prepared.items, prepared.width * prepared.height)
    const imageCount = countImages(prepared.ops)
    const lines = groupItemsIntoLines(prepared.items, {
      pageIndex: index,
      pageHeight: prepared.height,
      colors: prepared.colors,
      styles: prepared.styles,
    })

    const pageText = prepared.items.map((item) => item.str).join(' ')
    const detection = pageText.trim().length >= 20 ? detectLanguage(pageText) : null
    const layout = analyzeLayout(lines, {
      pageWidth: prepared.width,
      pageRotation: prepared.rotation,
      imageCount,
      itemBoxes: itemBoxesOf(prepared.items),
    })
    const contentClass = classifyPage({ charCount, textCoverage, imageCount, layout })

    const formFieldCount = prepared.annotations.filter(
      (annotation) => typeof annotation.fieldType === 'string' && annotation.fieldType.length > 0,
    ).length

    probes.push({
      index,
      width: prepared.width,
      height: prepared.height,
      rotation: prepared.rotation,
      charCount,
      textCoverage: Math.round(textCoverage * 10_000) / 10_000,
      imageCount,
      annotationCount: prepared.annotations.length,
      formFieldCount,
      lineCount: lines.length,
      contentClass,
      layout,
      detectedLanguage: detection?.lang ?? null,
      detectedConfidence: Math.round((detection?.confidence ?? 0) * 100) / 100,
    })

    pageLines.push(lines)
    totalChars += charCount
    totalImages += imageCount
    annotations += prepared.annotations.length
    formFields += formFieldCount
    for (const [fontId, classification] of prepared.fontClassifications) {
      fontStats = addFont(fontStats, seenFontIds, fontId, classification)
    }

    if (sample.length < sampleBudget) {
      sample += ` ${pageText.slice(0, LANG_SAMPLE_PER_PAGE)}`
    }

    if (cleanupPages && typeof (page as unknown as PageInternals).cleanup === 'function') {
      ;(page as unknown as PageInternals).cleanup?.()
    }
    options.onProgress?.(index + 1, total)
  }

  const margins = detectRepeatingMargins(
    pageLines.map((lines, index) => ({ lines, pageHeight: probes[index].height })),
  )

  const documentDetection = detectLanguage(sample)
  const zawgyi = sample ? zawgyiProbability(sample) : 0
  const tally = emptyTally()
  for (const probe of probes) tally[probe.contentClass] += 1

  info.fonts = fontStats

  return {
    info,
    probes,
    summary: {
      documentLanguage: documentDetection.lang,
      documentConfidence: Math.round(documentDetection.confidence * 100) / 100,
      zawgyiProbability: Math.round(zawgyi * 100) / 100,
      convertZawgyi: zawgyi >= 0.5,
      tally,
      textLayerPages: tally.text + tally.mixed + tally.complex,
      ocrNeededPages: tally.scanned,
      totalChars,
      totalImages,
      annotations,
      formFields,
      headerTexts: [...margins.headers],
      footerTexts: [...margins.footers],
    },
  }
}

/* ------------------------------------------------------------------ */
/* Header / footer bands for a single page (no document context)       */
/* ------------------------------------------------------------------ */

/** Lines that sit in the top/bottom band of one page, for margin analysis. */
export function marginTextsForPage(
  lines: GroupedLine[],
  pageHeight: number,
): { headers: Set<string>; footers: Set<string> } {
  const headers = new Set<string>()
  const footers = new Set<string>()
  for (const line of lines) {
    const normalized = normalizeMarginText(line.text)
    if (normalized.length < 3) continue
    if (line.bbox.y + line.bbox.h <= pageHeight * MARGIN_BAND) headers.add(normalized)
    else if (line.bbox.y >= pageHeight * (1 - MARGIN_BAND)) footers.add(normalized)
  }
  return { headers, footers }
}

/* ------------------------------------------------------------------ */
/* Block extraction                                                    */
/* ------------------------------------------------------------------ */

export interface ExtractPageOptions {
  pageIndex: number
  ctx?: SkipContext
  headerTexts?: Iterable<string>
  footerTexts?: Iterable<string>
  /** Convert Zawgyi-encoded Myanmar lines to Unicode first. */
  convertZawgyi?: boolean
}

export interface ExtractedPage {
  pageIndex: number
  width: number
  height: number
  rotation: number
  charCount: number
  lineCount: number
  blocks: PageBlock[]
}

/** Extracts ordered blocks for a single page. */
export async function extractPage(
  page: PDFPageProxy,
  options: ExtractPageOptions,
): Promise<ExtractedPage> {
  const prepared = await readPage(page, { annotations: false })
  const structureOptions: StructureOptions = {
    pageIndex: options.pageIndex,
    pageWidth: prepared.width,
    pageHeight: prepared.height,
    ctx: options.ctx,
    headerTexts: new Set(options.headerTexts ?? []),
    footerTexts: new Set(options.footerTexts ?? []),
  }

  let lines = groupItemsIntoLines(prepared.items, {
    pageIndex: options.pageIndex,
    pageHeight: prepared.height,
    colors: prepared.colors,
    styles: prepared.styles,
  })

  if (options.convertZawgyi) {
    lines = lines.map((line) => {
      const repaired = ensureUnicode(line.text)
      if (!repaired.converted) return line
      return {
        ...line,
        text: repaired.text,
        id: lineId(options.pageIndex, line.bbox, repaired.text),
      }
    })
  }

  const blocks = structurePage(lines, structureOptions)
  return {
    pageIndex: options.pageIndex,
    width: prepared.width,
    height: prepared.height,
    rotation: prepared.rotation,
    charCount: prepared.items.reduce((sum, item) => sum + item.str.replace(/\s+/g, '').length, 0),
    lineCount: lines.length,
    blocks,
  }
}
