/**
 * Client for the optional local PDF sidecar (Python, `sidecar/server.py`).
 *
 * The sidecar exists to do *locally and natively* what the browser can only do
 * slowly or not at all — most importantly OCR, where the browser path needs the
 * tesseract WASM core plus a `.traineddata` pack fetched from a CDN, while the
 * sidecar uses the tesseract binary already installed on the machine.
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
