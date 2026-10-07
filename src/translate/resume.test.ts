/**
 * Resume acceptance tests (refresh / failure / cancel → continue without loss).
 *
 * Dexie, not the queue snapshot, decides what is still pending: every finished
 * batch writes its blocks, so `restoreTranslate` only re-plans the lines that
 * are still `pending`. A fake `TranslateRunner` records every batch it is asked
 * to serve, so the suite can prove the two halves of the guarantee:
 *
 *   nothing already translated is requested again, and
 *   no line is ever produced twice.
 *
 * fake-indexeddb + an injected runner: no worker, no network, no clock.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushEvents } from '@/core/eventLogger'
import { AppDatabase, setDb } from '@/db/db'
import { stampNew } from '@/db/repo-common'
import { blockRepo, pageRepo, translationRepo } from '@/db/repo-content'
import { settingsRepo } from '@/db/repo-settings'
import type { ApiKeyRecord, BlockRecord } from '@/db/types'
import { useTranslateStore } from '@/stores/translateStore'
import type {
  RunnerHooks,
  RunnerOutcome,
  RunnerRequest,
  RunnerSession,
  TranslateRunner,
} from './protocol'
import { TranslationRunCancelled, TranslationRunError } from './translationClient'
import {
  cancelTranslate,
  resetTranslateQueue,
  restoreTranslate,
  resumeTranslate,
  setTranslateRunner,
  startTranslate,
  translateSnapshot,
} from './translateQueue'
import type { TranslateRunConfig } from './types'

const PROJECT_ID = 'prj_resume'
const BLOCK_COUNT = 40

/** What the fake provider does the next time it is called. */
type Behavior = 'ok' | 'fail' | 'hang'

interface RecordedCall {
  /** `startTranslate` session the batch belonged to (1 = first run). */
  run: number
  batchIndex: number
  ids: string[]
}

interface FakeRunner {
  runner: TranslateRunner
  calls: RecordedCall[]
  /** Ids actually delivered (a failed or hung call produces nothing). */
  produced: string[]
  plan: Behavior[]
}

function createFakeRunner(): FakeRunner {
  const calls: RecordedCall[] = []
  const produced: string[] = []
  const plan: Behavior[] = []
  const hung: Array<(error: Error) => void> = []
  let session = 0

  const runner: TranslateRunner = {
    async open(_session: RunnerSession) {
      session += 1
    },
    run(request: RunnerRequest, _hooks?: RunnerHooks): Promise<RunnerOutcome> {
      const behavior = plan.shift() ?? 'ok'
      const ids = request.batch.lines.map((line) => line.id)
      calls.push({ run: session, batchIndex: request.batch.index, ids })

      if (behavior === 'hang') {
        return new Promise<RunnerOutcome>((_resolve, reject) => {
          hung.push(reject)
        })
      }
      if (behavior === 'fail') {
        return Promise.reject(
          new TranslationRunError('BAD_JSON_RESPONSE', 'the model returned malformed JSON'),
        )
      }

      produced.push(...ids)
      return Promise.resolve({
        result: {
          batchId: request.batch.id,
          lines: request.batch.lines.map((line) => ({
            id: line.id,
            text: `translated:${line.text}`,
            confidence: 0.95,
            flag: null,
          })),
          requests: 1,
          tokensIn: 30,
          tokensOut: 24,
          keyId: 'key-1',
          model: request.models[0] ?? request.config.model,
          latencyMs: 5,
        },
        states: [],
        seenPage: [],
        seenDocument: [],
      })
    },
    cancel(_id: string) {},
    cancelAll() {
      for (const reject of hung.splice(0)) {
        reject(new TranslationRunCancelled('translation run stopped'))
      }
    },
    close() {},
  }

  return { runner, calls, produced, plan }
}

const CONFIG: TranslateRunConfig = {
  projectId: PROJECT_ID,
  provider: 'openrouter',
  model: 'test-model',
  quality: 'medium',
  sourceLang: 'en',
  targetLang: 'my',
  translateImages: false,
  terminologyScope: 'first',
  fallbackModels: [],
  strategy: 'round-robin',
}

