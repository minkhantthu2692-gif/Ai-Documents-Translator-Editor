/**
 * OCR through tesseract.js.
 *
 * Design notes:
 *  - **One worker per session.** Language data is only fetched when a language
 *    is first needed (`mya` included) and then kept, so a document that needs
 *    English never pays for Burmese.
 *  - **Lazy.** `tesseract.js` is dynamically imported on the first `ensure*`
 *    call, so it stays out of the app bundle until the user actually runs OCR.
 *  - **Cached.** Every result lands in Dexie under the `ocr` cache kind, keyed
 *    by caller-supplied identity (page + language set), so re-parsing or
 *    revisiting a scanned page never re-runs recognition.
 *
 * Known limitation: the tesseract core (WASM) and the `.traineddata` language
 * packs are fetched from the jsDelivr CDN on first use, so OCR needs the
 * network once per language — `isOcrAvailable()` reports that up front so
 * pre-flight can say so instead of failing mid-run.
 */

import workerUrl from 'tesseract.js/dist/worker.min.js?url'
import { cacheRepo } from '@/db/repo-cache'

/** App language code → tesseract traineddata code. */
export const TESSERACT_LANG: Record<string, string> = {
  en: 'eng',
  my: 'mya',
  th: 'tha',
  zh: 'chi_sim',
  ja: 'jpn',
  ko: 'kor',
  vi: 'vie',
  fr: 'fra',
  de: 'deu',
  es: 'spa',
  pt: 'por',
  id: 'ind',
  it: 'ita',
  nl: 'nld',
}

export function tesseractCodeFor(appLang: string | null | undefined): string | null {
  if (!appLang) return null
  return TESSERACT_LANG[appLang] ?? null
}

/** True when we have a traineddata code for this language at all. */
export function isOcrLanguageSupported(appLang: string | null | undefined): boolean {
  return tesseractCodeFor(appLang) !== null
}

/**
 * OCR is usable when the language pack can still be fetched — i.e. when
 * there is a network path to the CDN. Pre-flight turns `false` into the
 * `OCR_LANGUAGE_MISSING` reason with its fix action.
 */
export function isOcrAvailable(): boolean {
  if (typeof navigator === 'undefined') return false
  if (navigator.onLine === false) return false
  return true
}

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                    */
/* ------------------------------------------------------------------ */

interface TesseractLoggerMessage {
  status?: string
  progress?: number
}

interface TesseractWorkerLike {
  reinitialize(langs: string | string[], oem?: number, config?: unknown): Promise<unknown>
  recognize(
    image: Blob | OffscreenCanvas | string,
    options?: { rectangle?: { left: number; top: number; width: number; height: number } },
    output?: Record<string, boolean>,
  ): Promise<{ data: { text?: string; confidence?: number } }>
  terminate(): Promise<unknown>
}

let worker: TesseractWorkerLike | null = null
let loadedLangs: string[] = []
/** Serialises create/reinitialize so concurrent requests can't race it. */
let chain: Promise<unknown> = Promise.resolve()

function normalise(langs: Array<string | null | undefined>): string[] {
  const codes = langs
    .map((lang) => tesseractCodeFor(lang))
    .filter((code): code is string => typeof code === 'string')
  return [...new Set(codes)]
}

async function create(wanted: string[], onProgress?: (progress: number) => void) {
  const { createWorker } = await import('tesseract.js')
  // `createWorker` already runs load → loadLanguage → initialize internally
  // (including the first traineddata download) before it resolves.
  const created = (await createWorker(wanted, undefined, {
    // Serve the tesseract worker from our own origin instead of the CDN.
    workerPath: workerUrl,
    logger: (message: TesseractLoggerMessage) => {
      if (typeof message.progress === 'number') onProgress?.(message.progress)
    },
    errorHandler: (error: unknown) => {
      // The awaited promise rejects too; this is for the event inspector.
      console.error('[ocr]', error)
    },
  })) as unknown as TesseractWorkerLike
  worker = created
  loadedLangs = [...wanted]
  return created
}

/**
 * Returns a ready worker holding every requested language, loading the
 * missing traineddata on demand.
 */
export function ensureOcrWorker(
  langs: Array<string | null | undefined>,
  onProgress?: (progress: number) => void,
): Promise<TesseractWorkerLike> {
  const wanted = normalise(langs)
  const task = chain.then(async () => {
    if (!worker) return create(wanted.length > 0 ? wanted : ['eng'], onProgress)
    const missing = wanted.filter((code) => !loadedLangs.includes(code))
    if (missing.length === 0) return worker
    const next = [...new Set([...loadedLangs, ...missing])]
    await worker.reinitialize(next)
    loadedLangs = next
    return worker
  })
  // Never poison the chain: a failed load must be retryable.
  chain = task.catch(() => undefined)
  return task
}

/** Releases the tesseract worker (settings → free memory, tests). */
export async function terminateOcr(): Promise<void> {
  const current = worker
  worker = null
  loadedLangs = []
  if (current) await current.terminate().catch(() => undefined)
}

/* ------------------------------------------------------------------ */
/* Recognition                                                         */
/* ------------------------------------------------------------------ */

export interface OcrOptions {
  /** App language codes (`['my']`); mapped to traineddata codes. */
  langs?: Array<string | null | undefined>
  /** Sub-region of the image (an image region inside a mixed page). */
  rectangle?: { left: number; top: number; width: number; height: number }
  onProgress?: (progress: number) => void
}

export interface OcrResult {
  text: string
  /** Mean confidence 0..100 from tesseract. */
  confidence: number
  langs: string[]
  ms: number
}

/** Runs recognition on an image, loading any missing language first. */
export async function recognizeOcr(
  image: Blob | OffscreenCanvas | string,
  options: OcrOptions = {},
): Promise<OcrResult> {
  const wanted = normalise(options.langs ?? ['en'])
  const started = Date.now()
  const active = await ensureOcrWorker(wanted.length > 0 ? wanted : ['eng'], options.onProgress)
  const result = await active.recognize(
    image,
    options.rectangle ? { rectangle: options.rectangle } : undefined,
    { text: true, blocks: false, hocr: false, tsv: false, pdf: false },
  )
  const text = result.data.text ?? ''
  return {
    text: text.trim(),
    confidence: Math.max(0, Math.min(100, Math.round(result.data.confidence ?? 0))),
    langs: wanted,
    ms: Date.now() - started,
  }
}

/**
 * Recognition with a Dexie cache. `cacheKey` must identify both the image and
 * the language set (e.g. `${projectId}#${pageIndex}#mya`).
 */
export async function recognizeCached(
  cacheKey: string,
  image: Blob | OffscreenCanvas | string,
  options: OcrOptions = {},
): Promise<OcrResult> {
  const cached = await cacheRepo.get<OcrResult>('ocr', cacheKey)
  if (cached) return cached
  const result = await recognizeOcr(image, options)
  if (result.text.length > 0) {
    await cacheRepo.put('ocr', cacheKey, result, { maxBytes: 8 * 1024 * 1024 })
  }
  return result
}
