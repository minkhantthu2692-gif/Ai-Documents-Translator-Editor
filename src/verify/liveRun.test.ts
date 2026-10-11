// @vitest-environment node
/**
 * Live verify sweep — the one suite that talks to real providers.
 *
 * Everything here is the production path driven end to end: pdf.js extracts
 * real pages (`extractPage`), Dexie stores them (`persistExtractedPages`),
 * the queue plans real batches (`buildTranslatePlan` inside `startTranslate`),
 * and a runner built on the *worker's own logic* (`runBatch` + `KeyPool` +
 * the provider adapter) sends them. Results travel back through the queue's
 * real persistence, and `verifyDocumentIntegrity` re-plans from Dexie to
 * prove nothing was lost or duplicated.
 *
 * The runner seam (`setTranslateRunner`) exists exactly for this: the queue
 * talks to it, so the harness replaces only the worker's postMessage
 * plumbing — which the worker's own unit tests already cover — with an
 * in-process runner. The two `?worker` client modules are mocked off so this
 * file never spawns a Worker thread (node environment, no DOM).
 *
 * Keys are read from the environment and never written anywhere:
 *
 *   VERIFY_LIVE=1        master switch — without it the whole suite skips,
 *                        so the offline gate (`vitest run`) never spends a
 *                        request or needs a secret.
 *   OR_KEY1 / OR_KEY2    OpenRouter key(s); at least OR_KEY1 runs the suite.
 *   GROQ_KEY1 / GROQ_KEY2  Groq key(s); at least GROQ_KEY1 runs the suite.
 *   VERIFY_PDF_1         path to the first real-world PDF (OpenRouter leg).
 *   VERIFY_PDF_2         path to the second real-world PDF (Groq leg).
 *
 * Both legs share one report printed to stdout and written to a temp file.
 */
import 'fake-indexeddb/auto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist'

// The harness drives its own runner and never spawns a Worker; stub the two
// worker-backed clients so their `?worker` imports never resolve here.
vi.mock('@/translate/translationClient', () => ({
  translationRunner: {
    open: async () => undefined,
    run: async () => {
      throw new Error('the live harness drives its own runner')
    },
    cancel: () => undefined,
    cancelAll: () => undefined,
    close: () => undefined,
  },
  TranslationRunError: class TranslationRunError extends Error {},
  TranslationRunCancelled: class TranslationRunCancelled extends Error {},
}))
vi.mock('@/pdf/analysisClient', () => ({
  analysisClient: {
    open: async () => {
      throw new Error('not used by the live harness')
    },
  },
  AnalysisError: class AnalysisError extends Error {},
}))

import { FALLBACK_CHAINS, type ProviderId } from '@/config/models.config'
import { createId } from '@/core/id'
import { flushEvents } from '@/core/eventLogger'
import { AppDatabase, setDb } from '@/db/db'
import { stampNew } from '@/db/repo-common'
import { blockRepo, pageRepo, translationRepo } from '@/db/repo-content'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type { ApiKeyRecord, BlockRecord } from '@/db/types'
import { getAdapter } from '@/providers'
import { extractPage, type ExtractedPage } from '@/pdf/pdfExtract'
import { persistExtractedPages } from '@/pdf/projectAnalysis'
import { validateResponse, validationDetail } from '@/translate/batchValidation'
import { verifyDocumentIntegrity } from '@/translate/integrity'
import { computeBudget, fallbackBudget, maxOutputFor } from '@/translate/budget'
import { systemPrompt, temperatureFor, userPrompt } from '@/translate/prompts'
import { defaultSleep, type BatchTransport } from '@/translate/executor'
import { runBatch } from '@/translate/engine'
import type {
  RunnerHooks,
  RunnerOutcome,
  RunnerRequest,
  RunnerSession,
  TranslateRunner,
} from '@/translate/protocol'
import { KeyPool } from '@/translate/keyPool'
import { reasonFor } from '@/translate/reasons'
import { TranslationRunError } from '@/translate/translationClient'
import { estimateTokens, resetTokenScale } from '@/translate/tokenEstimate'
import {
  resetTranslateQueue,
  setTranslateRunner,
  startTranslate,
  translateSnapshot,
} from '@/translate/translateQueue'
import type { TranslateRunConfig, TranslationBatch } from '@/translate/types'
import { useTranslateStore } from '@/stores/translateStore'