async function waitUntil(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function blocksByOrder(): Promise<BlockRecord[]> {
  const rows = await blockRepo.listByProject(PROJECT_ID)
  return rows.sort((a, b) => a.order - b.order)
}

async function seedProject(): Promise<BlockRecord[]> {
  const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0, hasTextLayer: true })
  for (let order = 0; order < BLOCK_COUNT; order += 1) {
    await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order,
      sourceText: `Source paragraph ${order} carrying a handful of words.`,
    })
  }
  return blocksByOrder()
}

describe('translate resume', () => {
  let db: AppDatabase
  let fake: FakeRunner

  beforeEach(async () => {
    db = new AppDatabase(`aidt-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    fake = createFakeRunner()
    setTranslateRunner(fake.runner)
  })

  afterEach(async () => {
    resetTranslateQueue()
    setTranslateRunner(null)
    // Let the queue's persist chain and the event log drain before closing.
    await new Promise((resolve) => setTimeout(resolve, 25))
    await flushEvents()
    db.close()
  })

  it('keeps finished batches after a failure and resumes exactly the pending ones', async () => {
    const seeded = await seedProject()
    await db.apiKeys.add(
      stampNew<ApiKeyRecord>(
        {
          provider: 'openrouter',
          label: 'test key',
          cipher: 'not-a-real-cipher',
          lastFour: '4242',
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

    // Batch 0 (25 lines) succeeds, batch 1 (15 lines) fails.
    fake.plan.push('ok', 'fail')

    const outcome = await startTranslate(PROJECT_ID, CONFIG)
    expect(outcome.total).toBe(BLOCK_COUNT)
    expect(outcome.pending).toBe(2)
    expect(outcome.alreadyDone).toBe(0)

    await waitUntil(() => useTranslateStore.getState().failure !== null, 'the batch to fail')

    // The failed run parks the queue; the first batch is already on disk.
    expect(useTranslateStore.getState().failure?.reasonCode).toBe('BAD_JSON_RESPONSE')
    expect(translateSnapshot()?.phase).toBe('paused')

    const afterFailure = await blocksByOrder()
    expect(afterFailure.filter((row) => row.status === 'translated')).toHaveLength(25)
    expect(afterFailure.slice(0, 25).every((row) => row.status === 'translated')).toBe(true)
    expect(afterFailure.slice(25).every((row) => row.status === 'pending')).toBe(true)

    // Dexie decides what is pending: 15 lines → 1 batch.
    const pending = await restoreTranslate(PROJECT_ID)
    expect(pending).toBe(1)
    expect(useTranslateStore.getState().failure).toBeNull()

    resumeTranslate()
    await waitUntil(
      async () => (await blocksByOrder()).every((row) => row.status === 'translated'),
      'the resumed run to finish',
    )

    const final = await blocksByOrder()
    expect(final).toHaveLength(BLOCK_COUNT)
    for (const row of final) {
      expect(row.status).toBe('translated')
      expect(row.translatedText).toBe(`translated:${row.sourceText}`)
    }

    // The resumed run re-requested exactly the unfinished batch — same ids.
    expect(fake.calls).toHaveLength(3)
    expect(fake.calls[0].ids).toEqual(seeded.slice(0, 25).map((row) => row.id))
    expect(fake.calls[1].ids).toEqual(seeded.slice(25).map((row) => row.id))
    expect(fake.calls[2].ids).toEqual(seeded.slice(25).map((row) => row.id))
    expect(fake.calls.map((call) => call.run)).toEqual([1, 1, 2])

    // Every line was produced exactly once — no duplicates, nothing missing.
    const counts = new Map<string, number>()
    for (const id of fake.produced) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect(fake.produced).toHaveLength(BLOCK_COUNT)
    for (const row of seeded) expect(counts.get(row.id)).toBe(1)

    expect(await translationRepo.listByProject(PROJECT_ID)).toHaveLength(BLOCK_COUNT)
  })

  it('keeps translated data after a cancel and finishes the rest on restore', async () => {
    const seeded = await seedProject()
    await db.apiKeys.add(
      stampNew<ApiKeyRecord>(
        {
          provider: 'openrouter',
          label: 'test key',
          cipher: 'not-a-real-cipher',
          lastFour: '4242',
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

    // First batch lands, second one hangs until the run is cancelled.
    fake.plan.push('ok', 'hang')

    await startTranslate(PROJECT_ID, CONFIG)
    // Wait for the queue itself, not just Dexie: the snapshot that `restore`
    // reads is written when the batch settles, which is after the block writes.
    await waitUntil(async () => {
      const translated = (await blocksByOrder()).filter((row) => row.status === 'translated').length
      return translated === 25 && (translateSnapshot()?.completed ?? 0) === 1
    }, 'the first batch to persist')
    expect(translateSnapshot()?.phase).toBe('running')

    cancelTranslate()
    await waitUntil(() => translateSnapshot()?.phase === 'cancelled', 'the queue to cancel')

    // Cancelling must not undo anything: the finished batch stays on disk.
    const afterCancel = await blocksByOrder()
    expect(afterCancel.slice(0, 25).every((row) => row.status === 'translated')).toBe(true)
    expect(afterCancel.slice(25).every((row) => row.status === 'pending')).toBe(true)
    expect(useTranslateStore.getState().failure).toBeNull()

    const pending = await restoreTranslate(PROJECT_ID)
    expect(pending).toBe(1)
    resumeTranslate()

    await waitUntil(
      async () => (await blocksByOrder()).every((row) => row.status === 'translated'),
      'the restored run to finish',
    )

    const final = await blocksByOrder()
    expect(final).toHaveLength(BLOCK_COUNT)
    for (const row of final) expect(row.translatedText).toBe(`translated:${row.sourceText}`)

    // The hung call delivered nothing; its ids were delivered once by the restore.
    const counts = new Map<string, number>()
    for (const id of fake.produced) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect(fake.produced).toHaveLength(BLOCK_COUNT)
    for (const row of seeded) expect(counts.get(row.id)).toBe(1)
    expect(await translationRepo.listByProject(PROJECT_ID)).toHaveLength(BLOCK_COUNT)
  })

  it('restores nothing when no run was ever persisted', async () => {
    await seedProject()
    await settingsRepo.set(`translate.config.${PROJECT_ID}`, CONFIG, 'translate')

    expect(await restoreTranslate(PROJECT_ID)).toBe(0)
    expect(translateSnapshot()).toBeNull()
    expect(useTranslateStore.getState().failure).toBeNull()
  })

  it('leaves a live run alone when the page remounts', async () => {
    const seeded = await seedProject()
    await db.apiKeys.add(
      stampNew<ApiKeyRecord>(
        {
          provider: 'openrouter',
          label: 'test key',
          cipher: 'not-a-real-cipher',
          lastFour: '4242',
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

    await startTranslate(PROJECT_ID, CONFIG)
    expect(translateSnapshot()?.phase).toBe('running')
    await waitUntil(() => fake.calls.length > 0, 'the first batch to start')

    // Coming back to the page mid-run must not abort in-flight batches: the
    // same session keeps serving, nothing is re-opened or re-planned.
    expect(await restoreTranslate(PROJECT_ID)).toBe(0)
    expect(translateSnapshot()?.phase).toBe('running')

    await waitUntil(
      async () => (await blocksByOrder()).every((row) => row.status === 'translated'),
      'the untouched run to finish',
    )
    expect(fake.calls.every((call) => call.run === 1)).toBe(true)

    // Re-entry changed nothing about delivery: each id exactly once.
    const counts = new Map<string, number>()
    for (const id of fake.produced) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect(fake.produced).toHaveLength(BLOCK_COUNT)
    for (const row of seeded) expect(counts.get(row.id)).toBe(1)
  })
})
