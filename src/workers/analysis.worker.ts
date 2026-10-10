/**
 * Analysis worker — the only place pdf.js runs.
 *
 * The main thread never parses: it ships file bytes here, gets metadata,
 * probes, page blocks and rasterised pages back as plain data and Blobs, and
 * persists them into Dexie itself. Everything is request/response keyed by a
 * request `id`, so the client can correlate, time out and cancel.
 *
 * pdf.js runs *in this thread* (no third thread): we publish its
 * `WorkerMessageHandler` on `globalThis.pdfjsWorker`, which is the first thing
 * pdf.js checks before trying to spawn a worker of its own — inside a worker
 * that path would throw on `window` anyway and fall back to the same place.
 *
 * Renders are serialised and superseded: scrolling a 300-page thumbnail strip
 * cancels whatever is stale instead of queueing it.
 */

/// <reference lib="webworker" />

import {
  getDocument,
  InvalidPDFException,
  PasswordException,
  PasswordResponses,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist'
import * as pdfjsWorkerHandler from 'pdfjs-dist/build/pdf.worker.mjs'
import type { ReasonCode } from '@/core/reasonCodes'
import { PDF_DOCUMENT_PARAMS } from '@/pdf/pdfAssets'
import {
  assemblePage,
  continuationHintFor,
  extractPage,
  needsSidecarFallback,
  probeDocument,
  resolveDestination,
  resolveInternalLinks,
  type AnnotationLike,
  type ExtractedPage,
  type ExtractPageOptions,
} from '@/pdf/pdfExtract'
import type { TableContinuation } from '@/pdf/rowSplit'
import {
  isRenderCancelled,
  renderPage,
  type FigureCropTarget,
  type RenderHandle,
} from '@/pdf/pageRender'
import { traceImagePlacements, type ImagePlacement } from '@/pdf/imageOps'
import type { OpList } from '@/pdf/pdfOps'
import { repairPdf } from '@/pdf/repair'
import { probeSidecarExtract, sidecarExtract } from '@/sidecar/sidecarClient'
import type {
  AnalysisEvent,
  AnalysisRequest,
  ExtractRequest,
  OpenRequest,
  RenderRequest,
} from './protocol'

// Publish the message handler so pdf.js stays on this thread (fake worker).
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorkerHandler

const scope = self as unknown as DedicatedWorkerGlobalScope

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface OpenDoc {
  task: PDFDocumentLoadingTask
  doc: PDFDocumentProxy
  pageCount: number
  /**
   * The file's bytes, retained **only** while the sidecar could serve them.
   *
   * `open` transfers the buffer in and hands pdf.js a private copy of it, so
   * keeping the original costs one extra file-sized allocation and buys the
   * ability to POST the document somewhere without reading it again. The
   * probe runs while the document opens, so a sidecar that is not running —
   * the common case — leaves nothing behind, and closing frees it.
   */
  bytes: ArrayBuffer | null
  /** Kept beside the bytes: `/extract` takes it as a query parameter. */
  password: string | null
}

const docs = new Map<string, OpenDoc>()
/** In-flight cancellable requests (probe/extract/open). */
const aborts = new Map<string, AbortController>()

interface RenderEntry {
  id: string
  fileId: string
  pageIndex: number
  mode: 'thumbnail' | 'background'
  scale: number
  cancelled: boolean
  handle: RenderHandle | null
  /** Figure cut-outs requested with this render; empty for an ordinary one. */
  crops: FigureCropTarget[]
}

const renderQueue: RenderEntry[] = []
const renderByKey = new Map<string, RenderEntry>()
let rendering = false

/**
 * Supersede only an identical render — scale, mode and "is this a figure
 * render" together identify the consumer, so a thumbnail and a figure crop of
 * the same page never cancel each other.
 */
const renderKey = (
  fileId: string,
  pageIndex: number,
  scale: number,
  mode: string,
  crops: readonly FigureCropTarget[] = [],
): string => `${fileId}#${pageIndex}#${scale}#${mode}#${crops.length > 0 ? 'figures' : 'page'}`

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function post(event: AnalysisEvent): void {
  scope.postMessage(event)
}

function errorName(error: unknown): string | null {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name: unknown }).name)
  }
  return null
}

function isAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError'
}

/** Worker-side failures surface as the reason code the Status Panel explains. */
function reasonOf(error: unknown): ReasonCode {
  if (error instanceof InvalidPDFException) return 'PDF_CORRUPTED'
  const name = errorName(error)
  if (name === 'MissingPDFException' || name === 'UnexpectedResponseException') {
    return 'PDF_CORRUPTED'
  }
  return 'PDF_CORRUPTED'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Frees per-page caches on big documents so memory stays flat. */
function releasePage(
  page: { cleanup: (resetStats?: boolean) => boolean },
  pageCount: number,
): void {
  if (pageCount > 60) {
    try {
      page.cleanup()
    } catch {
      // Cleanup is best-effort.
    }
  }
}

function requireDoc(fileId: string): OpenDoc | undefined {
  return docs.get(fileId)
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

async function handleOpen(request: OpenRequest): Promise<void> {
  const controller = new AbortController()
  aborts.set(request.id, controller)
  try {
    // Replace any previous handle for this file (password retry, re-open).
    const previous = docs.get(request.fileId)
    if (previous) {
      docs.delete(request.fileId)
      await previous.task.destroy().catch(() => undefined)
    }

    // Started before the document so it overlaps: deciding whether to keep
    // the bytes must not cost a round trip on top of opening.
    const sidecarReady = probeSidecarExtract()
    const params = {
      ...(request.password ? { password: request.password } : {}),
      ...PDF_DOCUMENT_PARAMS,
    }
    // Take a private copy: the transferred buffer must stay readable for the
    // document's whole lifetime (pdf.js reads it lazily).
    let task = getDocument({ data: new Uint8Array(request.bytes).slice(), ...params })
    let opened: [PDFDocumentProxy, boolean]
    let workingBytes = request.bytes
    let repaired: string[] | undefined
    try {
      opened = await Promise.all([task.promise, sidecarReady])
    } catch (failure) {
      // Passwords and aborts are not damage — they must reach the caller
      // unchanged.
      if (failure instanceof PasswordException || isAbortError(failure)) throw failure
      // pdf.js self-heals most structural damage (it re-indexes the whole
      // file), but a destroyed xref table, a dead /Root or a lost trailer
      // stop it: append a rebuilt index and try once more.
      const attempt = repairPdf(new Uint8Array(request.bytes))
      if (!attempt) throw failure
      await task.destroy().catch(() => undefined)
      repaired = attempt.fixes
      workingBytes = attempt.bytes.buffer as ArrayBuffer
      task = getDocument({ data: new Uint8Array(attempt.bytes).slice(), ...params })
      opened = await Promise.all([task.promise, sidecarReady])
    }
    const [doc, canFallBack] = opened
    if (controller.signal.aborted) {
      await task.destroy().catch(() => undefined)
      post({ kind: 'cancelled', id: request.id, fileId: request.fileId })
      return
    }
    docs.set(request.fileId, {
      task,
      doc,
      pageCount: doc.numPages,
      bytes: canFallBack ? workingBytes : null,
      password: request.password ?? null,
    })
    post({
      kind: 'opened',
      id: request.id,
      fileId: request.fileId,
      pageCount: doc.numPages,
      ...(repaired ? { repaired } : {}),
    })
  } catch (error) {
    if (error instanceof PasswordException) {
      const reason = error.code === PasswordResponses.NEED_PASSWORD ? 'missing' : 'incorrect'
      post({
        kind: 'passwordRequired',
        id: request.id,
        fileId: request.fileId,
        reason,
      })
      return
    }
    post({
      kind: 'error',
      id: request.id,
      fileId: request.fileId,
      reasonCode: reasonOf(error),
      message: errorMessage(error),
    })
  } finally {
    aborts.delete(request.id)
  }
}

async function handleProbe(request: { id: string; fileId: string }): Promise<void> {
  const open = requireDoc(request.fileId)
  if (!open) {
    post({
      kind: 'error',
      id: request.id,
      fileId: request.fileId,
      reasonCode: 'PDF_CORRUPTED',
      message: 'document is not open',
    })
    return
  }
  const controller = new AbortController()
  aborts.set(request.id, controller)
  try {
    const result = await probeDocument(open.doc, {
      signal: controller.signal,
      cleanupPages: open.pageCount > 60,
      onProgress: (done, total) => {
        post({
          kind: 'progress',
          id: request.id,
          fileId: request.fileId,
          stage: 'probe',
          done,
          total,
        })
      },
    })
    post({ kind: 'probeResult', id: request.id, fileId: request.fileId, result })
  } catch (error) {
    if (isAbortError(error)) {
      post({ kind: 'cancelled', id: request.id, fileId: request.fileId })
      return
    }
    post({
      kind: 'error',
      id: request.id,
      fileId: request.fileId,
      reasonCode: reasonOf(error),
      message: errorMessage(error),
    })
  } finally {
    aborts.delete(request.id)
  }
}

/**
 * A page pdf.js could not deliver, with everything a second attempt needs.
 *
 * `error` is the failure it raised; `null` means it returned normally but
 * produced nothing from text it had read, in which case `fallback` is that
 * empty result and is what stands if the second attempt declines too.
 */
interface FailedPage {
  position: number
  pageIndex: number
  error: unknown
  fallback: ExtractedPage | null
}

/**
 * Second attempt at the pages pdf.js could not read, through the sidecar.
 *
 * Never throws for the sidecar's own sake: any way the sidecar can fail — no
 * bytes kept, unreachable, an error status, a page it declines — leaves the
 * browser's answer in place and the original failure to surface it. Only a
 * genuine pdf.js failure with nothing to stand behind it is rethrown, so the
 * Status Panel still reports `PDF_CORRUPTED` for a document neither engine
 * can read.
 */
async function recoverWithSidecar(
  open: OpenDoc,
  retries: FailedPage[],
  pages: Array<ExtractedPage | null>,
  pageOptions: (pageIndex: number, continuation: TableContinuation | null) => ExtractPageOptions,
  signal: AbortSignal,
): Promise<void> {
  if (retries.length === 0 || !open.bytes) return
  if (!(await probeSidecarExtract())) return

  const recovered = await sidecarExtract(new Blob([open.bytes]), {
    pageIndexes: retries.map((retry) => retry.pageIndex),
    ...(open.password ? { password: open.password } : {}),
    signal,
  })
  const byIndex = new Map((recovered ?? []).map((page) => [page.index, page]))

  for (const retry of retries) {
    const entry = byIndex.get(retry.pageIndex)
    if (entry?.decline === null) {
      // Only pdf.js can read the annotations, and it still has the page
      // open — so links come from there while the text comes from here.
      // When the page object itself is what failed, there are no `/Link`
      // rectangles left to attach; the text still stands, which is the point.
      //
      // The operator list is a third thing only pdf.js can supply, and it is
      // untouched by whatever went wrong with the *text* — so a recovered page
      // keeps its figures instead of losing them along with the runs.
      let annotations: AnnotationLike[] = []
      let placements: ImagePlacement[] = []
      try {
        const page = await open.doc.getPage(retry.pageIndex + 1)
        annotations = (await page.getAnnotations().catch(() => [])) as AnnotationLike[]
        const ops = (await page.getOperatorList().catch(() => null)) as unknown as OpList | null
        if (ops) placements = traceImagePlacements(ops, page.view)
        releasePage(page, open.pageCount)
      } catch (error) {
        if (isAbortError(error)) throw error
      }
      const options = pageOptions(retry.pageIndex, continuationHintFor(pages[retry.position - 1]))
      pages[retry.position] = assemblePage(
        retry.pageIndex,
        {
          ...entry.source,
          annotations,
          placements,
          internalLinks: await resolveInternalLinks(
            annotations,
            entry.source.height,
            options.resolveDest,
          ),
        },
        // The page before this one is settled by now — every earlier retry has
        // been reassembled — so its table, if it ended with one, still speaks
        // for the top of this page even though the engines disagreed about how
        // to read it.
        options,
      )
      continue
    }
    if (retry.error !== null) throw retry.error
    pages[retry.position] = retry.fallback
  }
}

async function handleExtract(request: ExtractRequest): Promise<void> {
  const open = requireDoc(request.fileId)
  if (!open) {
    post({
      kind: 'error',
      id: request.id,
      fileId: request.fileId,
      reasonCode: 'PDF_CORRUPTED',
      message: 'document is not open',
    })
    return
  }
  const controller = new AbortController()
  aborts.set(request.id, controller)
  const pageOptions = (
    pageIndex: number,
    continuation: TableContinuation | null = null,
  ): ExtractPageOptions => ({
    pageIndex,
    ...(request.ctx ? { ctx: request.ctx } : {}),
    ...(request.headerTexts ? { headerTexts: request.headerTexts } : {}),
    ...(request.footerTexts ? { footerTexts: request.footerTexts } : {}),
    ...(request.headingSizes ? { headingSizes: request.headingSizes } : {}),
    ...(request.convertZawgyi !== undefined ? { convertZawgyi: request.convertZawgyi } : {}),
    ...(continuation ? { continuation } : {}),
    resolveDest: (dest: unknown) => resolveDestination(open.doc, dest),
  })

  try {
    const total = request.pageIndexes.length
    const pages: Array<ExtractedPage | null> = new Array(total).fill(null)
    const retries: FailedPage[] = []
    // The page before the one being read, so a table that ends at the break
    // can vouch for the top of the next one. Windows are read in order, so the
    // predecessor is always in hand — except after a page that produced
    // nothing, where the evidence ends with it.
    let previous: ExtractedPage | null = null

    for (let position = 0; position < total; position += 1) {
      if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError')
      const pageIndex = request.pageIndexes[position]
      let page: PDFPageProxy | null = null
      let extracted: ExtractedPage | null = null
      let failure: unknown = null
      try {
        // Both halves of a read are guarded: a page object pdf.js cannot
        // even load is the same failure as one it cannot measure. One
        // unreadable page must not take the window with it — the pages after
        // it are unaffected by its contents.
        page = await open.doc.getPage(pageIndex + 1)
        extracted = await extractPage(page, pageOptions(pageIndex, continuationHintFor(previous)))
      } catch (error) {
        if (isAbortError(error)) throw error
        failure = error
      } finally {
        if (page !== null) releasePage(page, open.pageCount)
      }

      if (failure !== null) {
        retries.push({ position, pageIndex, error: failure, fallback: extracted })
      } else if (extracted && needsSidecarFallback(extracted)) {
        retries.push({ position, pageIndex, error: null, fallback: extracted })
      } else {
        pages[position] = extracted
      }
      previous = extracted

      post({
        kind: 'progress',
        id: request.id,
        fileId: request.fileId,
        stage: 'extract',
        done: position + 1,
        total,
      })
    }

    await recoverWithSidecar(open, retries, pages, pageOptions, controller.signal)

    // Every position is filled by one engine or the other; anything else is a
    // programming error, and dropping the page silently would look like a
    // document that lost content on export.
    const result = pages.map((page, position) => {
      if (page === null) {
        throw new Error(`page ${request.pageIndexes[position]} was not extracted`)
      }
      return page
    })
    post({ kind: 'extractResult', id: request.id, fileId: request.fileId, pages: result })
  } catch (error) {
    if (isAbortError(error)) {
      post({ kind: 'cancelled', id: request.id, fileId: request.fileId })
      return
    }
    post({
      kind: 'error',
      id: request.id,
      fileId: request.fileId,
      reasonCode: reasonOf(error),
      message: errorMessage(error),
    })
  } finally {
    aborts.delete(request.id)
  }
}

function handleRender(request: RenderRequest): void {
  const crops = request.crops ?? []
  const key = renderKey(request.fileId, request.pageIndex, request.scale, request.mode, crops)
  const stale = renderByKey.get(key)
  if (stale) {
    // A newer request for the same page supersedes the older one.
    stale.cancelled = true
    stale.handle?.cancel()
  }
  const entry: RenderEntry = {
    id: request.id,
    fileId: request.fileId,
    pageIndex: request.pageIndex,
    mode: request.mode,
    scale: request.scale,
    cancelled: false,
    handle: null,
    crops,
  }
  renderByKey.set(key, entry)
  renderQueue.push(entry)
  void drainRenders()
}

async function drainRenders(): Promise<void> {
  if (rendering) return
  rendering = true
  try {
    while (renderQueue.length > 0) {
      const entry = renderQueue.shift()
      if (!entry) break
      if (entry.cancelled) {
        post({ kind: 'cancelled', id: entry.id, fileId: entry.fileId })
        continue
      }
      await runRender(entry)
    }
  } finally {
    rendering = false
  }
}

async function runRender(entry: RenderEntry): Promise<void> {
  const key = renderKey(entry.fileId, entry.pageIndex, entry.scale, entry.mode, entry.crops)
  const open = requireDoc(entry.fileId)
  if (!open) {
    renderByKey.delete(key)
    post({
      kind: 'error',
      id: entry.id,
      fileId: entry.fileId,
      reasonCode: 'PDF_CORRUPTED',
      message: 'document is not open',
    })
    return
  }

  try {
    const page = await open.doc.getPage(entry.pageIndex + 1)
    const handle = renderPage(page, {
      scale: entry.scale,
      maskText: entry.mode === 'background',
      ...(entry.crops.length > 0 ? { crops: entry.crops } : {}),
    })
    entry.handle = handle
    if (entry.cancelled) handle.cancel()
    const result = await handle.promise
    if (entry.cancelled) {
      post({ kind: 'cancelled', id: entry.id, fileId: entry.fileId })
      return
    }
    post({
      kind: 'renderResult',
      id: entry.id,
      fileId: entry.fileId,
      pageIndex: entry.pageIndex,
      mode: entry.mode,
      blob: result.page,
      ...(result.crops.length > 0 ? { crops: result.crops } : {}),
    })
  } catch (error) {
    if (entry.cancelled || isRenderCancelled(error)) {
      post({ kind: 'cancelled', id: entry.id, fileId: entry.fileId })
    } else {
      post({
        kind: 'error',
        id: entry.id,
        fileId: entry.fileId,
        reasonCode: reasonOf(error),
        message: errorMessage(error),
      })
    }
  } finally {
    entry.handle = null
    if (renderByKey.get(key) === entry) renderByKey.delete(key)
  }
}

function cancelRender(entry: RenderEntry): void {
  // Started renders report `cancelled` from `runRender`; queued ones from the
  // drain loop — so this only marks them and breaks any live render task.
  entry.cancelled = true
  entry.handle?.cancel()
}

async function handleClose(request: { id: string; fileId: string }): Promise<void> {
  for (const entry of [...renderByKey.values()]) {
    if (entry.fileId === request.fileId) cancelRender(entry)
  }
  const open = docs.get(request.fileId)
  docs.delete(request.fileId)
  if (open) await open.task.destroy().catch(() => undefined)
  post({ kind: 'closed', id: request.id, fileId: request.fileId })
}

function handleCancel(request: { id: string }): void {
  const controller = aborts.get(request.id)
  if (controller) {
    controller.abort()
    return
  }
  const entry = [...renderByKey.values()].find((candidate) => candidate.id === request.id)
  if (entry) cancelRender(entry)
}

/* ------------------------------------------------------------------ */
/* Message plumbing                                                    */
/* ------------------------------------------------------------------ */

async function handle(message: AnalysisRequest): Promise<void> {
  switch (message.kind) {
    case 'open':
      await handleOpen(message)
      return
    case 'probe':
      await handleProbe(message)
      return
    case 'extract':
      await handleExtract(message)
      return
    case 'render':
      handleRender(message)
      return
    case 'close':
      await handleClose(message)
      return
    case 'cancel':
      handleCancel(message)
      return
    default: {
      // Exhaustiveness guard: an unknown kind is a programming error.
      const never: never = message
      void never
    }
  }
}

scope.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  void handle(event.data)
}