/* ------------------------------------------------------------------ */
/* Environment contract                                                */
/* ------------------------------------------------------------------ */

const verifyLive = process.env.VERIFY_LIVE === '1'
const orKeys = [process.env.OR_KEY1, process.env.OR_KEY2].filter(
  (secret): secret is string => typeof secret === 'string' && secret.length > 0,
)
const groqKeys = [process.env.GROQ_KEY1, process.env.GROQ_KEY2].filter(
  (secret): secret is string => typeof secret === 'string' && secret.length > 0,
)
const pdf1 = process.env.VERIFY_PDF_1 ?? ''
const pdf2 = process.env.VERIFY_PDF_2 ?? ''

const hasOpenRouter = verifyLive && orKeys.length > 0 && pdf1.length > 0
const hasGroq = verifyLive && groqKeys.length > 0 && pdf2.length > 0

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const report: string[] = []
const say = (line: string): void => {
  report.push(line)
}

function mask(secret: string): string {
  return `••••${secret.slice(-4)}`
}

/** The Myanmar syllabary — proof the model answered in the target script. */
const MYANMAR = /[\u1000-\u109F]/

const REPORT_PATH = join(tmpdir(), 'opencode', 'aidt-verify-live.md')

afterAll(() => {
  if (report.length === 0) return
  const text = report.join('\n')
  console.log(`\n${text}\n`)
  try {
    writeFileSync(REPORT_PATH, `${text}\n`, 'utf8')
    console.log(`[verify] full report written to ${REPORT_PATH}`)
  } catch (error) {
    console.warn('[verify] could not write the report file', error)
  }
})

/* ------------------------------------------------------------------ */
/* Live runner — the worker's logic, in process                        */
/* ------------------------------------------------------------------ */

interface BatchRecord {
  batchId: string
  pageIndex: number
  lines: number
  requests: number
  tokensIn: number
  tokensOut: number
  latencyMs: number
  keyId: string | null
  model: string
}

interface Telemetry {
  batches: BatchRecord[]
  retries: Array<{ keyId: string; kind: string; detail: string; model: string }>
  waits: Array<{ until: number; reason: string }>
  fallbacks: string[]
}

function emptyTelemetry(): Telemetry {
  return { batches: [], retries: [], waits: [], fallbacks: [] }
}

/**
 * `translation.worker`'s `handleOpen`/`handleRun` without the postMessage:
 * same key pool, same budget, same engine call, same terminology sets.
 * Secrets arrive straight from the environment — no sealing, because the
 * sealed-row path is browser plumbing with its own tests.
 */
