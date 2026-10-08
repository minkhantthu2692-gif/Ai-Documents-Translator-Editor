/**
 * Translation queue (Phase 3).
 *
 * Mirrors `pdf/parseQueue.ts`: a `JobQueue` of translation batches with pause /
 * resume / cancel, persistence after every batch and a restore path that
 * rebuilds pending work from Dexie — so a refresh mid-job resumes exactly.
 *
 * Batches, not lines, are the unit of work:
 *
 *  - a batch id is *derived* (`project#epoch#page#index`), so re-running the
 *    same batch after a 429 targets exactly the same lines: no duplicates and
 *    nothing missing;
 *  - batches of one page run through a per-page mutex (terminology scope and
 *    per-page progress stay ordered) while different pages run in parallel up
 *    to the adaptive concurrency limit (2–3, AIMD);
 *  - results are written to Dexie the moment a batch settles, before the
 *    queue's own persistence callback runs, so the block table — not the
 *    queue — is the source of truth for resume.
 *
 * The actual provider work happens in `translation.worker` (keys are opened
 * there and never reach this thread); this module owns planning, Dexie, the
 * progress store and the event log.
 */

import { readDeviceSecret } from '@/core/crypto'
import { logEvent } from '@/core/eventLogger'
import { vaultPassphrase } from '@/core/vault'
import { JobQueue, type QueueEvent, type QueuePhase, type QueueSnapshot } from '@/core/jobQueue'
import type { FsmState } from '@/core/fsm'
import type { ReasonCode } from '@/core/reasonCodes'
import { FALLBACK_CHAINS, modelSpec } from '@/config/models.config'
import { hashText } from '@/db/repo-common'
import { apiKeyRepo } from '@/db/repo-apiKeys'
import { blockRepo, pageRepo, translationRepo } from '@/db/repo-content'
import { glossaryRepo } from '@/db/repo-knowledge'
import { jobRepo } from '@/db/repo-jobs'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { usageRepo } from '@/db/repo-usage'
import type { ApiKeyRecord, BlockRecord, TranslationFlag } from '@/db/types'
import { useTranslateStore } from '@/stores/translateStore'
import { BATCH_DEFAULTS, buildBatches } from './batching'
import {
  createRollingGlossary,
  promoteLearnedTerms,
  rollingBudgetFor,
  type RollingGlossary,
} from './rollingGlossary'
import { computeBudget } from './budget'
import { AdaptiveLimiter, RateMeter } from './concurrency'
import {
  TranslationRunCancelled,
  TranslationRunError,
  translationRunner,
} from './translationClient'
import { estimateTokens, type PersistedKeyState } from './keyPool'
import type { RunnerHooks, TranslateRunner } from './protocol'
import { resetTokenScale } from './tokenEstimate'
import { lookupTranslation, storeTranslation } from './tm'
import { annotatedTerms } from './terminology'
import type {
  BatchLine,
  GlossarySpec,
  PromptContext,
  TranslateProgress,
  TranslateRunConfig,
  TranslatePhase,
  TranslationBatch,
} from './types'

/** How many batches (across pages) may be in flight at once. */
const MAX_CONCURRENCY = 3

const runKey = (projectId: string): string => `translate.run.${projectId}`
const configKey = (projectId: string): string => `translate.config.${projectId}`

export interface TranslateJob {
  id: string
  projectId: string
  pageIndex: number
  batch: TranslationBatch
  context: PromptContext | null
}

export interface TranslatePlan {
  jobs: TranslateJob[]
  /** Translatable lines in scope (including the ones already translated). */
  total: number
  alreadyDone: number
  /** Lines excluded by a skip rule, a lock or the image switch. */
  skipped: number
  pageTotals: Map<number, number>
  /** Lines already translated per page (resume keeps its position). */
  pageDone: Map<number, number>
  /**
   * `seenPage`/`seenDocument` rebuilt from what is already translated.
   *
   * A restore starts both sets empty, which would make a document-scope run
   * annotate a term for a second time and a page-scope run repeat a page's
   * first annotation. Seeding them here keeps the occurrence rules true across
   * restarts.
   */
  terminologySeed: { seenPage: Map<number, Set<string>>; seenDocument: Set<string> }
  /** Token ceiling for glossary entries learned during the run (Layer 6.4). */
  rollingGlossaryBudget: number
}

export interface StartOutcome {
  total: number
  /** Batches that still have to run. */
  pending: number
  alreadyDone: number
  skipped: number
  sessionId: string
}

