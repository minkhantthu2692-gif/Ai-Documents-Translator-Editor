/**
 * Analysis worker protocol.
 *
 * The main thread owns Dexie and the UI; this worker owns pdf.js. Every
 * message carries a request `id` so replies, progress and cancellation can be
 * correlated; `fileId` identifies which open document the request belongs to.
 *
 * Data crossing the boundary is structured-clone friendly: plain objects,
 * ArrayBuffers and Blobs (thumbnails come back as Blobs, never as bitmaps).
 */

import type { ReasonCode } from '@/core/reasonCodes'
import type { ExtractedPage, ProbeResult } from '@/pdf/pdfExtract'
import type { FigureCropTarget, PageCrop } from '@/pdf/pageRender'
import type { SkipContext } from '@/pdf/skipRules'

export type AnalysisStage = 'open' | 'probe' | 'extract' | 'render'

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

interface RequestBase {
  id: string
  fileId: string
}

/** Opens (or re-opens with a password) a document from transferred bytes. */
export interface OpenRequest extends RequestBase {
  kind: 'open'
  bytes: ArrayBuffer
  password?: string
}

export interface ProbeRequest extends RequestBase {
  kind: 'probe'
}

/** Extracts the given pages, in order, and reports progress per page. */
export interface ExtractRequest extends RequestBase {
  kind: 'extract'
  pageIndexes: number[]
  ctx?: SkipContext
  headerTexts?: string[]
  footerTexts?: string[]
  /** Document-wide heading ladder from the probe (see `pdf/headings.ts`). */
  headingSizes?: number[]
  convertZawgyi?: boolean
}

export interface RenderRequest extends RequestBase {
  kind: 'render'
  pageIndex: number
  /** Viewport scale — thumbnails use ~0.2, backgrounds the display scale. */
  scale: number
  /** `thumbnail` keeps the text, `background` masks it out. */
  mode: 'thumbnail' | 'background'
  /**
   * Page rectangles to cut out of the finished render and hand back as
   * separate pictures. This is how the figure pipeline feeds the formats that
   * can only embed standalone images (DOCX, EPUB, Markdown) without ever
   * shipping whole pages across the worker boundary.
   */
  crops?: FigureCropTarget[]
}

export interface CloseRequest extends RequestBase {
  kind: 'close'
}

export interface CancelRequest {
  kind: 'cancel'
  /** Id of the request to abort. */
  id: string
}

export type AnalysisRequest =
  OpenRequest | ProbeRequest | ExtractRequest | RenderRequest | CloseRequest | CancelRequest

/** The same union with the correlation id stripped (the client fills it in). */
type WithoutId<T> = T extends { id: string } ? Omit<T, 'id'> : never

export type AnalysisPayload = WithoutId<AnalysisRequest>

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export interface ProgressEvent {
  kind: 'progress'
  id: string
  fileId: string
  stage: AnalysisStage
  done: number
  total: number
}

export interface OpenedEvent {
  kind: 'opened'
  id: string
  fileId: string
  pageCount: number
  /**
   * Damaged-structure repairs the worker applied before this open succeeded
   * (see `repairPdf`); absent when the file opened as-is.
   */
  repaired?: string[]
}

export interface PasswordRequiredEvent {
  kind: 'passwordRequired'
  id: string
  fileId: string
  /** `missing` — no password tried yet; `incorrect` — the password was rejected. */
  reason: 'missing' | 'incorrect'
}

export interface ProbeResultEvent {
  kind: 'probeResult'
  id: string
  fileId: string
  result: ProbeResult
}

export interface ExtractResultEvent {
  kind: 'extractResult'
  id: string
  fileId: string
  pages: ExtractedPage[]
}

export interface RenderResultEvent {
  kind: 'renderResult'
  id: string
  fileId: string
  pageIndex: number
  mode: 'thumbnail' | 'background'
  /**
   * The whole page. `null` when the request only asked for `crops` — a
   * figure-only export has no use for the page and should not pay to encode,
   * clone and post it.
   */
  blob: Blob | null
  /** The requested cut-outs; absent unless the request asked for them. */
  crops?: PageCrop[]
}

export interface ClosedEvent {
  kind: 'closed'
  id: string
  fileId: string
}

export interface CancelledEvent {
  kind: 'cancelled'
  id: string
  fileId: string
}

export interface AnalysisErrorEvent {
  kind: 'error'
  id: string
  fileId: string
  reasonCode: ReasonCode
  message: string
}

export type AnalysisEvent =
  | ProgressEvent
  | OpenedEvent
  | PasswordRequiredEvent
  | ProbeResultEvent
  | ExtractResultEvent
  | RenderResultEvent
  | ClosedEvent
  | CancelledEvent
  | AnalysisErrorEvent

/** Extracts the payload type of one event kind. */
export type EventOf<K extends AnalysisEvent['kind']> = Extract<AnalysisEvent, { kind: K }>
