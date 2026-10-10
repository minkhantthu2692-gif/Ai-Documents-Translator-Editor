/**
 * Client for the optional local PDF sidecar (Python, `sidecar/server.py`).
 *
 * The sidecar exists to do *locally and natively* what the browser can only do
 * slowly or not at all — most importantly OCR, where the browser path needs the
 * tesseract WASM core plus a `.traineddata` pack fetched from a CDN, while the
 * sidecar uses the tesseract binary already installed on the machine.
 *
 * `POST /extract` is the other endpoint and it is deliberately **not** a fast
 * path: measured against the 300-page fixture it answers one 12-page parse
 * window in ~1.3 s where pdf.js takes ~20 ms, because every page also runs
 * pdfplumber's table finder and the classify-level signal sweep. So pdf.js
 * keeps the ordinary work and `/extract` is reached only after it has *already
 * failed* a page — a throw, or text it read but could not turn into a single
 * block. That is the only shape in which a slower native reader is a win.
 *
 * Three rules make it safe to reach for unconditionally:
 *
 *  1. **It is optional by construction.** Every entry point returns `null`
 *     rather than throwing when anything is wrong — not running, wrong origin,
 *     CORS, a bad password, an unknown language, tesseract missing. The caller
 *     simply takes its ordinary path, so a user who never starts the sidecar
 *     sees no error, no delay beyond one cached probe, and no behaviour change.
 *  2. **Availability is probed, not assumed.** `probeSidecar` caches its
 *     answer (a negative one for longer, since "not installed" is the common
 *     case) so a window of scans costs at most one probe, not one per page.
 *  3. **Results are indistinguishable from the browser's.** `sidecarOcr`
 *     answers with the same `OcrResult` shape tesseract.js produces, so the
 *     cache and the structure pass cannot tell which engine ran.
 *
 * ### Units
 *
 * The sidecar reports geometry in **page points** (top-left origin, display
 * space). The structure pass consumes **pixel** boxes and divides by the render
 * scale (`ocrItems` in `pdf/ocr/ocrStructure.ts`). So this adapter multiplies
 * by `scale` on the way in and `ocrToBlocks` divides it straight back out —
 * one conversion, stated once, rather than a second code path carrying
 * `scale: 1` through the pipeline.
 */

import type { OcrResult } from '@/ocr/ocrClient'
import type { OcrBBox, OcrLine, OcrPageData } from '@/ocr/ocrTypes'
import type { PageSource } from '@/pdf/pdfExtract'
import type { LineStyle, TextItemLike } from '@/pdf/lineGrouping'

/** Local sidecar default; override with `VITE_PDF_SIDECAR_URL`. */
export const DEFAULT_SIDECAR_URL = 'http://localhost:8790'

/** How long a successful probe is trusted (the sidecar rarely disappears). */
const PROBE_POSITIVE_TTL = 60_000
/** How long a failed probe is trusted — "not installed" is the common case. */
const PROBE_NEGATIVE_TTL = 30_000
/** A dead localhost port answers fast; this only bounds a wedged one. */
const PROBE_TIMEOUT_MS = 1_500

export interface SidecarHealth {
  ok: boolean
  version: string
  python: string
  libs: Record<string, boolean>
  tesseract: { available: boolean; langs: string[] }
}