export interface ActiveRun {
  projectId: string
  sessionId: string
  config: TranslateRunConfig
  models: string[]
  limits: { rpm: number; tpm: number; rpd: number }
  keys: ApiKeyRecord[]
  glossary: GlossarySpec[]
  /**
   * Rolling-glossary state (Layer 6.4): a `source → target` pair the run has
   * produced consistently is promoted into `glossary` for the rest of the run,
   * so the last chunk is held to the wording the first chunks established.
   */
  rolling: RollingGlossary
  jobId: string
  epoch: number
  startedAt: number

  total: number
  alreadyDone: number
  done: number
  retries: number
  requests: number
  tokensIn: number
  tokensOut: number
  failedByBatch: Map<string, number>

  pageIndex: number | null
  pageTotals: Map<number, number>
  pageDone: Map<number, number>
  seenPage: Map<number, Set<string>>
  seenDocument: Set<string>

  meter: RateMeter
  limiter: AdaptiveLimiter
  activeKey: string | null
  model: string | null
  waitingUntil: number | null
  waitingReason: 'QUOTA_EXHAUSTED' | 'ALL_KEYS_COOLING_DOWN' | null
  failure: { reasonCode: ReasonCode; message: string } | null
  forcedPhase: TranslatePhase | null
}

/* ------------------------------------------------------------------ */
/* Runner seam (tests inject a fake that calls the engine directly)    */
/* ------------------------------------------------------------------ */

let runner: TranslateRunner = translationRunner

export function setTranslateRunner(next: TranslateRunner | null): void {
  runner = next ?? translationRunner
}

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

let queue: JobQueue<TranslateJob> | null = null
let active: ActiveRun | null = null
const pageLocks = new Map<number, Promise<void>>()

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

type BlockClass = 'skip' | 'done' | 'todo'

/** Decides what happens to one block in this run. */
export function classifyBlock(block: BlockRecord): BlockClass {
  if (block.skipRule !== null) return 'skip'
  if (block.status === 'skipped') return 'skip'
  if (block.status === 'locked') return 'skip'
  if (block.status === 'translated' || block.status === 'edited') return 'done'
  if (block.sourceText.trim().length === 0) return 'skip'
  return 'todo'
}

function toLine(block: BlockRecord): BatchLine {
  return {
    id: block.id,
    text: block.sourceText,
    pageIndex: 0,
    order: block.order,
    listMarker: block.listMarker,
    kind: block.kind,
    placeholders: block.placeholders,
  }
}

function textOf(line: BatchLine | undefined): string {
  return line ? line.text : ''
}

/** The nearest heading above a line — the section its batch belongs to. */
interface SectionRef {
  source: string
  /** Empty until the heading itself has been translated. */
  translated: string
}

/**
 * Builds every batch of a project in reading order. Pages are independent, so
 * batches are interleaved across pages: with concurrency 3 three different
 * pages progress together while each page's own batches stay ordered.
 */