function createLiveRunner(
  provider: ProviderId,
  secrets: string[],
  telemetry: Telemetry,
): TranslateRunner & { pool: () => KeyPool | null } {
  const adapter = getAdapter(provider)
  let pool: KeyPool | null = null

  return {
    pool: () => pool,
    async open(session: RunnerSession): Promise<void> {
      const fresh = new KeyPool({ strategy: session.config.strategy })
      fresh.configureLimits(session.limits)
      fresh.setKeys(
        secrets.map((secret, index) => ({
          id: `${provider}-key-${index + 1}`,
          provider,
          nickname: `live key ${index + 1}`,
          lastFour: secret.slice(-4),
          enabled: true,
          secret,
        })),
      )
      pool = fresh
      resetTokenScale()
    },
    async run(request: RunnerRequest, hooks?: RunnerHooks): Promise<RunnerOutcome> {
      const active = pool
      if (!active) throw new Error('live runner: session was never opened')

      const budget = computeBudget({
        provider,
        models: request.models,
        quality: request.config.quality,
        sourceLang: request.config.sourceLang,
        targetLang: request.config.targetLang,
        terminologyScope: request.config.terminologyScope,
        glossary: request.glossary,
      })

      const controller = new AbortController()
      const transport: BatchTransport = async (input) => {
        const result = await adapter.translate(
          input.lease.secret,
          { ...input.call, model: input.model },
          {
            signal: input.signal ?? controller.signal,
            baseUrl: request.config.baseUrl || undefined,
          },
        )
        hooks?.onTick?.({
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          model: input.model,
          keyId: input.lease.keyId,
          maskedKey: input.lease.masked,
          requests: 1,
        })
        return {
          text: result.text,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          rate: result.rate,
        }
      }

      const seenPage = new Set(request.seenPage)
      const seenDocument = new Set(request.seenDocument)
      let waiting = false

      try {
        const result = await runBatch(request.batch, {
          pool: active,
          models: request.models,
          transport,
          quality: request.config.quality,
          sourceLang: request.config.sourceLang,
          targetLang: request.config.targetLang,
          terminologyScope: request.config.terminologyScope,
          glossary: request.glossary,
          budget,
          calibrate: true,
          context: request.context,
          signal: controller.signal,
          sleep: defaultSleep,
          seenPage,
          seenDocument,
          hooks: {
            onRetry: (info) => {
              telemetry.retries.push(info)
            },
            onModelFallback: (model) => {
              telemetry.fallbacks.push(model)
            },
            onWaiting: (until, reason) => {
              waiting = true
              telemetry.waits.push({ until, reason })
            },
            onLease: () => {
              if (waiting) {
                waiting = false
                hooks?.onResumed?.()
              }
            },
          },
        })

        telemetry.batches.push({
          batchId: result.batchId,
          pageIndex: request.batch.pageIndex,
          lines: request.batch.lines.length,
          requests: result.requests,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          keyId: result.keyId,
          model: result.model,
        })

        return {
          result,
          states: active.persistedAll(),
          seenPage: [...seenPage],
          seenDocument: [...seenDocument],
        }
      } catch (error) {
        // The real worker client rejects with exactly this shape
        // (translationClient: `entry.reject(new TranslationRunError(...))`),
        // so the queue — and the report — see the production reason code.
        const { reasonCode, message } = reasonFor(error)
        throw new TranslationRunError(reasonCode, message)
      }
    },
    cancel: () => undefined,
    cancelAll: () => undefined,
    close: () => undefined,
  }
}

/* ------------------------------------------------------------------ */
/* One live suite per provider                                         */
/* ------------------------------------------------------------------ */

interface SuiteOptions {
  provider: ProviderId
  label: string
  projectId: string
  keys: string[]
  pdfPath: string
}

