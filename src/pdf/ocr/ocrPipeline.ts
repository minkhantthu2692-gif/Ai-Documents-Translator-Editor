/**
 * OCR for pages whose content lives in images — the "scanned" half of the
 * extraction-method matrix (text / OCR / hybrid / none).
 *
 * Runs **inside the parse window**, right after text extraction: the document
 * is open in the analysis worker, so recognition reuses the ordinary render
 * path (`scale 4` ≈ 288 DPI), results land in the Dexie `ocr` cache (a
 * re-parse never pays for recognition twice) and the page row walks
 * `queued → running → done | failed`. Failures are per-page: one unreadable
 * scan never fails the window, and the row stays visible for a retry
 * (`pageNeedsOcr` keeps such pages "unparsed" so the next session resumes).
 *
 * When the user opted out (wizard "Run OCR" toggle, persisted per project)
 * nothing here runs; when the source language has no traineddata the pages
 * are marked failed once, with an actionable log event.
 */

import { logEvent } from '@/core/eventLogger'
import { isOcrLanguageSupported, recognizeCached, tesseractCodeFor } from '@/ocr/ocrClient'
import { pageRepo } from '@/db/repo-content'
import { settingsRepo } from '@/db/repo-settings'
import { pageNeedsOcr, type PageRecord } from '@/db/types'
import { analysisClient, AnalysisCancelled } from '../analysisClient'
import type { SkipContext } from '../skipRules'
import { ocrToBlocks, type OcrPageContent } from './ocrStructure'

/** Pixels per PDF point for recognition — 4 × 72 = 288 DPI, near tesseract's sweet spot. */
export const OCR_RENDER_SCALE = 4

const ocrKey = (projectId: string): string => `analysis.ocr.${projectId}`

/** Per-project OCR preference (wizard toggle). Defaults to on. */
export async function isOcrEnabled(projectId: string): Promise<boolean> {
  const setting = await settingsRepo.get<{ enabled: boolean }>(ocrKey(projectId), { enabled: true })
  return setting?.enabled !== false
}

export function setOcrEnabled(projectId: string, enabled: boolean): Promise<void> {
  return settingsRepo.set(ocrKey(projectId), { enabled }, 'analysis').then(() => undefined)
}

export interface OcrPageResult {
  pageIndex: number
  content: OcrPageContent
  /** Mean confidence 0..100 of the recognition run. */
  confidence: number
}

export interface WindowOcrOptions {
  projectId: string
  fileId: string
  pageIndexes: number[]
  /** App language code of the document (`en`) — drives the traineddata choice. */
  sourceLang: string
  ctx?: SkipContext
  headerTexts?: string[]
  footerTexts?: string[]
  convertZawgyi?: boolean
  signal?: AbortSignal
}

/** Rendered (rotation-adjusted) page dimensions, matching the OCR image. */
function renderedSize(page: PageRecord): { width: number; height: number } {
  const rotated = Math.abs(page.rotation % 180) === 90
  return rotated
    ? { width: page.height, height: page.width }
    : { width: page.width, height: page.height }
}

async function markFailed(pages: PageRecord[]): Promise<void> {
  for (const page of pages) await pageRepo.update(page.id, { ocrStatus: 'failed' })
}

/**
 * Recognises every eligible page in the window and returns its blocks.
 * Reads and writes `PageRecord.ocrStatus` as it goes; pages that fail stay
 * behind with `failed` (and a log event) instead of failing the window.
 */