export async function buildTranslatePlan(
  projectId: string,
  config: TranslateRunConfig,
  epoch: number,
  glossary?: GlossarySpec[],
): Promise<TranslatePlan> {
  // Assistant / settings can lower the batch size (rate limits, quota) — the
  // value lives in `translate.batchMaxLines` and is clamped to a sane range.
  const storedMaxLines = await settingsRepo.get<number>(
    SETTING_KEYS.batchMaxLines,
    BATCH_DEFAULTS.maxLines,
  )
  const maxLines =
    typeof storedMaxLines === 'number' && Number.isFinite(storedMaxLines) && storedMaxLines >= 1
      ? Math.floor(storedMaxLines)
      : BATCH_DEFAULTS.maxLines

  // How much content one request may carry, taken from the *model* instead of
  // a flat constant. The narrowest window in the fallback chain wins, so a
  // batch can never outgrow a model that may end up serving it.
  const budget = computeBudget({
    provider: config.provider,
    models: modelChain(config),
    quality: config.quality,
    sourceLang: config.sourceLang,
    targetLang: config.targetLang,
    terminologyScope: config.terminologyScope,
    glossary: glossary ?? (await loadGlossary(projectId)),
  })

  const pages = (await pageRepo.listByProject(projectId)).sort((a, b) => a.index - b.index)
  const blocks = await blockRepo.listByProject(projectId)
  const byPage = new Map<string, BlockRecord[]>()
  for (const block of blocks) {
    let list = byPage.get(block.pageId)
    if (!list) {
      list = []
      byPage.set(block.pageId, list)
    }
    list.push(block)
  }

  let total = 0
  let alreadyDone = 0
  let skipped = 0
  const pageTotals = new Map<number, number>()
  const pageDone = new Map<number, number>()
  const perPage: TranslateJob[][] = []

  // Section titles carry across pages: a document whose first heading sits on
  // page 3 still means something on page 4.
  let carriedSection: SectionRef | null = null
  const seedPage = new Map<number, Set<string>>()
  const seedDocument = new Set<string>()

  for (const page of pages) {
    // Image-text translation off → OCR-derived pages are out of scope.
    if (!config.translateImages && !page.hasTextLayer) continue

    const pageBlocks = (byPage.get(page.id) ?? []).sort((a, b) => a.order - b.order)
    const lines: BatchLine[] = []
    /** The section above each line, so a batch inherits its first line's. */
    const sectionOf = new Map<string, SectionRef | null>()
    let doneOnPage = 0

    for (const block of pageBlocks) {
      const kind = classifyBlock(block)

      if (kind === 'skip') {
        skipped += 1
      } else if (kind === 'done') {
        doneOnPage += 1
      } else {
        const line = toLine(block)
        line.pageIndex = page.index
        lines.push(line)
        // A heading sits in the section above itself and opens a new one for
        // every line after it — record first, advance second.
        sectionOf.set(line.id, carriedSection)
      }

      // What the page already carries fixes the occurrence scope for everything
      // still to come. Skipped-but-translated lines count too: their annotation
      // is in the document. `todo` does not — it is about to be rewritten.
      if (kind !== 'todo' && config.terminologyScope !== 'every' && block.translatedText) {
        for (const key of annotatedTerms(block.translatedText, block.sourceText)) {
          seedDocument.add(key)
          let onPage = seedPage.get(page.index)
          if (!onPage) {
            onPage = new Set<string>()
            seedPage.set(page.index, onPage)
          }
          onPage.add(key)
        }
      }

      if (block.kind === 'heading' && block.sourceText.trim().length > 0) {
        carriedSection = {
          source: block.sourceText.trim(),
          translated: block.translatedText.trim(),
        }
      }
    }

    const onPageTotal = lines.length + doneOnPage
    if (onPageTotal === 0) continue
    total += onPageTotal
    alreadyDone += doneOnPage
    pageTotals.set(page.index, onPageTotal)
    pageDone.set(page.index, doneOnPage)

    const batches = buildBatches(projectId, epoch, page.index, lines, {
      maxLines,
      maxTokens: budget.fillTargetTokens,
    })
    const jobs: TranslateJob[] = batches.map((batch, position) => {
      const section = batch.lines.length > 0 ? sectionOf.get(batch.lines[0].id) : null
      const context: PromptContext = {
        before:
          position > 0
            ? textOf(batches[position - 1].lines[batches[position - 1].lines.length - 1])
            : '',
        after: position + 1 < batches.length ? textOf(batches[position + 1].lines[0]) : '',
      }
      if (section) {
        context.section = section.source
        if (section.translated) context.sectionTranslation = section.translated
      }
      return { id: batch.id, projectId, pageIndex: page.index, batch, context }
    })
    perPage.push(jobs)
  }

  return {
    jobs: interleave(perPage),
    total,
    alreadyDone,
    skipped,
    pageTotals,
    pageDone,
    terminologySeed: { seenPage: seedPage, seenDocument: seedDocument },
    rollingGlossaryBudget: rollingBudgetFor(budget.contentBudgetTokens),
  }
}

/** Round-robin across pages so the concurrency limit is actually used. */
function interleave(groups: TranslateJob[][]): TranslateJob[] {
  const out: TranslateJob[] = []
  let offset = 0
  let added = true
  while (added) {
    added = false
    for (const group of groups) {
      if (offset < group.length) {
        out.push(group[offset])
        added = true
      }
    }
    offset += 1
  }
  return out
}

export async function loadGlossary(projectId: string): Promise<GlossarySpec[]> {
  const [globalEntries, projectEntries] = await Promise.all([
    glossaryRepo.list(null),
    glossaryRepo.list(projectId),
  ])
  return [...globalEntries, ...projectEntries].map((entry) => ({
    sourceTerm: entry.sourceTerm,
    targetTerm: entry.targetTerm,
    caseSensitive: entry.caseSensitive,
  }))
}

/** Selected model first, then the user's fallback chain (or the default one). */
export function modelChain(config: TranslateRunConfig): string[] {
  const fallbacks =
    config.fallbackModels.length > 0 ? config.fallbackModels : FALLBACK_CHAINS[config.provider]
  const chain = [config.model, ...fallbacks.filter((model) => model !== config.model)]
  return chain
}

