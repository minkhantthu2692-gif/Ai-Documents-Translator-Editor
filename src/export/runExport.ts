/**
 * Export orchestration (Phase 4).
 *
 * The one function the UI calls. It walks the stages the protocol defines —
 * **collect** the document from Dexie, **render** the page artwork through the
 * analysis worker, **build** the file in the export worker, **write** it out —
 * and reports a single 0..1 ratio so the progress bar never jumps backwards.
 *
 * Two things happen before a single byte is built:
 *
 *  - the document is checked for text (`EXPORT_EMPTY`);
 *  - every font family is resolved against the browser. Extracted PDFs carry
 *    subset names (`ABCDEF+Calibri`) that no machine has, so missing families
 *    are substituted with a bundled face chosen for their script and reported
 *    as an `EXPORT_FONT_MISSING` issue — the Export dialog shows the mapping
 *    and lets the user keep the original names instead.
 */

import { blockRepo } from '@/db/repo-content'
import { checkFonts, collectFontFaces, suggestFallback, type FontFaceInfo } from '@/fonts'
import { downloadBlob } from '@/lib/download'
import { ExportBuildError, buildInWorker, stageProgress } from './client'
import { collectExportDocument, usedFamilies } from './collect'
import { renderPageImages, needsImages, type RenderedImage } from './pageImages'
import { renderFigureCrops } from './figureCrops'
import { figureTargets, loadFigureArt } from './figureArt'
import type { FigureArt } from './figureArt'
import { printHtmlDocument } from './printFrame'
import { fileNameFor, isDocumentEmpty, resolvedOptions, slugify, documentStats } from './shared'
import type {
  ExportArtifact,
  ExportDocument,
  ExportIssue,
  ExportOptions,
  ExportProgress,
} from './types'

/** Families the export font stack always offers (Myanmar must shape). */
export const EXPORT_STACK_FAMILIES = ['Noto Sans Myanmar', 'Padauk', 'Noto Sans', 'Noto Serif']

export interface FontPreflight {
  /** Every family the document references (after substitution). */
  families: string[]
  /** Families the browser cannot resolve. */
  missing: string[]
  /** Suggested replacement per missing family (the "fix action"). */
  substitutions: Record<string, string>
  /** `@font-face` rules available for embedding. */
  faces: FontFaceInfo[]
}

export interface RunExportInput {
  projectId: string
  options: ExportOptions
  /** Only these pages (0-based). Undefined = the whole document. */
  pageIndexes?: number[]
  /** Family → replacement; defaults to the preflight suggestion. */
  fontSubstitutions?: Record<string, string>
  /** Report missing families but keep the original names in the output. */
  keepMissingFonts?: boolean
  onProgress?: (progress: ExportProgress) => void
  /** Cancels the artwork render between pages (the build itself is not abortable). */
  signal?: AbortSignal
}

export interface ExportResult {
  artifact: ExportArtifact
  options: ExportOptions
  doc: ExportDocument
  stats: ReturnType<typeof documentStats>
  /** `EXPORT_FONT_MISSING` (substituted) and missing-artwork warnings. */
  issues: ExportIssue[]
  preflight: FontPreflight
  durationMs: number
}

function samplePerFamily(entries: Array<{ family: string; sample: string }>): Map<string, string> {
  return new Map(entries.map((entry) => [entry.family, entry.sample]))
}

/**
 * Distinct font families referenced by the project plus a short text sample
 * (the sample decides whether a substitution has to be Myanmar-capable).
 */
export async function projectFontFamilies(
  projectId: string,
): Promise<Array<{ family: string; sample: string }>> {
  const blocks = await blockRepo.listByProject(projectId)
  const out = new Map<string, string>()
  for (const block of blocks) {
    const family = block.fontFamily.trim()
    if (family.length === 0) continue
    if (!out.has(family)) out.set(family, (block.translatedText || block.sourceText).slice(0, 60))
  }
  return [...out].map(([family, sample]) => ({ family, sample }))
}

/**
 * The check the Export dialog runs when it opens: what is missing, and what
 * each missing family would be replaced with. Never throws — a browser that
 * cannot answer simply reports nothing missing.
 */
export async function preflightProject(projectId: string): Promise<FontPreflight> {
  const entries = await projectFontFamilies(projectId)
  return preflightFamilies(entries)
}

export async function preflightFamilies(
  entries: Array<{ family: string; sample: string }>,
): Promise<FontPreflight> {
  const families = entries.map((entry) => entry.family)
  const check = await checkFonts(families)
  const samples = samplePerFamily(entries)
  const substitutions: Record<string, string> = {}
  for (const family of check.missing) {
    substitutions[family] = suggestFallback(family, samples.get(family) ?? '')
  }
  return {
    families,
    missing: check.missing,
    substitutions,
    faces: collectFontFaces([...families, ...EXPORT_STACK_FAMILIES]),
  }
}

/** Which formats cannot be built without rendered page artwork. */
export function imageRequirement(format: ExportOptions['format'], includeImages: boolean): boolean {
  if (format === 'pdf-raster' || format === 'images') return true
  if (!includeImages) return false
  return needsImages(format)
}

/**
 * Which formats need figures cropped out of their pages.
 *
 * Exactly the three that can embed a standalone picture but have no page-art
 * channel: `html`, `pdf`, `bilingual-pdf`, `pdf-raster` and `images` already
 * put the whole rendered page behind their text, so the figures are visible
 * there and cropping them would only duplicate them; `json` carries the
 * geometry and `text`/`csv`/`tsv` are not documents. The formats in this list
 * are the ones that would otherwise lose every picture.
 */
