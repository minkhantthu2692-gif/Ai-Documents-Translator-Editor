/**
 * Export worker protocol (Phase 4).
 *
 * One request → progress messages → one terminal message. Blobs are
 * structured-cloneable, so the worker hands the finished file straight back
 * and the main thread only decides whether to download it or feed it to the
 * print frame.
 */

import type {
  ExportArtifact,
  ExportDocument,
  ExportFormat,
  ExportIssue,
  ExportOptions,
  ExportStage,
} from './types'
import type { FontFaceInfo } from '@/fonts'

export interface ExportBuildRequest {
  kind: 'build'
  id: string
  doc: ExportDocument
  options: ExportOptions
  /** `@font-face` inventory collected from the CSSOM on the main thread. */
  fontFaces: FontFaceInfo[]
  /** Rendered page backgrounds (index → blob), when the caller rendered them. */
  images: Array<{ index: number; blob: Blob }>
}

export type ExportWorkerRequest = ExportBuildRequest

export interface ExportProgressMessage {
  kind: 'progress'
  id: string
  stage: ExportStage
  done: number
  total: number
}

export interface ExportDoneMessage {
  kind: 'done'
  id: string
  artifact: ExportArtifact
}

export interface ExportFailedMessage {
  kind: 'failed'
  id: string
  code: ExportIssue['code']
  detail: string
  fonts: string[]
}

export type ExportWorkerResponse = ExportProgressMessage | ExportDoneMessage | ExportFailedMessage

/** Mime type each format's bytes are handed back with. */
export const WORKER_MIME: Record<ExportFormat, string> = {
  pdf: 'text/html;charset=utf-8',
  'bilingual-pdf': 'text/html;charset=utf-8',
  'pdf-raster': 'application/pdf',
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
