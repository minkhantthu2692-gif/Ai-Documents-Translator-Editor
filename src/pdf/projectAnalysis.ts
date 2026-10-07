/**
 * Persistence for everything the analysis worker produces.
 *
 * The worker is stateless across page reloads and never touches Dexie: once a
 * probe or a page window comes back, this module writes it into IndexedDB —
 * page rows and margins from the probe, block rows from extraction — so the
 * UI can read it with `useLiveQuery` and a reload never loses work.
 *
 * It also owns document lifecycle: which files are currently open in the
 * worker, and how to re-open one straight from its stored bytes.
 */

import { blockRepo, pageRepo, type ParsedBlockPatch } from '@/db/repo-content'
import { sourceFileRepo } from '@/db/repo-sourceFiles'
import { settingsRepo } from '@/db/repo-settings'
import { analysisClient, AnalysisError, type OpenOutcome } from './analysisClient'
import type { ContentTally } from './pageClassify'
import type { FontStats } from './pdfOps'
import type { ExtractedPage, ProbeResult } from './pdfExtract'

/* ------------------------------------------------------------------ */
/* Document lifecycle                                                  */
/* ------------------------------------------------------------------ */

/** Files the worker currently holds open (survives wizard steps). */
const openFiles = new Set<string>()

export function isDocumentOpen(fileId: string): boolean {
  return openFiles.has(fileId)
}

/**
 * Opens a file in the worker. `bytes` is *transferred*, so the caller must
 * re-read its `File`/`Blob` to open the same document again.
 */
export async function openDocument(
  fileId: string,
  source: Blob | ArrayBuffer,
  options: { password?: string; signal?: AbortSignal } = {},
): Promise<OpenOutcome> {
  const bytes = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  const outcome = await analysisClient.open(fileId, bytes, options)
  if (outcome.status === 'opened') openFiles.add(fileId)
  else openFiles.delete(fileId)
  return outcome
}

/**
 * Makes sure a project's stored source file is open in the worker, reading it
 * from IndexedDB on demand (after a reload, or a fresh session).
 */
export async function ensureProjectDocument(
  projectId: string,
  options: { password?: string } = {},
): Promise<{ fileId: string; outcome: OpenOutcome }> {
  const source = await sourceFileRepo.getLatestByProject(projectId)
  if (!source) {
    throw new AnalysisError('PDF_CORRUPTED', `no source file for project ${projectId}`)
  }
  if (openFiles.has(source.id) && !options.password) {
    return { fileId: source.id, outcome: { status: 'opened', pageCount: source.pageCount } }
  }
  // The stored password unlocks reloads; an explicit one (re-entered in a
  // session where it was rejected) always wins.
  const password = options.password ?? source.password ?? undefined
  const outcome = await openDocument(source.id, source.blob, {
    ...(password ? { password } : {}),
  })
  return { fileId: source.id, outcome }
}

export async function closeDocument(fileId: string): Promise<void> {
  if (!openFiles.delete(fileId)) return
  await analysisClient.close(fileId).catch(() => undefined)
}

/* ------------------------------------------------------------------ */
/* Probe persistence                                                   */
/* ------------------------------------------------------------------ */

const docKey = (projectId: string): string => `analysis.doc.${projectId}`
const marginsKey = (projectId: string): string => `analysis.margins.${projectId}`

/** Document-level facts a pre-flight, the Status Panel and the UI all need. */
export interface ProjectAnalysis {
  pageCount: number
  pdfVersion: string | null
  encrypted: boolean
  title: string | null
  author: string | null
  subject: string | null
  creator: string | null
  producer: string | null
  language: string | null
  creationDate: string | null
  modificationDate: string | null
  documentLanguage: string | null
  documentConfidence: number
  zawgyiProbability: number
  convertZawgyi: boolean
  tally: ContentTally
  textLayerPages: number
  ocrNeededPages: number
  totalChars: number
  totalImages: number
  annotations: number
  formFields: number
  fonts: FontStats
  headerTexts: string[]
  footerTexts: string[]
  analyzedAt: number
}