export function figureRequirement(
  format: ExportOptions['format'],
  includeImages: boolean,
): boolean {
  if (!includeImages) return false
  return format === 'docx' || format === 'epub' || format === 'markdown'
}

function addIssue(list: ExportIssue[], issue: ExportIssue): void {
  const key = `${issue.code}|${issue.fonts.join(',')}|`
  if (list.some((existing) => `${existing.code}|${existing.fonts.join(',')}|` === key)) return
  list.push(issue)
}

/** Runs every stage. Rejects with an `ExportBuildError` on a hard failure. */
export async function runExport(input: RunExportInput): Promise<ExportResult> {
  const started = Date.now()
  const options = { ...resolvedOptions(input.options) }
  const report = (stage: ExportProgress['stage'], done: number, total: number): void => {
    input.onProgress?.(stageProgress(stage, done, total))
  }
  const issues: ExportIssue[] = []

  // ── collect ────────────────────────────────────────────────────────────
  report('collect', 0, 1)
  const preflight = await preflightProject(input.projectId)
  const substitutions =
    input.fontSubstitutions ?? (input.keepMissingFonts ? {} : preflight.substitutions)
  if (preflight.missing.length > 0 && !input.keepMissingFonts) {
    addIssue(issues, {
      code: 'EXPORT_FONT_MISSING',
      fonts: preflight.missing,
      detail: Object.entries(substitutions)
        .map(([from, to]) => `${from} → ${to}`)
        .join(', '),
    })
  }

  const doc = await collectExportDocument({
    projectId: input.projectId,
    ...(input.pageIndexes ? { pageIndexes: input.pageIndexes } : {}),
    fontSubstitutions: substitutions,
    onProgress: (done, total) => report('collect', done, total),
  })
  if (isDocumentEmpty(doc)) {
    throw new ExportBuildError(
      'EXPORT_EMPTY',
      'there is no translated text in this document yet',
      [],
    )
  }
  if (options.fileName.trim().length === 0) options.fileName = slugify(doc.title)

  // ── render ─────────────────────────────────────────────────────────────
  let images: RenderedImage[] = []
  if (imageRequirement(options.format, options.includeImages)) {
    report('render', 0, doc.pages.length)
    images = await renderPageImages({
      projectId: input.projectId,
      pageIndexes: doc.pages.map((page) => page.index),
      scale: options.imageScale,
      mode: 'background',
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (done, total) => report('render', done, total),
    })
    if (images.length < doc.pages.length) {
      addIssue(issues, {
        code: 'EXPORT_FAILED',
        fonts: [],
        detail: `${doc.pages.length - images.length} of ${doc.pages.length} page backgrounds could not be rendered; those pages export as text on a white sheet`,
      })
    }
  }

  // ── figures ────────────────────────────────────────────────────────────
  // Only the formats with no page-art channel pay for this, and only the
  // pages that actually carry a picture are rasterised — a 300-page report
  // with four diagrams costs four renders, not three hundred.
  let figures: FigureArt[] = []
  if (figureRequirement(options.format, options.includeImages)) {
    const wanted = figureTargets(doc)
    if (wanted.length > 0) {
      report('render', 0, 1)
      const crops = await renderFigureCrops({
        projectId: input.projectId,
        doc,
        scale: options.imageScale,
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: (done, total) => report('render', done, total),
      })
      figures = await loadFigureArt(crops)
      if (figures.length < wanted.length) {
        addIssue(issues, {
          code: 'EXPORT_FAILED',
          fonts: [],
          detail: `${wanted.length - figures.length} of ${wanted.length} figures could not be cropped from their pages; those pictures are missing from this ${options.format.toUpperCase()} file`,
        })
      }
    }
  }

  // ── build ──────────────────────────────────────────────────────────────
  report('build', 0, 1)
  const faces = collectFontFaces([...usedFamilies(doc), ...EXPORT_STACK_FAMILIES])
  const artifact: ExportArtifact = await buildInWorker(
    {
      kind: 'build',
      id: `export_${started}`,
      doc,
      options,
      fontFaces: faces.length > 0 ? faces : preflight.faces,
      images,
      ...(figures.length > 0 ? { figures } : {}),
    },
    (progress) => input.onProgress?.(progress),
  )
  for (const issue of artifact.issues) addIssue(issues, issue)

  input.onProgress?.({ stage: 'write', done: 1, total: 1, ratio: 1 })
  return {
    artifact,
    options,
    doc,
    stats: documentStats(doc),
    issues,
    preflight,
    durationMs: Date.now() - started,
  }
}

export interface DeliveryResult {
  ok: boolean
  detail: string
}

/**
 * Hands the finished artifact to the browser: PDF paths go through the hidden
 * print frame (that *is* how a print-optimised PDF is produced), everything
 * else is a download.
 */
export async function deliverExport(result: ExportResult): Promise<DeliveryResult> {
  const { artifact } = result
  if (artifact.format === 'pdf' || artifact.format === 'bilingual-pdf') {
    const html = await artifact.blob.text()
    return printHtmlDocument(html, result.doc.title || 'Export')
  }
  downloadBlob(artifact.blob, artifact.fileName || fileNameFor(result.options, artifact.format))
  return { ok: true, detail: 'downloaded' }
}