export interface SidecarOcrOptions {
  /** 0-based page index. */
  pageIndex: number
  /** Tesseract language codes (`['eng']`), not app language codes. */
  langs: string[]
  /**
   * Pixels-per-point the pipeline will divide by. The sidecar answers in page
   * points, so its boxes are multiplied by this to become pixel boxes again.
   */
  scale: number
  /** PDF password, when the document needs one. */
  password?: string
  signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Configured base URL, trailing slashes stripped.
 *
 * An empty (or explicitly blanked) `VITE_PDF_SIDECAR_URL` disables the sidecar
 * entirely — that is the documented opt-out for a deployment that must not
 * reach `localhost`.
 */
export function sidecarUrl(): string {
  const raw = import.meta.env.VITE_PDF_SIDECAR_URL
  const value = typeof raw === 'string' ? raw.trim() : DEFAULT_SIDECAR_URL
  if (!value) return ''
  return value.replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

/**
 * One cached probe serves both entry points. A negative answer is trusted
 * longer than a positive one: "the sidecar is not running" is the common case,
 * and a window of scans must not pay a connection attempt per page.
 */
let healthCache: { at: number; health: SidecarHealth | null } | null = null

/** Forgets the cached probe (a sidecar was started/stopped, tests). */
export function resetSidecarProbe(): void {
  healthCache = null
}

async function fetchHealth(base: string): Promise<SidecarHealth | null> {
  // Bounded probe: a wedged localhost server must not stall a parse window.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/health`, { signal: controller.signal })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (!isRecord(payload) || payload.ok !== true) return null
    const tesseract = isRecord(payload.tesseract) ? payload.tesseract : {}
    const langs = Array.isArray(tesseract.langs)
      ? tesseract.langs.filter((value): value is string => typeof value === 'string')
      : []
    return {
      ok: true,
      version: typeof payload.version === 'string' ? payload.version : '',
      python: typeof payload.python === 'string' ? payload.python : '',
      libs: isRecord(payload.libs)
        ? Object.fromEntries(
            Object.entries(payload.libs).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
            ),
          )
        : {},
      tesseract: {
        available: tesseract.available === true,
        langs,
      },
    }
  } catch {
    // Not running, blocked by CORS/mixed content, or timed out: all the same
    // answer — take the ordinary path.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Raw capability probe, cached for a minute when the sidecar answered and half
 * that when it did not. `null` means unreachable or unparseable.
 */
export async function sidecarHealth(
  options: { force?: boolean } = {},
): Promise<SidecarHealth | null> {
  const base = sidecarUrl()
  if (!base) return null
  if (!options.force && healthCache) {
    const ttl = healthCache.health ? PROBE_POSITIVE_TTL : PROBE_NEGATIVE_TTL
    if (Date.now() - healthCache.at < ttl) return healthCache.health
  }
  const health = await fetchHealth(base)
  healthCache = { at: Date.now(), health }
  return health
}

/**
 * Should this window try the sidecar at all?
 *
 * Returns `false` when it is absent **or** when it is present but could not
 * serve the request anyway — no tesseract binary, or a language pack it does
 * not have. Both would otherwise spend a full PDF upload per page just to read
 * back an error, which is exactly the cost this feature is meant to remove.
 */
export async function probeSidecar(langs: string[] = []): Promise<boolean> {
  if (!sidecarUrl()) return false
  const health = await sidecarHealth()
  if (!health || !health.tesseract.available) return false
  // An empty `langs` list means the server never answered one: trust it and
  // let `validate_langs` be the authority, mirroring the sidecar's own rule.
  if (health.tesseract.langs.length === 0) return true
  return langs.every((lang) => health.tesseract.langs.includes(lang))
}

/* ------------------------------------------------------------------ */
/* OCR                                                                 */
/* ------------------------------------------------------------------ */

/** Sidecar `{x,y,w,h}` in page points → pixel `{x0,y0,x1,y1}`. */
function toBBox(raw: unknown, scale: number): OcrBBox | null {
  if (!isRecord(raw)) return null
  const { x, y, w, h } = raw
  const numbers = [x, y, w, h]
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  if ((w as number) <= 0 || (h as number) <= 0) return null
  return {
    x0: (x as number) * scale,
    y0: (y as number) * scale,
    x1: ((x as number) + (w as number)) * scale,
    y1: ((y as number) + (h as number)) * scale,
  }
}

/**
 * Sidecar payload → the `OcrResult` tesseract.js produces, or `null` when the
 * payload cannot be trusted (the caller then falls back to the browser).
 */
function normaliseOcr(
  payload: unknown,
  scale: number,
  langs: string[],
  ms: number,
): OcrResult | null {
  if (!isRecord(payload) || payload.ok !== true) return null

  const rawLines = Array.isArray(payload.lines) ? payload.lines : []
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const pageConfidence =
    typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)
      ? Math.max(0, Math.min(100, Math.round(payload.confidence)))
      : 100

  const lines: OcrLine[] = []
  for (const entry of rawLines) {
    if (!isRecord(entry)) continue
    const lineText = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!lineText) continue
    const bbox = toBBox(entry.bbox, scale)
    if (!bbox) continue
    // A line that reports no confidence inherits the page's: it must not be
    // silently deleted by the pipeline's confidence floor, nor exempted from it.
    const confidence =
      typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? entry.confidence
        : pageConfidence
    lines.push({ text: lineText, confidence, bbox })
  }