function toProjectAnalysis(probe: ProbeResult): ProjectAnalysis {
  const { info, summary } = probe
  return {
    pageCount: info.pageCount,
    pdfVersion: info.pdfVersion,
    encrypted: info.encrypted,
    title: info.title,
    author: info.author,
    subject: info.subject,
    creator: info.creator,
    producer: info.producer,
    language: info.language,
    creationDate: info.creationDate,
    modificationDate: info.modificationDate,
    documentLanguage: summary.documentLanguage,
    documentConfidence: summary.documentConfidence,
    zawgyiProbability: summary.zawgyiProbability,
    convertZawgyi: summary.convertZawgyi,
    tally: summary.tally,
    textLayerPages: summary.textLayerPages,
    ocrNeededPages: summary.ocrNeededPages,
    totalChars: summary.totalChars,
    totalImages: summary.totalImages,
    annotations: summary.annotations,
    formFields: summary.formFields,
    fonts: info.fonts,
    headerTexts: summary.headerTexts,
    footerTexts: summary.footerTexts,
    analyzedAt: Date.now(),
  }
}

/**
 * Writes the probe result: one row per page plus the document-level settings
 * (`analysis.doc.*`, `analysis.margins.*`) that extraction and the Status
 * Panel read back.
 */
export async function persistProbe(
  projectId: string,
  probe: ProbeResult,
): Promise<ProjectAnalysis> {
  const analysis = toProjectAnalysis(probe)
  await settingsRepo.set(docKey(projectId), analysis, 'analysis')
  await settingsRepo.set(
    marginsKey(projectId),
    { headers: probe.summary.headerTexts, footers: probe.summary.footerTexts },
    'analysis',
  )

  for (const page of probe.probes) {
    await pageRepo.upsert({
      projectId,
      index: page.index,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      hasTextLayer: page.contentClass === 'text' || page.contentClass === 'mixed',
      textCharacterCount: page.charCount,
      contentClass: page.contentClass,
      textCoverage: page.textCoverage,
      detectedLanguage: page.detectedLanguage,
      lineCount: page.lineCount,
      blockCount: 0,
      analysisState: 'idle',
    })
  }
  return analysis
}

export function loadProjectAnalysis(projectId: string): Promise<ProjectAnalysis | null> {
  return settingsRepo.get<ProjectAnalysis | null>(docKey(projectId), null)
}

export interface ProjectMargins {
  headers: string[]
  footers: string[]
}

export function loadMargins(projectId: string): Promise<ProjectMargins> {
  return settingsRepo.get<ProjectMargins>(marginsKey(projectId), { headers: [], footers: [] })
}

/* ------------------------------------------------------------------ */
/* Extraction persistence                                              */
/* ------------------------------------------------------------------ */

function toBlockPatch(
  projectId: string,
  pageId: string,
  block: ExtractedPage['blocks'][number],
): ParsedBlockPatch {
  return {
    id: block.id,
    projectId,
    pageId,
    order: block.order,
    kind: block.kind,
    sourceText: block.text,
    x: block.bbox.x,
    y: block.bbox.y,
    width: block.bbox.w,
    height: block.bbox.h,
    fontFamily: block.fontFamily,
    fontSize: block.fontSize,
    lineHeight: block.lineSpacing,
    color: block.color,
    bold: block.bold,
    italic: block.italic,
    characterCount: block.text.length,
    region: block.region,
    alignment: block.alignment,
    lines: block.lines,
    skipRule: block.skipRule,
    placeholders: block.placeholders,
    listMarker: block.listMarker,
  }
}

/**
 * Writes a window of extracted pages: blocks first (stable ids, so a re-parse
 * updates rows in place and never duplicates them), then the page row with its
 * block count, then any block a previous parse produced but this one didn't.
 */
export async function persistExtractedPages(
  projectId: string,
  pages: ExtractedPage[],
): Promise<void> {
  for (const page of pages) {
    const record =
      (await pageRepo.getByIndex(projectId, page.pageIndex)) ??
      (await pageRepo.upsert({ projectId, index: page.pageIndex }))

    await blockRepo.upsertParsed(
      page.blocks.map((block) => toBlockPatch(projectId, record.id, block)),
    )
    await blockRepo.removeStaleByPage(
      record.id,
      page.blocks.map((block) => block.id),
    )

    await pageRepo.upsert({
      projectId,
      index: page.pageIndex,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      textCharacterCount: page.charCount,
      lineCount: page.lineCount,
      blockCount: page.blocks.length,
      analysisState: 'done',
    })
  }
}