/** Book pages worth translating: candidates beyond the cover, 0-based. */
const CANDIDATE_PAGES = [1, 2, 3, 4, 5, 6, 7]
/** How many of the richest candidates actually run through the provider. */
const SAMPLE_SIZE = 3

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  label: string,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const failure = useTranslateStore.getState().failure
    if (failure) {
      throw new Error(`run failed before ${label}: ${failure.reasonCode} — ${failure.message}`)
    }
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function liveSuite(options: SuiteOptions): void {
  const { provider, label, projectId, keys, pdfPath } = options

  describe(label, () => {
    let db: AppDatabase
    let doc: PDFDocumentProxy | null = null
    let task: PDFDocumentLoadingTask | null = null
    let sample: ExtractedPage[] = []
    let selectedModel = ''
    let chainLive: string[] = []
    let liveModelCount = 0
    let planSummary = { total: 0, pending: 0, skipped: 0 }
    let wallMs = 0
    let runStartedMs = 0
    const telemetry = emptyTelemetry()

    /** Run diagnostics — printed on success *and* on failure/stall. */
    function emitRunTelemetry(runner: ReturnType<typeof createLiveRunner>): void {
      const requests = telemetry.batches.reduce((sum, batch) => sum + batch.requests, 0)
      const tokensIn = telemetry.batches.reduce((sum, batch) => sum + batch.tokensIn, 0)
      const tokensOut = telemetry.batches.reduce((sum, batch) => sum + batch.tokensOut, 0)
      const wall = wallMs > 0 ? wallMs : runStartedMs > 0 ? Date.now() - runStartedMs : 0
      say(
        `- run: ${telemetry.batches.length} batches · ${requests} requests · ` +
          `${tokensIn.toLocaleString('en-US')} tok in / ` +
          `${tokensOut.toLocaleString('en-US')} tok out · ${(wall / 1000).toFixed(0)} s wall`,
      )
      for (const batch of telemetry.batches) {
        say(
          `  · page ${batch.pageIndex + 1}: ${batch.lines} lines · ${batch.requests} req · ` +
            `${batch.latencyMs} ms · ${batch.model} · ${batch.keyId ?? '?'}`,
        )
      }
      for (const retry of telemetry.retries) {
        say(`- retry: ${retry.kind} on ${retry.keyId} (${retry.detail.slice(0, 140)})`)
      }
      for (const fallback of telemetry.fallbacks) {
        say(`- model fallback: ${fallback}`)
      }
      for (const wait of telemetry.waits) {
        const mark = Math.round((wait.until - (runStartedMs || Date.now())) / 1000)
        say(`- wait: ${wait.reason} until +${mark} s`)
      }
      for (const key of runner.pool()?.snapshot() ?? []) {
        say(
          `- pool ${key.masked}: ${key.health} · ${key.requests} req · ` +
            `rpm left ${key.rpmRemaining ?? '?'} · ${key.tokensIn}/${key.tokensOut} tok`,
        )
      }
    }

    const configFor = (model: string): TranslateRunConfig => ({
      projectId,
      provider,
      model,
      quality: 'medium',
      sourceLang: 'en',
      targetLang: 'my',
      translateImages: false,
      terminologyScope: 'first',
      // Empty ⇒ the app's default fallback chain for this provider.
      fallbackModels: [],
      strategy: 'round-robin',
    })

    beforeAll(async () => {
      say(`\n## ${label}`)
      say(`- keys: ${keys.map(mask).join(' · ')}`)
      say(`- PDF: ${pdfPath}`)

      db = new AppDatabase(`aidt-verify-${provider}-${Date.now()}`)
      setDb(db)
      await db.open()
      // The layout re-fit pass needs a canvas; node has none, and the layout
      // behaviour is covered by its own suite. Keep the run about translation.
      await settingsRepo.set(SETTING_KEYS.autoFit, false, 'translate')

      task = getDocument({
        data: new Uint8Array(readFileSync(pdfPath)),
        useSystemFonts: true,
        verbosity: 0,
      })
      doc = await task.promise
      say(`- document: ${doc.numPages} pages`)

      const candidates: ExtractedPage[] = []
      for (const index of CANDIDATE_PAGES) {
        if (index >= doc.numPages) break
        const page = await doc.getPage(index + 1)
        candidates.push(
          await extractPage(page, {
            pageIndex: index,
            ctx: { sourceLang: 'en', targetLang: 'my' },
            headerTexts: [],
            footerTexts: [],
          }),
        )
      }

      // The three richest prose pages — deterministic and content-heavy, so a
      // table of contents cannot eat the sample.
      sample = candidates
        .filter((page) => page.charCount > 0)
        .sort((a, b) => b.charCount - a.charCount)
        .slice(0, SAMPLE_SIZE)
        .sort((a, b) => a.pageIndex - b.pageIndex)
      expect(sample.length, 'the PDF yielded no extractable text pages').toBeGreaterThan(0)

      const kinds = new Map<string, number>()
      for (const page of sample) {
        for (const block of page.blocks) kinds.set(block.kind, (kinds.get(block.kind) ?? 0) + 1)
      }
      const kindSummary = [...kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${kind} ${count}`)
        .join(' · ')
      const chars = sample.reduce((sum, page) => sum + page.charCount, 0)
      say(
        `- sample: 1-based pages ${sample.map((page) => page.pageIndex + 1).join(', ')} · ` +
          `${chars.toLocaleString('en-US')} chars · ${kindSummary}`,
      )

      for (const page of sample) {
        await pageRepo.upsert({ projectId, index: page.pageIndex, hasTextLayer: true })
      }
      await persistExtractedPages(projectId, sample)
    }, 180_000)

    it('validates the keys and picks a live model from the app chain', async () => {
      const adapter = getAdapter(provider)
      const results = keys.map((secret, index) => ({
        index: index + 1,
        secret,
        result: null as Awaited<ReturnType<typeof adapter.testKey>> | null,
      }))
      for (const entry of results) {
        entry.result = await adapter.testKey(entry.secret)
      }
      for (const entry of results) {
        const outcome = entry.result
        if (!outcome) continue
        say(
          `- key ${mask(entry.secret)}: ${outcome.kind} ` +
            `(${outcome.latencyMs} ms, ${outcome.modelsAvailable ?? '?'} models visible)`,
        )
      }

      const working = results.filter((entry) => entry.result?.ok)
      expect(
        working.length,
        `every ${provider} key was rejected: ${results
          .map((entry) => `${mask(entry.secret)}=${entry.result?.kind ?? '?'}`)
          .join(', ')}`,
      ).toBeGreaterThan(0)

      const live = await adapter.listModels(working[0].secret)
      liveModelCount = live.length
      const liveIds = new Set(live.map((model) => model.id))
      const chain = FALLBACK_CHAINS[provider]
      chainLive = chain.filter((model) => liveIds.has(model))
      const freeLive = live.find((model) => model.free && model.usable)
      selectedModel = chainLive[0] ?? freeLive?.id ?? chain[0]
      const chosen = live.find((model) => model.id === selectedModel)
      say(
        `- discovery: ${liveModelCount} live models · chain live ${chainLive.length}/${chain.length}` +
          ` · selected ${selectedModel}` +
          (chosen
            ? ` (free=${chosen.free}, ctx=${chosen.contextWindow ?? '?'})`
            : ' (not in the live list — the executor will walk the chain)'),
      )

      expect(liveModelCount, `${provider} model discovery returned nothing`).toBeGreaterThan(0)
      expect(
        liveIds.has(selectedModel),
        `no model of the bundled chain is live on ${provider} (free pools rotate)`,
      ).toBe(true)

      // First-token probe: one tiny request through the real adapter, so a dead
      // key, a gated model or a provider outage fails here in seconds with the
      // provider's own words — not minutes into the queue run.
      const probe = await adapter
        .translate(working[0].secret, {
          model: selectedModel,
          system: 'You are a translator.',
          user: 'Reply with exactly: ok',
          temperature: 0,
          maxOutputTokens: 16,
        })
        .then((result) => `ok (${result.latencyMs} ms, ${result.tokensOut} tok out)`)
        .catch(
          (error: unknown) => `FAILED — ${error instanceof Error ? error.message : String(error)}`,
        )
      say(`- preflight: ${probe}`)
      expect(probe, `preflight translation through ${selectedModel} failed`).toMatch(/^ok/)

      // Protocol probe — the REAL contract: the engine's own system prompt,
      // numbered-line user prompt and strict validator, asked of the model at
      // two sizes (3 and 20 lines). A model that cannot honour the JSON/id
      // contract is what burns an entire retry ladder — and a free tier's daily
      // request quota — (61 successful responses, zero valid batches, on
      // OpenRouter, Oct 2026), so the verdict lands here, in seconds, before
      // the queue starts. The 20-line run doubles as a truncation check:
      // reasoning tokens share the completion cap. Informational either way.
      const probeSources = sample
        .flatMap((page) => page.blocks)
        .filter((block) => !block.skipRule && block.text.trim().length > 0)
      const probeBatch = (count: number): TranslationBatch => {
        const lines = Array.from({ length: count }, (_, index) => {
          const source = probeSources[index % Math.max(probeSources.length, 1)]
          return {
            id: createId('blk'),
            text: source?.text ?? 'Welcome to the handbook.',
            pageIndex: 0,
            order: index,
            listMarker: source?.listMarker ?? null,
            kind: source?.kind ?? 'paragraph',
            placeholders: source?.placeholders ?? [],
          }
        })
        return {
          id: 'live-protocol-probe',
          pageIndex: 0,
          index: 0,
          // Same estimate the planner makes, so `maxOutputFor` sizes the cap
          // exactly as it would for a real batch.
          tokens: estimateTokens(lines.map((line) => line.text).join('\n')),
          lines,
        }
      }
      const probeVerdict = async (batch: TranslationBatch): Promise<string> => {
        try {
          const result = await adapter.translate(working[0].secret, {
            model: selectedModel,
            system: systemPrompt({
              quality: 'medium',
              sourceLang: 'en',
              targetLang: 'my',
              glossary: [],
              terminologyScope: 'first',
            }),
            user: userPrompt(batch, null),
            temperature: temperatureFor('medium'),
            maxOutputTokens: maxOutputFor(
              fallbackBudget({
                quality: 'medium',
                sourceLang: 'en',
                targetLang: 'my',
                glossary: [],
                terminologyScope: 'first',
              }),
              batch,
            ),
            // Exactly what the engine sends for medium quality (engine.ts).
            reasoningEffort: 'low',
          })
          const verdict = validateResponse(result.text, batch)
          const script = MYANMAR.test(result.text) ? 'Burmese' : 'NO Burmese'
          return (
            `${validationDetail(verdict)} · ${result.tokensOut} tok out · ${script} · ` +
            JSON.stringify(result.text.slice(0, 260))
          )
        } catch (error: unknown) {
          return `FAILED — ${error instanceof Error ? error.message : String(error)}`
        }
      }
      say(`- protocol 3 lines: ${await probeVerdict(probeBatch(3))}`)
      say(`- protocol 20 lines: ${await probeVerdict(probeBatch(20))}`)
    }, 180_000)

    it('translates the extracted pages through the real queue', async () => {
      expect(selectedModel, 'model discovery did not run — fix the key step first').not.toBe('')

      for (const [index, secret] of keys.entries()) {
        await db.apiKeys.add(
          stampNew<ApiKeyRecord>(
            {
              id: `${provider}-key-${index + 1}`,
              provider,
              label: `live key ${index + 1}`,
              cipher: 'not-used-by-the-live-runner',
              lastFour: secret.slice(-4),
              status: 'unknown',
              statusDetail: '',
              lastCheckedAt: null,
              models: [],
              enabled: true,
              cooldownUntil: 0,
              cooldownReason: null,
              requests: 0,
              tokensIn: 0,
              tokensOut: 0,
              lastUsedAt: null,
              buckets: null,
            },
            'key',
          ),
        )
      }

      const runner = createLiveRunner(provider, keys, telemetry)
      setTranslateRunner(runner)

      runStartedMs = Date.now()
      try {
        const outcome = await startTranslate(projectId, configFor(selectedModel))
        planSummary = {
          total: outcome.total,
          pending: outcome.pending,
          skipped: outcome.skipped,
        }
        say(
          `- plan: ${planSummary.total} lines · ${outcome.pending} batches · ` +
            `${planSummary.skipped} lines skipped`,
        )
        expect(outcome.total, 'the plan found nothing translatable').toBeGreaterThan(0)
        expect(outcome.pending, 'every line was already translated').toBeGreaterThan(0)

        await waitUntil(
          () => {
            // A quota-parked key cannot return for hours (OpenRouter's free
            // tier allows 50 model requests per day). Fail fast with the
            // provider's own state instead of waiting out a deadline that
            // lands tomorrow.
            const poolState = runner.pool()?.snapshot() ?? []
            if (
              poolState.length > 0 &&
              poolState.every((key) => key.health === 'quota-exhausted' || key.health === 'invalid')
            ) {
              throw new Error(
                'no key can serve today — every key is quota-parked or rejected ' +
                  '(free-tier daily limits: OpenRouter 50 requests/key/day, ' +
                  'Groq 200K tokens/day — wait for the provider reset)',
              )
            }
            return translateSnapshot()?.phase === 'done'
          },
          'the translation queue to finish',
          1_080_000,
        )
        wallMs = Date.now() - runStartedMs
        expect(telemetry.batches.length, 'no batch reached the provider').toBeGreaterThan(0)
      } finally {
        // A stalled or failed run must still show what the providers actually
        // did — batches, retries, waits and per-key state are the diagnosis.
        emitRunTelemetry(runner)
      }
    }, 1_260_000)

    it('verifies merge integrity and the translated output', async () => {
      const finished = translateSnapshot()?.phase === 'done'
      const integrity = await verifyDocumentIntegrity(projectId, configFor(selectedModel))
      say(
        `- integrity: ${integrity.ok ? 'ok' : 'BROKEN'} · checked ${integrity.checked} · ` +
          `missing ${integrity.missing.length} · duplicated ${integrity.duplicated.length}` +
          (finished ? '' : ' · (run did not finish — completeness not required)'),
      )
      // A duplicate would be a merge defect on *any* run. "Missing" only ever
      // means "not translated yet" while the queue is short of done — a free
      // tier that ran out of quota mid-run must not be misread as a merge bug.
      expect(
        integrity.duplicated.length,
        `merge duplicated ${integrity.duplicated.length} line(s)`,
      ).toBe(0)
      if (finished) {
        expect(
          integrity.ok,
          `merge integrity broken: missing=${integrity.missing.length} duplicated=${integrity.duplicated.length}`,
        ).toBe(true)
      }

      const rows = await blockRepo.listByProject(projectId)
      const inScope = rows.filter(
        (block) =>
          block.skipRule === null &&
          block.status !== 'skipped' &&
          block.status !== 'locked' &&
          block.sourceText.trim().length > 0,
      )
      const isTranslated = (block: BlockRecord) =>
        block.status === 'translated' && block.translatedText.trim().length > 0
      const untranslated = inScope.filter((block) => !isTranslated(block))
      if (finished) {
        expect(
          untranslated.length,
          `${untranslated.length} in-scope blocks came back untranslated`,
        ).toBe(0)
      }
      const translated = inScope.filter(isTranslated)

      const withBurmese = translated.filter((block) => MYANMAR.test(block.translatedText))
      const ratio = translated.length > 0 ? withBurmese.length / translated.length : 0
      const flagged = translated.filter((block) => block.translationFlag !== null)
      const flagTally = new Map<string, number>()
      for (const block of flagged) {
        const flag = block.translationFlag ?? '?'
        flagTally.set(flag, (flagTally.get(flag) ?? 0) + 1)
      }
      say(
        `- output: ${translated.length}/${inScope.length} translated · ` +
          `Myanmar script in ${(ratio * 100).toFixed(0)}% of translations · ` +
          `flags: ${[...flagTally].map(([flag, count]) => `${flag} ×${count}`).join(' · ') || 'none'}`,
      )
      say(
        `- persistence: ${await translationRepo.listByProject(projectId).then((list) => list.length)} TM rows`,
      )

      // Nothing translated means nothing to judge (the run never landed a
      // batch); a *finished* run's translations must be in the target script.
      if (translated.length > 0) {
        expect(
          ratio,
          `only ${(ratio * 100).toFixed(0)}% of translations contain Myanmar script`,
        ).toBeGreaterThan(0.5)
      }

      // Two samples for a human to read: a heading, and the longest paragraph.
      const heading = translated.find((block) => block.kind === 'heading')
      const paragraph = translated.reduce<BlockRecord | null>((best, block) => {
        if (block.kind !== 'paragraph') return best
        return !best || block.sourceText.length > best.sourceText.length ? block : best
      }, null)
      for (const [kind, block] of [
        ['heading', heading],
        ['paragraph', paragraph],
      ] as const) {
        if (!block) continue
        say(`- ${kind} sample:`)
        say(`  EN: ${block.sourceText.slice(0, 180).replace(/\s+/g, ' ')}`)
        say(`  MY: ${block.translatedText.slice(0, 240).replace(/\s+/g, ' ')}`)
      }
    }, 120_000)

    afterAll(async () => {
      resetTranslateQueue()
      setTranslateRunner(null)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await flushEvents()
      if (task) await task.destroy().catch(() => undefined)
      db.close()
    })
  })
}

describe.runIf(hasOpenRouter)('live verify · OpenRouter × Vue Handbook', () =>
  liveSuite({
    provider: 'openrouter',
    label: 'live verify · OpenRouter × Vue Handbook',
    projectId: 'verify_live_openrouter',
    keys: orKeys,
    pdfPath: pdf1,
  }),
)

describe.runIf(hasGroq)('live verify · Groq × Learning React', () =>
  liveSuite({
    provider: 'groq',
    label: 'live verify · Groq × Learning React',
    projectId: 'verify_live_groq',
    keys: groqKeys,
    pdfPath: pdf2,
  }),
)