export function limitsFor(config: TranslateRunConfig): { rpm: number; tpm: number; rpd: number } {
  const spec = modelSpec(config.provider, config.model)
  return { rpm: spec?.rpm ?? 30, tpm: spec?.tpm ?? 100_000, rpd: spec?.rpd ?? 1_000 }
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

function ensureQueue(): JobQueue<TranslateJob> {
  if (queue) return queue
  const created = new JobQueue<TranslateJob>({
    concurrency: MAX_CONCURRENCY,
    run: (job, signal) => runJob(job, signal),
    persist: async (snapshot) => {
      const run = active
      if (!run) return
      await settingsRepo.set(runKey(run.projectId), snapshot, 'translate')
    },
  })
  created.subscribe(onQueueEvent)
  queue = created
  return created
}

const PHASE_MESSAGES: Record<
  QueuePhase,
  { my: string; en: string; severity: 'info' | 'warning' | 'error' | 'success' }
> = {
  idle: { my: 'စကားပြောင်းရန် အဆင်သင့်ဖြစ်နေသည်', en: 'Translation queue ready', severity: 'info' },
  running: { my: 'စကားပြောင်းဆဲဖြစ်သည်', en: 'Translation running', severity: 'info' },
  paused: { my: 'စကားပြောင်းခြင်း ရပ်ထားသည်', en: 'Translation paused', severity: 'warning' },
  done: { my: 'စကားပြောင်းပြီးဆုံးပါပြီ', en: 'Translation finished', severity: 'success' },
  failed: { my: 'စကားပြောင်းခြင်း မအောင်မြင်ပါ', en: 'Translation failed', severity: 'error' },
  cancelled: {
    my: 'စကားပြောင်းခြင်း ပယ်ဖျက်ထားသည်',
    en: 'Translation cancelled',
    severity: 'warning',
  },
}

function jobStateFor(phase: QueuePhase): FsmState {
  if (phase === 'done') return 'REVIEWING'
  if (phase === 'failed') return 'FAILED'
  if (phase === 'cancelled') return 'CANCELLED'
  if (phase === 'paused') return 'PAUSED'
  return 'TRANSLATING'
}

function onQueueEvent(event: QueueEvent<TranslateJob>): void {
  const run = active
  if (!run) return

  if (event.type === 'item-start') {
    run.pageIndex = event.item.pageIndex
    publish(run)
    return
  }

  if (event.type === 'item-error') {
    logEvent({
      state: 'TRANSLATING',
      action: 'translate.batch.failed',
      severity: 'error',
      reasonCode: run.failure?.reasonCode ?? null,
      messageMy: `အစုအပေါင်း ${event.item.batch.index + 1} (စာမျက်နှာ ${event.item.pageIndex + 1}) ပြောင်း၍ မရပါ`,
      messageEn: `Could not translate batch ${event.item.batch.index + 1} on page ${event.item.pageIndex + 1}`,
      technicalDetail: run.failure?.message ?? event.error,
      pageIndex: event.item.pageIndex,
      projectId: run.projectId,
    })
    return
  }

  if (event.type === 'item-done') {
    updateJob(run, event.snapshot)
    publish(run)
    return
  }

  if (event.type !== 'phase') return

  const message = PHASE_MESSAGES[event.phase]
  useTranslateStore.getState().setPhase(event.phase)
  publish(run)
  updateJob(run, event.snapshot)

  logEvent({
    state: jobStateFor(event.phase),
    action: `translate.${event.phase}`,
    severity: message.severity,
    reasonCode: run.failure?.reasonCode ?? null,
    messageMy: message.my,
    messageEn: message.en,
    technicalDetail: `${run.sessionId} · ${event.snapshot.completed}/${event.snapshot.total} batches · ${event.snapshot.pendingIds.length} pending`,
    projectId: run.projectId,
    jobId: run.jobId || null,
  })
}

function updateJob(run: ActiveRun, snapshot: QueueSnapshot): void {
  if (!run.jobId) return
  const percent = Math.round(((run.alreadyDone + run.done) / Math.max(1, run.total)) * 100)
  void jobRepo
    .update(run.jobId, {
      state: jobStateFor(snapshot.phase),
      progress: Math.min(100, percent),
      pageIndex: run.pageIndex,
      reasonCode: run.failure?.reasonCode ?? null,
      messageEn: run.failure?.message ?? '',
      messageMy: '',
    })
    .catch(() => undefined)
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

function withPageLock<T>(pageIndex: number, fn: () => Promise<T>): Promise<T> {
  const previous = pageLocks.get(pageIndex) ?? Promise.resolve()
  const result = previous.then(() => fn())
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  pageLocks.set(pageIndex, tail)
  void tail.then(() => {
    if (pageLocks.get(pageIndex) === tail) pageLocks.delete(pageIndex)
  })
  return result
}

async function runJob(job: TranslateJob, signal: AbortSignal): Promise<void> {
  const run = active
  if (!run) throw new TranslationRunCancelled('translation run stopped')
  if (signal.aborted) throw new TranslationRunCancelled()

  let release: (() => void) | null = null
  try {
    release = await run.limiter.acquire(signal)
    await withPageLock(job.pageIndex, () => executeBatch(job, run, signal))
  } catch (error) {
    // A cancelled batch is not a failure: the queue drops it silently.
    if (error instanceof TranslationRunCancelled || signal.aborted) throw error
    handleRunFailure(run, error)
    throw error
  } finally {
    release?.()
  }
}

function handleRunFailure(run: ActiveRun, error: unknown): void {
  const reasonCode: ReasonCode =
    error instanceof TranslationRunError ? error.reasonCode : 'NETWORK_OFFLINE'
  const message = error instanceof Error ? error.message : String(error)
  run.failure = { reasonCode, message }
  useTranslateStore.getState().setFailure({ reasonCode, message })
  publish(run)
  // Stop dispatching: retrying every remaining batch against dead keys would
  // only burn quota. The user fixes the problem, then "Fix & Resume" runs.
  queue?.pause()
  void queue?.flush()
}

interface PersistEntry {
  line: BatchLine
  text: string
  confidence: number
  flag: TranslationFlag | null
  provider: string
  model: string
}

async function persistLines(
  run: ActiveRun,
  entries: PersistEntry[],
  stats: { tokensIn: number; tokensOut: number },
): Promise<void> {
  if (entries.length === 0) return
  const now = Date.now()
  const config = run.config
  let characters = 0

  for (const entry of entries) {
    const { line } = entry
    characters += entry.text.length + line.text.length
    await blockRepo.update(line.id, {
      translatedText: entry.text,
      status: 'translated',
      translationConfidence: entry.confidence,
      translationFlag: entry.flag,
      translatedAt: now,
    })

    const sourceHash = hashText(`${config.sourceLang}|${config.targetLang}|${line.text}`)
    const existing = await translationRepo.findByBlock(config.projectId, line.id)
    await translationRepo.upsert({
      ...(existing ? { id: existing.id } : {}),
      projectId: config.projectId,
      blockId: line.id,
      sourceText: line.text,
      translatedText: entry.text,
      sourceHash,
      sourceLang: config.sourceLang,
      targetLang: config.targetLang,
      provider: entry.provider,
      model: entry.model,
      characters: entry.text.length,
      tokens: estimateTokens(line.text),
      status: 'done',
      reasonCode: null,
    })

    // TM + cache are best-effort; a full quota must not fail the batch.
    await storeTranslation({
      sourceText: line.text,
      targetText: entry.text,
      sourceLang: config.sourceLang,
      targetLang: config.targetLang,
      quality: config.quality,
      model: entry.model,
      provider: entry.provider,
      confidence: entry.confidence,
    })
  }

  promoteLearnedTerms(
    run.rolling,
    run.glossary,
    entries.map((entry) => ({
      text: entry.text,
      sourceText: entry.line.text,
      confidence: entry.confidence,
    })),
  )

  await usageRepo.record({
    provider: config.provider,
    model: entries[0].model,
    characters,
    tokensIn: stats.tokensIn,
    tokensOut: stats.tokensOut,
    ok: true,
  })
}

function recordProgress(run: ActiveRun, pageIndex: number, count: number): void {
  run.done += count
  run.pageDone.set(pageIndex, (run.pageDone.get(pageIndex) ?? 0) + count)
  run.pageIndex = pageIndex
  publish(run, {
    pageIndex,
    pageDone: run.pageDone.get(pageIndex) ?? 0,
    pageTotal: run.pageTotals.get(pageIndex) ?? 0,
  })
}

async function executeBatch(job: TranslateJob, run: ActiveRun, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new TranslationRunCancelled()
  const pageIndex = job.batch.pageIndex
  run.pageIndex = pageIndex
  publish(run, {
    pageIndex,
    pageDone: run.pageDone.get(pageIndex) ?? 0,
    pageTotal: run.pageTotals.get(pageIndex) ?? 0,
  })

  /* 1. Cache / translation memory: a hit never reaches the provider. */
  const hits: Array<{ line: BatchLine; text: string }> = []
  const misses: BatchLine[] = []
  for (const line of job.batch.lines) {
    const cached = await lookupTranslation({
      sourceText: line.text,
      sourceLang: run.config.sourceLang,
      targetLang: run.config.targetLang,
      quality: run.config.quality,
      model: run.models[0],
    })
    if (cached) hits.push({ line, text: cached.text })
    else misses.push(line)
  }

  if (hits.length > 0) {
    await persistLines(
      run,
      hits.map((hit) => ({
        line: hit.line,
        text: hit.text,
        confidence: 1,
        flag: null,
        provider: run.config.provider,
        model: run.models[0],
      })),
      { tokensIn: 0, tokensOut: 0 },
    )
    recordProgress(run, pageIndex, hits.length)
  }

  if (misses.length === 0) return

  const batch: TranslationBatch =
    misses.length === job.batch.lines.length
      ? job.batch
      : { ...job.batch, id: `${job.batch.id}#cache`, lines: misses }

  const hooks: RunnerHooks = {
    onTick: (tick) => {
      run.requests += tick.requests
      run.tokensIn += tick.tokensIn
      run.tokensOut += tick.tokensOut
      run.meter.mark()
      run.activeKey = tick.maskedKey
      run.model = tick.model
      publish(run)
    },
    onWaiting: (wait) => {
      run.waitingUntil = wait.until
      run.waitingReason = wait.reason
      publish(run)
      logEvent({
        state: 'WAITING_RATE_LIMIT',
        action: 'translate.waiting',
        severity: 'warning',
        reasonCode: wait.reason,
        messageMy: `အချိန်အကန့်အသတ်ကြောင့် ${new Date(wait.until).toLocaleTimeString()} အထိ စောင်းငံ့နေသည်`,
        messageEn: `Rate limited — waiting until ${new Date(wait.until).toLocaleTimeString()}`,
        technicalDetail: wait.reason,
        pageIndex,
        projectId: run.projectId,
        jobId: run.jobId || null,
      })
    },
    onResumed: () => {
      run.waitingUntil = null
      run.waitingReason = null
      publish(run)
      logEvent({
        state: 'TRANSLATING',
        action: 'translate.resumed',
        severity: 'info',
        messageMy: 'စကားပြောင်းခြင်း ပြန်စတင်ပါပြီ',
        messageEn: 'Translation resumed after rate-limit wait',
        pageIndex,
        projectId: run.projectId,
        jobId: run.jobId || null,
      })
    },
    onStates: (states) => {
      void persistKeyStates(states)
    },
  }

  const outcome = await runner.run(
    {
      id: job.id,
      sessionId: run.sessionId,
      config: run.config,
      models: run.models,
      limits: run.limits,
      keys: run.keys,
      batch,
      glossary: run.glossary,
      context: job.context,
      seenPage: [...(run.seenPage.get(pageIndex) ?? [])],
      seenDocument: run.config.terminologyScope === 'document' ? [...run.seenDocument] : [],
    },
    hooks,
  )

  /* 2. Persist — Dexie is the source of truth for resume. */
  const byId = new Map(job.batch.lines.map((line) => [line.id, line] as const))
  const entries: PersistEntry[] = []
  for (const resultLine of outcome.result.lines) {
    const source = byId.get(resultLine.id)
    if (!source) continue
    entries.push({
      line: source,
      text: resultLine.text,
      confidence: resultLine.confidence,
      flag: resultLine.flag,
      provider: run.config.provider,
      model: outcome.result.model || run.models[0],
    })
  }

  await persistLines(run, entries, {
    tokensIn: outcome.result.tokensIn,
    tokensOut: outcome.result.tokensOut,
  })

  /* 3. Terminology scope survives to the next batch of this page. */
  for (const term of outcome.seenPage) {
    const seen = run.seenPage.get(pageIndex) ?? new Set<string>()
    seen.add(term)
    run.seenPage.set(pageIndex, seen)
  }
  if (run.config.terminologyScope === 'document') {
    for (const term of outcome.seenDocument) run.seenDocument.add(term)
  }

  run.retries += Math.max(0, outcome.result.requests - 1)
  if (outcome.result.model) run.model = outcome.result.model
  await persistKeyStates(outcome.states)
  recordProgress(run, pageIndex, entries.length)

  if (entries.length !== batch.lines.length) {
    // The engine always returns a line per input; if it ever did not, the
    // missing ones stay `pending` and are retried by the next run.
    logEvent({
      state: 'TRANSLATING',
      action: 'translate.batch.short',
      severity: 'warning',
      messageMy: 'အချို့စာကြောင်းများ ပြန်လည်ရယူရန် လိုအပ်သည်',
      messageEn: `${batch.lines.length - entries.length} lines were not returned and stay pending`,
      technicalDetail: `batch ${job.id} → ${entries.length}/${batch.lines.length}`,
      pageIndex,
      projectId: run.projectId,
    })
  }
}

export async function persistKeyStates(states: PersistedKeyState[]): Promise<void> {
  if (states.length === 0) return
  useTranslateStore.getState().setKeyStates(states)
  try {
    for (const state of states) await apiKeyRepo.applyPoolState(state)
  } catch (error) {
    console.warn('[translate] could not persist key state', error)
  }
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

function phaseOf(run: ActiveRun): TranslatePhase {
  if (run.failure) return 'failed'
  if (run.waitingUntil !== null && run.waitingUntil > Date.now()) return 'waiting'
  const phase: QueuePhase = queue?.phase ?? 'idle'
  if (phase === 'running') return 'running'
  if (phase === 'paused') return 'paused'
  if (phase === 'done') return 'done'
  if (phase === 'failed') return 'failed'
  if (phase === 'cancelled') return 'cancelled'
  return run.forcedPhase ?? 'idle'
}

function failedLines(run: ActiveRun): number {
  const snapshot = queue?.snapshot()
  if (!snapshot || snapshot.failedIds.length === 0) return 0
  let sum = 0
  for (const id of snapshot.failedIds) sum += run.failedByBatch.get(id) ?? 0
  return sum
}

function publish(run: ActiveRun, patch: Partial<TranslateProgress> = {}): void {
  if (run !== active) return
  const now = Date.now()
  const completed = run.alreadyDone + run.done
  const remaining = Math.max(0, run.total - completed)
  const elapsed = Math.max(1, now - run.startedAt)
  const etaMs = run.done > 0 ? Math.round((elapsed / run.done) * remaining) : null
  const pageIndex = run.pageIndex

  useTranslateStore.getState().setProgress({
    phase: phaseOf(run),
    alreadyDone: run.alreadyDone,
    done: run.done,
    total: run.total,
    failed: failedLines(run),
    pageIndex,
    pageDone: pageIndex !== null ? (run.pageDone.get(pageIndex) ?? 0) : 0,
    pageTotal: pageIndex !== null ? (run.pageTotals.get(pageIndex) ?? 0) : 0,
    requests: run.requests,
    retries: run.retries,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    requestsPerMinute: run.meter.perMinute(),
    activeKey: run.activeKey,
    model: run.model,
    waitingUntil: run.waitingUntil,
    waitingReason: run.waitingReason,
    etaMs,
    startedAt: run.startedAt,
    ...patch,
  })
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

function stopCurrentRun(): void {
  if (active) active = null
  runner.cancelAll()
  if (queue) {
    queue.reset()
    queue = null
  }
  pageLocks.clear()
}

export async function startTranslate(
  projectId: string,
  config: TranslateRunConfig,
  options: { autoStart?: boolean; forcedPhase?: TranslatePhase | null } = {},
): Promise<StartOutcome> {
  const keys = (await apiKeyRepo.listRowsByProvider(config.provider)).filter(
    (row) => row.enabled !== false,
  )
  if (keys.length === 0) {
    throw new TranslationRunError(
      'NO_API_KEY',
      `No enabled API key for provider "${config.provider}"`,
    )
  }

  stopCurrentRun()

  const epoch = Date.now()
  // A fresh run starts from the static script weights; the provider's reported
  // usage re-calibrates them within the first few requests.
  resetTokenScale()
  const glossary = await loadGlossary(projectId)
  const plan = await buildTranslatePlan(projectId, config, epoch, glossary)
  const models = modelChain(config)
  const limits = limitsFor(config)
  const sessionId = `${projectId}#${epoch}`

  const run: ActiveRun = {
    projectId,
    sessionId,
    config,
    models,
    limits,
    keys,
    glossary,
    rolling: createRollingGlossary(glossary, plan.rollingGlossaryBudget),
    jobId: '',
    epoch,
    startedAt: Date.now(),
    total: plan.total,
    alreadyDone: plan.alreadyDone,
    done: 0,
    retries: 0,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    failedByBatch: new Map(plan.jobs.map((job) => [job.id, job.batch.lines.length])),
    pageIndex: null,
    pageTotals: plan.pageTotals,
    pageDone: new Map(plan.pageDone),
    seenPage: plan.terminologySeed.seenPage,
    seenDocument: plan.terminologySeed.seenDocument,
    meter: new RateMeter(),
    limiter: new AdaptiveLimiter(),
    activeKey: null,
    model: config.model,
    waitingUntil: null,
    waitingReason: null,
    failure: null,
    forcedPhase: options.forcedPhase ?? null,
  }
  active = run

  await settingsRepo.set(configKey(projectId), config, 'translate')

  const store = useTranslateStore.getState()
  store.begin(projectId, plan.total, plan.alreadyDone)
  store.clearFailure()
  publish(run)

  try {
    await runner.open({
      sessionId,
      config,
      models,
      limits,
      keys,
      passphrase: vaultPassphrase(),
      deviceSecret: readDeviceSecret(),
    })
  } catch (error) {
    active = null
    const reasonCode: ReasonCode =
      error instanceof TranslationRunError ? error.reasonCode : 'NETWORK_OFFLINE'
    store.setFailure({
      reasonCode,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  const job = await jobRepo.create({
    type: 'translate',
    projectId,
    state: 'TRANSLATING',
    messageEn: 'Translation queued',
    messageMy: 'စကားပြောင်းရန် စောင်းငံ့ထားသည်',
  })
  run.jobId = job.id

  const created = ensureQueue()
  created.enqueue(plan.jobs)

  if (plan.jobs.length === 0) {
    // Nothing left to translate: everything in scope is already done.
    useTranslateStore.getState().setPhase('done')
    publish(run, { phase: 'done' })
    void jobRepo
      .update(job.id, { state: 'REVIEWING', progress: 100, finishedAt: Date.now() })
      .catch(() => undefined)
  } else if (options.autoStart !== false) {
    created.start()
    publish(run)
  }

  return {
    total: plan.total,
    pending: plan.jobs.length,
    alreadyDone: plan.alreadyDone,
    skipped: plan.skipped,
    sessionId,
  }
}

/**
 * Rebuilds a run after a reload. Dexie — not the queue snapshot — decides what
 * is still pending: every finished batch already wrote its blocks, so lines
 * translated before the refresh are excluded automatically (idempotent resume).
 */
export async function restoreTranslate(projectId: string, resume = true): Promise<number> {
  // A live run for this project survives plain navigation: rebuilding would
  // abort in-flight batches and re-plan work Dexie already owns. Only runs that
  // stopped (paused / failed / cancelled) or a cold start need a rebuild.
  if (
    active &&
    active.projectId === projectId &&
    active.failure === null &&
    queue?.phase === 'running'
  ) {
    return 0
  }

  const config = await settingsRepo.get<TranslateRunConfig | null>(configKey(projectId), null)
  if (!config) return 0
  const snapshot = await settingsRepo.get<QueueSnapshot | null>(runKey(projectId), null)
  if (!snapshot || snapshot.phase === 'cancelled' || snapshot.phase === 'done') return 0

  try {
    const outcome = await startTranslate(projectId, config, {
      autoStart: resume && snapshot.phase === 'running',
      forcedPhase: snapshot.phase === 'paused' ? 'paused' : null,
    })
    return outcome.pending
  } catch (error) {
    if (error instanceof TranslationRunError) {
      const store = useTranslateStore.getState()
      store.setFailure({ reasonCode: error.reasonCode, message: error.message })
      return 0
    }
    throw error
  }
}

export function pauseTranslate(): void {
  if (!queue || !active) return
  queue.pause()
  void queue.flush()
}

export function resumeTranslate(): void {
  if (!queue || !active) return
  active.failure = null
  active.forcedPhase = null
  useTranslateStore.getState().clearFailure()
  if (queue.snapshot().failedIds.length > 0) queue.retryFailed()
  if (queue.phase === 'paused') queue.resume()
  else if (queue.phase === 'idle' || queue.phase === 'failed' || queue.phase === 'done')
    queue.start()
  void queue.flush()
}

/** Re-runs only the batches that failed (keeps everything already done). */
export function retryFailedTranslate(): void {
  resumeTranslate()
}

export function cancelTranslate(): void {
  if (!queue || !active) return
  runner.cancelAll()
  queue.cancel()
  void queue.flush()
}

export function resetTranslateQueue(): void {
  stopCurrentRun()
  useTranslateStore.getState().reset()
}

export function subscribeTranslate(
  listener: (event: QueueEvent<TranslateJob>) => void,
): () => void {
  return ensureQueue().subscribe(listener)
}

export function translateSnapshot(): QueueSnapshot | null {
  return queue ? queue.snapshot() : null
}

export function activeTranslateProjectId(): string | null {
  return active ? active.projectId : null
}

/** Test/inspection hook: the run state the queue is currently working on. */
export function activeTranslateRun(): ActiveRun | null {
  return active
}
