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
} from 'pdfjs-dist'
import * as pdfjsWorkerHandler from 'pdfjs-dist/build/pdf.worker.mjs'
import type { ReasonCode } from '@/core/reasonCodes'
import { PDF_DOCUMENT_PARAMS } from '@/pdf/pdfAssets'
import { extractPage, probeDocument, type ExtractedPage } from '@/pdf/pdfExtract'
import { isRenderCancelled, renderPage, type RenderHandle } from '@/pdf/pageRender'
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
}

const renderQueue: RenderEntry[] = []
const renderByKey = new Map<string, RenderEntry>()
let rendering = false

/** Supersede only an identical render — scale and mode identify the consumer. */
const renderKey = (fileId: string, pageIndex: number, scale: number, mode: string): string =>
  `${fileId}#${pageIndex}#${scale}#${mode}`

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

    const task = getDocument({
      // Take a private copy: the transferred buffer must stay readable for the
      // document's whole lifetime (pdf.js reads it lazily).
      data: new Uint8Array(request.bytes).slice(),
      ...(request.password ? { password: request.password } : {}),
      ...PDF_DOCUMENT_PARAMS,
    })
    const doc = await task.promise
    if (controller.signal.aborted) {
      await task.destroy().catch(() => undefined)
      post({ kind: 'cancelled', id: request.id, fileId: request.fileId })
      return
    }
    docs.set(request.fileId, { task, doc, pageCount: doc.numPages })
    post({
      kind: 'opened',
      id: request.id,
      fileId: request.fileId,
      pageCount: doc.numPages,
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
  try {
    const pages: ExtractedPage[] = []
    const total = request.pageIndexes.length
    for (let position = 0; position < total; position += 1) {
      if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError')
      const pageIndex = request.pageIndexes[position]
      const page = await open.doc.getPage(pageIndex + 1)
      const extracted = await extractPage(page, {
        pageIndex,
        ...(request.ctx ? { ctx: request.ctx } : {}),
        ...(request.headerTexts ? { headerTexts: request.headerTexts } : {}),
        ...(request.footerTexts ? { footerTexts: request.footerTexts } : {}),
        ...(request.convertZawgyi !== undefined ? { convertZawgyi: request.convertZawgyi } : {}),
      })
      pages.push(extracted)
      releasePage(page, open.pageCount)
      post({
        kind: 'progress',
        id: request.id,
        fileId: request.fileId,
        stage: 'extract',
        done: position + 1,
        total,
      })
    }
    post({ kind: 'extractResult', id: request.id, fileId: request.fileId, pages })
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
  const key = renderKey(request.fileId, request.pageIndex, request.scale, request.mode)
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
  const key = renderKey(entry.fileId, entry.pageIndex, entry.scale, entry.mode)
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
    })
    entry.handle = handle
    if (entry.cancelled) handle.cancel()
    const blob = await handle.promise
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
      blob,
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
