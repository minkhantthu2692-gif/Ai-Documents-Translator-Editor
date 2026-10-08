/**
 * Parse queue — layout extraction for a project, windowed through the generic
 * job queue so it inherits pause / resume / cancel, a concurrency limit and
 * persistence after every item.
 *
 * Extraction is lazy by design: a 300-page document is never parsed in one
 * go. Windows of `PAGE_WINDOW` pages are enqueued, run one at a time in the
 * analysis worker, and each finished window is written to Dexie immediately —
 * so a reload mid-parse keeps everything already done, and scrolling to page
 * 240 only ever asks for the window around it (`ensurePagesExtracted`).
 *
 * The same queue will drive translation in Phase 3.
 */

import { logEvent } from '@/core/eventLogger'
import type { Severity } from '@/core/reasonCodes'
import { JobQueue, type QueueEvent, type QueuePhase, type QueueSnapshot } from '@/core/jobQueue'
import { pageRepo } from '@/db/repo-content'
import { projectRepo } from '@/db/repo-projects'
import { settingsRepo } from '@/db/repo-settings'
import { AnalysisError, analysisClient } from './analysisClient'
import { isOcrEnabled, runWindowOcr } from './ocr/ocrPipeline'
import { mergeOcrBlocks } from './ocr/ocrStructure'
import {
  ensureProjectDocument,
  loadMargins,
  loadProjectAnalysis,
  persistExtractedPages,
} from './projectAnalysis'

/** Pages per job. Small enough to cancel quickly, big enough to amortise. */
export const PAGE_WINDOW = 12

export interface ParseJob {
  /** Stable per-window id, so re-enqueueing the same pages is a no-op. */
  id: string
  projectId: string
  pageIndexes: number[]
}

const parseKey = (projectId: string): string => `analysis.parse.${projectId}`

/**
 * Project whose snapshot the queue persists (last one started).
 */
let activeProjectId: string | null = null

/**
 * Window-id generation. The queue de-duplicates by job id, so a window that
 * was dropped by `cancel()` could never be asked for again. Bumping the epoch
 * whenever a run starts or is cancelled gives the next request fresh ids,
 * while keeping de-duplication intact *within* a run.
 */
let epoch = 0

async function runJob(job: ParseJob, signal: AbortSignal): Promise<void> {
  const { fileId, outcome } = await ensureProjectDocument(job.projectId)
  if (outcome.status !== 'opened') {
    throw new AnalysisError('PDF_ENCRYPTED', 'source document requires a password')
  }

  const [project, analysis, margins] = await Promise.all([
    projectRepo.get(job.projectId),
    loadProjectAnalysis(job.projectId),
    loadMargins(job.projectId),
  ])

  const ctx = {
    sourceLang: project?.sourceLang ?? 'en',
    targetLang: project?.targetLang ?? 'my',
  }
  const pages = await analysisClient.extract(fileId, job.pageIndexes, {
    ctx,
    headerTexts: margins.headers,
    footerTexts: margins.footers,
    convertZawgyi: analysis?.convertZawgyi ?? false,
    signal,
  })

  // Scanned / mixed pages get their image text recognised in the same window,
  // before persistence, so one write carries the full page content.
  const ocrResults = await runWindowOcr({
    projectId: job.projectId,
    fileId,
    pageIndexes: job.pageIndexes,
    sourceLang: ctx.sourceLang,
    ctx,
    headerTexts: margins.headers,
    footerTexts: margins.footers,
    convertZawgyi: analysis?.convertZawgyi ?? false,
    signal,
  })
  for (const page of pages) {
    const ocr = ocrResults.get(page.pageIndex)
    if (!ocr) continue
    page.blocks = mergeOcrBlocks(page.blocks, ocr.content.blocks)
    page.charCount += ocr.content.charCount
    page.lineCount += ocr.content.lineCount
  }

  await persistExtractedPages(job.projectId, pages)
}

const queue = new JobQueue<ParseJob>({
  // One window at a time: pdf.js runs on a single thread anyway, and serial
  // windows keep peak memory flat on 500+ page documents.
  concurrency: 1,
  run: runJob,
  persist: (snapshot, item) => {
    const projectId = item?.projectId ?? activeProjectId
    if (!projectId) return Promise.resolve()
    return settingsRepo.set(parseKey(projectId), snapshot, 'analysis').then(() => undefined)
  },
})