  // Text without lines means the payload does not match the protocol this
  // adapter was written against — accepting it would cache a page that
  // silently loses its content.
  if (text.length > 0 && lines.length === 0) return null

  const blocks: OcrPageData | null =
    lines.length > 0 ? { blocks: [{ paragraphs: [{ lines }] }], confidence: pageConfidence } : null

  return {
    text,
    confidence: pageConfidence,
    blocks,
    langs,
    ms: typeof payload.ms === 'number' && payload.ms >= 0 ? payload.ms : ms,
  }
}

/**
 * OCR one page through the sidecar. Resolves `null` whenever the ordinary
 * browser path should take over instead.
 */
export async function sidecarOcr(pdf: Blob, options: SidecarOcrOptions): Promise<OcrResult | null> {
  const base = sidecarUrl()
  if (!base) return null

  const params = new URLSearchParams({
    page: String(options.pageIndex),
    lang: options.langs.join(','),
  })
  if (options.password) params.set('password', options.password)

  const started = Date.now()
  try {
    const response = await fetch(`${base}/ocr?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdf,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    return normaliseOcr(payload, options.scale, options.langs, Date.now() - started)
  } catch {
    // Transport failure. Do not poison a probe cached by an intentional
    // cancellation — the sidecar is probably still fine.
    if (!options.signal?.aborted) healthCache = null
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Text extraction                                                     */
/* ------------------------------------------------------------------ */

/**
 * How far a line may lean before the page is left to pdf.js.
 *
 * The browser path reads a line's real text matrix, so a title drawn at −45°
 * keeps its tilt and its box. The sidecar reports an axis-aligned rectangle,
 * and a rectangle is not enough to rebuild a rotation: feeding a square box
 * back through the corner walk as if it were upright would move the line and
 * hand `canMerge` a rotation it never had. One tilted line on a page is
 * enough to send that whole page back to pdf.js.
 */
const MAX_LINE_TILT_DEGREES = 1

/** Extraction methods whose pages carry a text layer. */
const TEXT_METHODS = new Set(['text', 'hybrid'])

/**
 * One sidecar page, ready to hand to `assemblePage`.
 *
 * `decline` is `null` when the page may be used, and otherwise names the
 * reason it may not. Declining is never an error — the caller simply runs the
 * browser path for that page — which is why every reason is a stable string
 * rather than an exception: they are the vocabulary the fallback tests pin.
 */
export interface SidecarExtractPage {
  /** Page index exactly as the sidecar echoed it. */
  index: number
  /** `null` when usable; otherwise why the page was declined. */
  decline: string | null
  /**
   * Positioned runs plus page dimensions, with `annotations` left for the
   * caller (only pdf.js can read `/Link` rectangles, and it still has the
   * page open).
   */
  source: PageSource
}

export interface SidecarExtractOptions {
  /** 0-based pages to read; compressed into ranges for the query string. */
  pageIndexes: readonly number[]
  /** PDF password, when the document needs one. */
  password?: string
  signal?: AbortSignal
}

/**
 * `0,1,2,7,9` → `0-2,7,9`.
 *
 * A parse window is 12 consecutive pages, so the naive form is already short,
 * but a caller may pass anything: compressing keeps the URL bounded however
 * sparse the list is, and it sorts, which makes the request deterministic and
 * therefore cacheable in a test.
 */
export function pageRanges(indexes: readonly number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b)
  const parts: string[] = []
  let start = 0
  for (let at = 1; at <= sorted.length; at += 1) {
    if (at < sorted.length && sorted[at] === sorted[at - 1] + 1) continue
    const first = sorted[start]
    const last = sorted[at - 1]
    parts.push(first === last ? String(first) : `${first}-${last}`)
    start = at
  }
  return parts.join(',')
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * One sidecar line → one pdf.js-shaped text run, or the reason it cannot be.
 *
 * The transform is written in pdf.js's convention so that
 * `groupItemsIntoLines` needs no knowledge of where the run came from:
 * `e`/`f` put the origin on the left edge of the line's **top** (pdf.js puts
 * it on the baseline, and `groupItemsIntoLines` converts back with
 * `pageHeight - maxY`), `d = -fontSize` so `hypot(c, d)` reads the size back
 * out, and `a = 1, b = 0` so the rotation comes out as the sidecar's own
 * axis-aligned 0.
 *
 * `height` is the font size rather than the box PyMuPDF measured, because
 * the two engines disagree about what a line's rectangle *is*. pdf.js spans
 * exactly one em above the baseline; PyMuPDF spans ascender to descender,
 * which for the fixtures is 1.31 em — so a block would come back ~3 pt taller
 * per edge than pdf.js made it, and every gap the block builder measures
 * would be 3 pt short. Taking the top PyMuPDF reports and one em of height
 * puts both engines' rectangles on the same convention, which is what makes
 * `canMerge`'s gap threshold mean the same thing on either path.
 */
function pushLine(
  entry: Record<string, unknown>,
  pageHeight: number,
  items: TextItemLike[],
  styles: Array<Partial<LineStyle>>,
): string | null {
  const text = entry.text
  if (typeof text !== 'string') return 'line-text'

  const box = entry.bbox
  if (!isRecord(box)) return 'line-geometry'
  const x = finite(box.x)
  const y = finite(box.y)
  const w = finite(box.w)
  const h = finite(box.h)
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
    return 'line-geometry'
  }

  const size = finite(entry.fontSize)
  if (size === null || size <= 0) return 'line-font-size'
  const tilt = finite(entry.rotation) ?? 0
  if (Math.abs(tilt) > MAX_LINE_TILT_DEGREES) return 'line-rotation'

  // A line PyMuPDF kept only for its spacing carries nothing; dropping it
  // costs no text and keeps `items` free of runs the grouper rejects anyway.
  if (!text.trim()) return null

  items.push({
    str: text,
    transform: [1, 0, 0, -size, x, pageHeight - y],
    width: w,
    height: size,
    fontName: typeof entry.fontFamily === 'string' ? entry.fontFamily : undefined,
  })
  styles.push({
    fontFamily:
      typeof entry.fontFamily === 'string' && entry.fontFamily ? entry.fontFamily : 'Helvetica',
    bold: entry.bold === true,
    italic: entry.italic === true,
    color:
      typeof entry.color === 'string' && /^#[0-9a-f]{6}$/i.test(entry.color)
        ? entry.color.toLowerCase()
        : '#000000',
  })
  return null
}

function emptySource(width: number, height: number, rotation: number): PageSource {
  return { items: [], width, height, rotation }
}

/** One `/extract` page entry → a normalised page, or `null` if it is not one. */
function normalisePage(raw: Record<string, unknown>): SidecarExtractPage | null {
  const index = finite(raw.index)
  if (index === null) return null

  const width = finite(raw.width) ?? 0
  const height = finite(raw.height) ?? 0
  const rotation = finite(raw.rotation) ?? 0
  const source = emptySource(width, height, rotation)
  const decline = (reason: string): SidecarExtractPage => ({ index, decline: reason, source })

  // Display space (rotation applied) on the sidecar, user space on the
  // browser: for an upright page the two are the same rectangle, and for any
  // other they are not, so a rotated page is not comparable and is refused.
  if (rotation % 360 !== 0) return decline('page-rotation')
  // `none` is an empty page, `ocr` a scanned one the app's own OCR pipeline
  // owns — neither has text for this path to recover.
  if (typeof raw.extractionMethod !== 'string' || !TEXT_METHODS.has(raw.extractionMethod)) {
    return decline('extraction-method')
  }
  if (width <= 0 || height <= 0) return decline('page-size')
  if (!Array.isArray(raw.blocks)) return decline('page-blocks')

  const items: TextItemLike[] = []
  const styles: Array<Partial<LineStyle>> = []
  for (const block of raw.blocks) {
    if (!isRecord(block)) return decline('page-blocks')
    // pdfplumber's reading of a ruled table replaces the text blocks that
    // were inside it, so the page is no longer a drop-in for what pdf.js
    // would have read: the cells have no rectangles attached and the
    // surrounding prose has already been removed. pdf.js reads those pages
    // correctly, and better, so they stay with it.
    if (block.table !== null && block.table !== undefined) return decline('pdfplumber-table')
    if (!Array.isArray(block.lines)) return decline('page-blocks')
    for (const entry of block.lines) {
      if (!isRecord(entry)) return decline('line-geometry')
      const reason = pushLine(entry, height, items, styles)
      if (reason !== null) return decline(reason)
    }
  }

  if (items.length === 0) return decline('no-lines')
  source.items = items
  source.styles = styles
  return { index, decline: null, source }
}

/**
 * `/extract` payload → normalised pages, or `null` when the payload is not
 * the answer this adapter was written against (the caller then keeps the
 * browser's result, which it already has).
 */
export function normaliseExtract(payload: unknown): SidecarExtractPage[] | null {
  if (!isRecord(payload) || payload.ok !== true) return null
  if (!Array.isArray(payload.pages)) return null
  const pages: SidecarExtractPage[] = []
  for (const entry of payload.pages) {
    if (!isRecord(entry)) return null
    const page = normalisePage(entry)
    if (page === null) return null
    pages.push(page)
  }
  return pages
}

/**
 * Should this window be able to fall back to `POST /extract`?
 *
 * The gate is pymupdf, not tesseract — `probeSidecar` answers the OCR
 * question and would wrongly refuse a sidecar that can extract text but has
 * no OCR binary. Reuses the same cached health probe, so a window that has
 * already asked for OCR pays nothing extra.
 */
export async function probeSidecarExtract(): Promise<boolean> {
  if (!sidecarUrl()) return false
  const health = await sidecarHealth()
  return health !== null && health.libs.fitz === true
}

/**
 * Read pages through the sidecar — the *fallback* reader, never the first.
 *
 * Resolves `null` whenever the browser's own answer should stand: no sidecar
 * configured, nothing to ask for, unreachable, an error status, or a payload
 * that does not match the protocol. Individual pages inside a successful
 * answer carry their own `decline` reason.
 */
export async function sidecarExtract(
  pdf: Blob,
  options: SidecarExtractOptions,
): Promise<SidecarExtractPage[] | null> {
  const base = sidecarUrl()
  if (!base || options.pageIndexes.length === 0) return null

  const params = new URLSearchParams({
    // The app's OCR pipeline owns scanned pages (confidence floor, cache,
    // persistence), so it must not race the sidecar's own OCR.
    mode: 'text',
    pages: pageRanges(options.pageIndexes),
  })
  if (options.password) params.set('password', options.password)

  try {
    const response = await fetch(`${base}/extract?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdf,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    return normaliseExtract(payload)
  } catch {
    // Same rule as OCR: an intentional cancellation says nothing about the
    // sidecar's health, so only a real transport failure drops the probe.
    if (!options.signal?.aborted) healthCache = null
    return null
  }
}