export async function runWindowOcr(options: WindowOcrOptions): Promise<Map<number, OcrPageResult>> {
  const results = new Map<number, OcrPageResult>()
  if (!(await isOcrEnabled(options.projectId))) return results

  const selected: PageRecord[] = []
  for (const index of options.pageIndexes) {
    const record = await pageRepo.getByIndex(options.projectId, index)
    if (record && pageNeedsOcr(record)) selected.push(record)
  }
  if (selected.length === 0) return results

  if (!isOcrLanguageSupported(options.sourceLang)) {
    const newlyFailed = selected.filter((page) => page.ocrStatus !== 'failed')
    await markFailed(selected)
    if (newlyFailed.length > 0) {
      logEvent({
        state: 'PARSING',
        action: 'parse.ocr.unsupported-language',
        severity: 'warning',
        messageMy: `OCR ဘာသာစကား ဒေတာ မရနိုင်ပါ (စာမျက်နှာ ${newlyFailed.length} ခု)`,
        messageEn: `No OCR language data for "${options.sourceLang}" (${newlyFailed.length} pages)`,
        technicalDetail: `tesseractCodeFor('${options.sourceLang}') → null`,
        projectId: options.projectId,
      })
    }
    return results
  }

  for (const page of selected) await pageRepo.update(page.id, { ocrStatus: 'queued' })
  logEvent({
    state: 'PARSING',
    action: 'parse.ocr.start',
    severity: 'info',
    messageMy: `OCR စတင်သည် (စာမျက်နှာ ${selected.length} ခု)`,
    messageEn: `OCR started (${selected.length} pages)`,
    technicalDetail: `lang=${tesseractCodeFor(options.sourceLang) ?? '?'} scale=${OCR_RENDER_SCALE}`,
    projectId: options.projectId,
  })

  let succeeded = 0
  let confidenceSum = 0

  for (const page of selected) {
    if (options.signal?.aborted) throw new AnalysisCancelled()
    await pageRepo.update(page.id, { ocrStatus: 'running' })
    try {
      const size = renderedSize(page)
      const image = await analysisClient.render(
        options.fileId,
        page.index,
        OCR_RENDER_SCALE,
        'thumbnail',
        { signal: options.signal },
      )
      const lang = tesseractCodeFor(options.sourceLang) ?? options.sourceLang
      const recognition = await recognizeCached(`${options.fileId}#${page.index}#${lang}`, image, {
        langs: [options.sourceLang],
      })
      const content = ocrToBlocks(recognition.blocks, {
        pageIndex: page.index,
        pageWidth: size.width,
        pageHeight: size.height,
        scale: OCR_RENDER_SCALE,
        ctx: options.ctx,
        headerTexts: options.headerTexts,
        footerTexts: options.footerTexts,
        convertZawgyi: options.convertZawgyi,
      })
      await pageRepo.update(page.id, {
        ocrStatus: 'done',
        ocrConfidence: recognition.confidence,
      })
      results.set(page.index, {
        pageIndex: page.index,
        content,
        confidence: recognition.confidence,
      })
      succeeded += 1
      confidenceSum += recognition.confidence
    } catch (error) {
      if (error instanceof AnalysisCancelled) throw error
      const detail = error instanceof Error ? error.message : String(error)
      await pageRepo.update(page.id, { ocrStatus: 'failed', ocrConfidence: null })
      logEvent({
        state: 'PARSING',
        action: 'parse.ocr.page.failed',
        severity: 'error',
        messageMy: `OCR စာမျက်နှာ ${page.index + 1} ဖတ်၍ မရပါ`,
        messageEn: `OCR could not read page ${page.index + 1}`,
        technicalDetail: detail,
        projectId: options.projectId,
      })
    }
  }

  if (succeeded > 0) {
    logEvent({
      state: 'PARSING',
      action: 'parse.ocr.done',
      severity: succeeded === selected.length ? 'success' : 'warning',
      messageMy: `OCR ပြီးဆုံးပြီ (စာမျက်နှာ ${succeeded}/${selected.length} ခု)`,
      messageEn: `OCR finished (${succeeded}/${selected.length} pages)`,
      technicalDetail: `mean confidence ${(confidenceSum / succeeded).toFixed(1)}%`,
      projectId: options.projectId,
    })
  }
  return results
}