/**
 * Bilingual copy for every queue transition — written straight into the event
 * record so the Logs page can show it without re-running translations.
 */
const PHASE_MESSAGES: Record<QueuePhase, { my: string; en: string; severity: Severity }> = {
  idle: {
    my: 'စာမျက်နှာ ဖွဲ့စည်းပုံ ထုတ်ယူမှု မစတင်ရသေးပါ',
    en: 'Layout extraction has not started',
    severity: 'info',
  },
  running: {
    my: 'စာမျက်နှာ ဖွဲ့စည်းပုံ ထုတ်ယူနေသည်',
    en: 'Extracting page layout',
    severity: 'info',
  },
  paused: {
    my: 'စာမျက်နှာ ဖွဲ့စည်းပုံ ထုတ်ယူမှု ယာယီရပ်ထားသည်',
    en: 'Layout extraction paused',
    severity: 'warning',
  },
  cancelled: {
    my: 'စာမျက်နှာ ဖွဲ့စည်းပုံ ထုတ်ယူမှု ပယ်ဖျက်လိုက်သည်',
    en: 'Layout extraction cancelled',
    severity: 'warning',
  },
  done: {
    my: 'စာမျက်နှာ ဖွဲ့စည်းပုံ ထုတ်ယူမှု ပြီးဆုံးသည်',
    en: 'Page layout extraction finished',
    severity: 'success',
  },
  failed: {
    my: 'စာမျက်နှာ ဖွဲ့စည်းပုံ ထုတ်ယူမှု မအောင်မြင်ပါ',
    en: 'Page layout extraction failed',
    severity: 'error',
  },
}

const RESUMED_MESSAGES = {
  my: 'စာမျက်နှာ ဖွဲ့စည်းပုံ ထုတ်ယူမှု ပြန်လည်စတင်သည်',
  en: 'Layout extraction resumed',
}

/** Last phase seen, so `paused → running` reads as "resumed", not "started". */
let lastPhase: QueuePhase = 'idle'

/**
 * Emits the mandated state/transition events and keeps project counters
 * (blocks, characters, progress) in step with parsing.
 */
/** Projects touched by the current run — counters refreshed on every one. */
const touchedProjects = new Set<string>()

queue.subscribe((event: QueueEvent<ParseJob>) => {
  if (event.type === 'item-start') {
    touchedProjects.add(event.item.projectId)
    return
  }

  if (event.type === 'item-error') {
    const pages = event.item.pageIndexes
    const first = pages.length > 0 ? pages[0] + 1 : 0
    const last = pages.length > 0 ? pages[pages.length - 1] + 1 : 0
    logEvent({
      state: 'PARSING',
      action: 'parse.window.failed',
      severity: 'error',
      messageMy: `စာမျက်နှာ ${first} မှ ${last} အထိ ဖွဲ့စည်းပုံ ထုတ်ယူ၍ မရပါ`,
      messageEn: `Could not extract layout for pages ${first}–${last}`,
      technicalDetail: event.error,
      projectId: event.item.projectId,
    })
    return
  }

  if (event.type !== 'phase') return
  const phase = event.phase
  const message =
    phase === 'running' && lastPhase === 'paused' ? RESUMED_MESSAGES : PHASE_MESSAGES[phase]
  lastPhase = phase

  logEvent({
    state: 'PARSING',
    action: `parse.${phase}`,
    severity: PHASE_MESSAGES[phase].severity,
    messageMy: message.my,
    messageEn: message.en,
    technicalDetail: `${activeProjectId ?? 'no project'} · ${event.snapshot.completed}/${event.snapshot.total} windows · ${event.snapshot.pendingIds.length} pending`,
    projectId: activeProjectId,
  })

  if (phase === 'done' || phase === 'failed' || phase === 'cancelled') {
    for (const id of touchedProjects) {
      void projectRepo.refreshCounters(id).catch(() => undefined)
    }
    touchedProjects.clear()
  }
})

/* ------------------------------------------------------------------ */
/* Enqueuing                                                           */
/* ------------------------------------------------------------------ */

function windowJob(projectId: string, windowIndex: number, pageIndexes: number[]): ParseJob {
  return { id: `${projectId}#${epoch}#${windowIndex}`, projectId, pageIndexes }
}

/** Groups page indexes into aligned windows of `PAGE_WINDOW`. */
export function windowsFor(projectId: string, pageIndexes: number[]): ParseJob[] {
  const buckets = new Map<number, number[]>()
  for (const index of pageIndexes) {
    if (index < 0) continue
    const windowIndex = Math.floor(index / PAGE_WINDOW)
    const bucket = buckets.get(windowIndex)
    if (bucket) bucket.push(index)
    else buckets.set(windowIndex, [index])
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([windowIndex, pages]) => windowJob(projectId, windowIndex, pages))
}

function enqueueJobs(jobs: ParseJob[], respectPause = false): number {
  if (jobs.length === 0) return 0
  queue.enqueue(jobs)
  // A lazy backfill must not tear a user-initiated pause; an explicit Start
  // always (re)starts dispatching.
  if (respectPause && queue.snapshot().phase === 'paused') return jobs.length
  queue.start()
  return jobs.length
}

/**
 * Queues every page of a project (used right after Start) and starts the
 * queue. Returns the number of windows enqueued.
 *
 * Only resets when nothing is in flight: importing five PDFs in one batch
 * calls this five times, and flushing the queue on each call would leave four
 * of the five projects un-parsed. Window ids are project-scoped, so a second
 * project joining a live run cannot collide with the first.
 */
export function startParse(projectId: string, pageCount: number): number {
  activeProjectId = projectId
  const phase = queue.snapshot().phase
  if (phase !== 'running' && phase !== 'paused') {
    queue.reset()
    epoch += 1
  }
  const indexes = Array.from({ length: Math.max(0, pageCount) }, (_, index) => index)
  return enqueueJobs(windowsFor(projectId, indexes))
}

/**
 * Queues only what is still missing — no-op when everything is parsed, and
 * idempotent while running (window ids are stable, so an in-flight or already
 * parsed window is never queued twice). Optionally narrowed to a visible range
 * by the workspace. Respects a running pause: the windows pile up and are
 * dispatched when the user resumes.
 */
export async function ensurePagesExtracted(
  projectId: string,
  pageIndexes?: number[],
): Promise<number> {
  activeProjectId = projectId
  // OCR-pending pages are "unparsed" too while the user hasn't opted out —
  // that is what makes a reload mid-OCR (or after a network failure) resume.
  const targets =
    pageIndexes ??
    (
      await pageRepo.listUnparsed(projectId, {
        ocrPending: await isOcrEnabled(projectId),
      })
    ).map((page) => page.index)
  return enqueueJobs(windowsFor(projectId, targets), true)
}

/**
 * Rebuilds the queue after a reload. Dexie — not the snapshot — decides what
 * is left (`listUnparsed`), so a re-parse that finished window 1–4 before the
 * reload only asks for the rest. `resume: false` restores a run the user had
 * paused: the queue starts (it must be running to pause) and is parked again
 * immediately, leaving every pending window where it was.
 *
 * Returns the number of windows re-queued.
 */
export async function restoreParse(projectId: string, resume: boolean): Promise<number> {
  const enqueued = await ensurePagesExtracted(projectId)
  if (!resume && enqueued > 0) queue.pause()
  return enqueued
}

/** Clears the session-local bookkeeping (project switched, tests). */
export function resetParseQueue(): void {
  queue.reset()
  activeProjectId = null
}

/* ------------------------------------------------------------------ */
/* Controls used by the Status Panel / workspace                        */
/* ------------------------------------------------------------------ */

export function subscribeParse(listener: (event: QueueEvent<ParseJob>) => void): () => void {
  return queue.subscribe(listener)
}

export function parseSnapshot(): QueueSnapshot {
  return queue.snapshot()
}

export function pauseParse(): void {
  queue.pause()
}

export function resumeParse(): void {
  queue.resume()
}

export function cancelParse(): void {
  queue.cancel()
  // Dropped windows must be askable again on the next scroll.
  epoch += 1
}

export function retryParse(): void {
  queue.retryFailed()
  queue.start()
}

/** Snapshot persisted for `projectId` (read after a reload). */
export function loadParseSnapshot(projectId: string): Promise<QueueSnapshot | null> {
  return settingsRepo.get<QueueSnapshot | null>(parseKey(projectId), null)
}

/** Resolves when nothing is running and no windows are pending. */
export function waitForParseIdle(): Promise<void> {
  return queue.waitForIdle()
}
