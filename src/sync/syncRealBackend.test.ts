/**
 * The engine against the REAL backend.
 *
 * `sync.test.ts` proves the engine's behaviour against a hand-written twin of
 * Code.gs; `appsScriptBackend.test.ts` proves the backend's contract in
 * isolation. This suite closes the loop: records written by the repositories →
 * `SyncClient` → the shipped `apps-script/Code.gs` → the sheet → pull → Dexie
 * again. Drift between what the client sends and what the spreadsheet can
 * hold surfaces here as a lost field, which is exactly the failure mode
 * "everything syncs" has to rule out.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase, setDb } from '@/db/db'
import { resetDeviceIdCache } from '@/core/id'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { glossaryRepo } from '@/db/repo-knowledge'
import { outboxRepo } from '@/db/repo-outbox'
import { projectRepo } from '@/db/repo-projects'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type { PageRecord } from '@/db/types'
import { createBackend, expectOk, type AppsScriptBackend } from './appsScriptRuntime'
import { syncNow, testConnection, wipeCloud, type SyncStats } from './engine'
import { defaultEntityToggles, MAX_CHANGES_PER_PUSH, PULL_PAGE_SIZE } from './protocol'

const EXEC_URL = 'https://script.google.example/exec'
const TOKEN = 'e2e-suite-token'

let dbCounter = 0

function freshDb(): AppDatabase {
  dbCounter += 1
  return new AppDatabase(`aidt-real-backend-${Date.now()}-${dbCounter}`)
}

function activate(db: AppDatabase, tag: string): void {
  setDb(db)
  localStorage.setItem('aidt.deviceId', `dev_${tag}`.padEnd(11, '0'))
  resetDeviceIdCache()
}

async function configure(): Promise<void> {
  await settingsRepo.set(SETTING_KEYS.syncEnabled, true, 'sync')
  await settingsRepo.set(SETTING_KEYS.appsScriptUrl, EXEC_URL, 'sync')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Expires Code.gs's shared execution budget (`EXEC_BUDGET_MS_`, 285s) in the
 * middle of a request, so a push runs out of time the way a real Apps Script
 * run does — without waiting six minutes for one.
 *
 * The clock jumps on the first write to a *data* tab (SyncLog is ignored —
 * every request appends an audit row, including the capability probe that
 * runs before the push). A request that had already started when the jump
 * lands is over budget when it next probes, so it stops between two sheets
 * and answers `partial` + `nextCursor`; the *following* request starts its
 * own budget at the jumped time and runs normally. Returns the disarmed
 * state, which the caller must restore in a `finally`.
 */
function armBudgetExpiry(backend: AppsScriptBackend): () => void {
  const realNow = Date.now
  let jumped = false
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (jumped ? 400_000 : 0))
  backend.hooks.onSheetWrite = (sheet) => {
    if (sheet !== 'SyncLog') jumped = true
  }
  return () => {
    backend.hooks.onSheetWrite = undefined
    vi.restoreAllMocks()
  }
}

describe('sync engine against the shipped Code.gs', () => {
  let backend: AppsScriptBackend
  let dbA: AppDatabase
  let dbB: AppDatabase

  beforeEach(async () => {
    vi.stubEnv('VITE_APPS_SCRIPT_URL', EXEC_URL)
    vi.stubEnv('VITE_APPS_SCRIPT_TOKEN', TOKEN)
    backend = createBackend({ properties: { TOKEN } })
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const result = backend.post(body)
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    dbA = freshDb()
    dbB = freshDb()
    await dbA.open()
    await dbB.open()
    activate(dbA, 'AAA01')
    await configure()
  })

  afterEach(async () => {
    setDb(null)
    await dbA.close()
    await dbB.close()
    localStorage.removeItem('aidt.deviceId')
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('round-trips a whole document, field for field', async () => {
    const project = await projectRepo.create({
      name: 'React — လေ့လာရေး',
      sourceLang: 'en',
      targetLang: 'my',
      sourceFileName: 'book.pdf',
      sourceFileSize: 8_400_000,
    })
    const page = await pageRepo.upsert({
      projectId: project.id,
      index: 0,
      width: 612,
      height: 792,
      hasTextLayer: true,
      ocrStatus: 'done',
      renderStatus: 'rendered',
      textCharacterCount: 1200,
      contentClass: 'text',
    })
    const lines = [
      {
        id: 'ln_1',
        text: 'React is a JavaScript library',
        bbox: { x: 40, y: 120, w: 300, h: 14 },
        style: {
          fontSize: 11,
          bold: false,
          italic: false,
          color: '#111111',
          fontFamily: 'Noto Sans',
          rotation: 0,
        },
      },
    ]
    const block = await blockRepo.upsert({
      projectId: project.id,
      pageId: page.id,
      order: 0,
      kind: 'paragraph',
      sourceText: 'React is a JavaScript library for building user interfaces.',
      translatedText: 'React သည် UI များ တည်ဆောက်ရန် JavaScript စာကြည့်တိုက်ဖြစ်သည်။',
      status: 'translated',
      lines,
    })
    await glossaryRepo.create({
      sourceTerm: 'component',
      targetTerm: 'အစိတ်အပိုင်း',
      sourceLang: 'en',
      targetLang: 'my',
    })
    await settingsRepo.set(
      SETTING_KEYS.syncEntities,
      { ...defaultEntityToggles(), settings: true },
      'sync',
    )

    const pushed = await syncNow('manual')
    expect(pushed.pushed).toBeGreaterThanOrEqual(4)
    expect(pushed.applied).toBe(pushed.pushed)
    expect(pushed.deferred).toBe(0)
    expect(pushed.hasMore).toBe(false)

    // The spreadsheet holds the document in readable columns, not a blob.
    const row = backend.sheet('Blocks')!.rowById(block.id)!
    expect(row.kind).toBe('paragraph')
    expect(row.sourceText).toBe('React is a JavaScript library for building user interfaces.')
    expect(row.translatedText).toBe(block.translatedText)
    expect(row.status).toBe('translated')
    expect(row.projectId).toBe(project.id)
    const termRow = backend.sheet('Glossary')!.rowById((await dbA.glossary.toArray())[0].id)!
    expect(termRow.sourceTerm).toBe('component')
    expect(termRow.targetTerm).toBe('အစိတ်အပိုင်း')

    // Device B pulls the document back with every field intact.
    activate(dbB, 'BBB01')
    await configure()
    const pulled = await syncNow('manual')
    expect(pulled.pulled).toBeGreaterThanOrEqual(4)
    expect(pulled.hasMore).toBe(false)
    expect(pulled.deferred).toBe(0)

    const bProject = await dbB.projects.get(project.id)
    expect(bProject?.name).toBe('React — လေ့လာရေး')
    expect(bProject?.sourceFileName).toBe('book.pdf')
    expect(bProject?.sourceFileSize).toBe(8_400_000)
    expect(bProject?.pageCount).toBe(0)

    const bPages = await dbB.pages.where('projectId').equals(project.id).toArray()
    expect(bPages).toHaveLength(1)
    expect(bPages[0].width).toBe(612)
    expect(bPages[0].ocrStatus).toBe('done')

    const bBlock = await dbB.blocks.get(block.id)
    expect(bBlock?.kind).toBe('paragraph')
    expect(bBlock?.sourceText).toBe(block.sourceText)
    expect(bBlock?.translatedText).toBe(block.translatedText)
    expect(bBlock?.status).toBe('translated')
    expect(bBlock?.lines).toEqual(lines)

    const bGlossary = await dbB.glossary.toArray()
    expect(bGlossary).toHaveLength(1)
    expect(bGlossary[0].targetTerm).toBe('အစိတ်အပိုင်း')
    expect(bGlossary[0].projectId).toBeNull()

    // Device-local data never travels — and nothing is left half-sent.
    expect(await dbB.sourceFiles.count()).toBe(0)
    expect(backend.sheet('SourceFiles')).toBeUndefined()
  })

  it('propagates a project deletion to the other device', async () => {
    const project = await projectRepo.create({ name: 'Doomed', sourceLang: 'en', targetLang: 'my' })
    const page = await pageRepo.upsert({ projectId: project.id, index: 0 })
    await blockRepo.upsert({ projectId: project.id, pageId: page.id, order: 0 })
    await syncNow('manual')

    activate(dbB, 'BBB01')
    await configure()
    await syncNow('manual')
    expect(await dbB.blocks.count()).toBe(1)

    activate(dbA, 'AAA01')
    await projectRepo.remove(project.id)
    await syncNow('manual')

    activate(dbB, 'BBB01')
    await syncNow('manual')
    expect(await dbB.projects.get(project.id)).toBeUndefined()
    expect(await dbB.pages.count()).toBe(0)
    expect(await dbB.blocks.count()).toBe(0)
  })

  it('resolves a concurrent edit with last-write-wins and logs the loser', async () => {
    const project = await projectRepo.create({ name: 'Shared', sourceLang: 'en', targetLang: 'my' })
    const page = await pageRepo.upsert({ projectId: project.id, index: 0 })
    const block = await blockRepo.upsert({
      projectId: project.id,
      pageId: page.id,
      order: 0,
      sourceText: 'shared line',
    })
    await syncNow('manual')

    activate(dbB, 'BBB01')
    await configure()
    await syncNow('manual')

    // Both devices edit the same block; B's stamp is the later one.
    activate(dbA, 'AAA01')
    await blockRepo.update(block.id, { translatedText: 'edited on A' })
    await sleep(5)
    activate(dbB, 'BBB01')
    await blockRepo.update(block.id, { translatedText: 'edited on B' })
    await syncNow('manual')

    activate(dbA, 'AAA01')
    await syncNow('manual')
    expect((await dbA.blocks.get(block.id))?.translatedText).toBe('edited on B')

    // The edit A lost is recoverable from the conflict log.
    const conflicts = await dbA.syncConflicts.toArray()
    expect(conflicts.length).toBeGreaterThanOrEqual(1)
    expect(conflicts[0].entity).toBe('blocks')
  })

  it('wipes the cloud and keeps the audit trail', async () => {
    await projectRepo.create({ name: 'Ephemeral', sourceLang: 'en', targetLang: 'my' })
    await syncNow('manual')
    expect(backend.sheet('Projects')!.dataRowCount()).toBe(1)

    const result = await wipeCloud()
    expect(result.cleared).toBeGreaterThan(0)
    expect(backend.sheet('Projects')!.dataRowCount()).toBe(0)
    expect(backend.sheet('SyncLog')!.dataRowCount()).toBeGreaterThan(0)
  })

  it('advertises its capabilities to a plain connection probe', async () => {
    const res = await testConnection()
    expect(res.entities).toEqual([
      'projects',
      'pages',
      'blocks',
      'glossary',
      'settings',
      'usageStats',
      'apiKeys',
    ])
    expect(res.sheetNames).toHaveLength(8)
    // The sheet tabs are provisioned by the authenticated probe itself.
    expect(backend.spreadsheet().names()).toHaveLength(8)
  })

  /**
   * Several cycles through a backlog no single run can finish.
   *
   * Two ways of running out of room are in play and both must resume from
   * exactly where they stopped: the server's shared execution budget
   * expiring mid-push, and the pull page size forcing a multi-page fetch.
   * Every assertion is an exact count — the queue must shrink by precisely
   * the rows the server confirmed, the sheet must end up with one row per
   * change, and the pull cursor must never restart at zero.
   */
  it('pages through a large backlog across several sync cycles', async () => {
    const PAGES = 4
    // More than one push chunk (MAX_CHANGES_PER_PUSH) and more than one pull
    // page (PULL_PAGE_SIZE), so neither phase can finish in a single request.
    const BLOCKS = PULL_PAGE_SIZE + 60
    const TOTAL = 1 + PAGES + BLOCKS
    const BASE = Date.now() - 60_000

    const project = await projectRepo.create({
      name: 'React — လေ့လာရေး',
      sourceLang: 'en',
      targetLang: 'my',
      sourceFileName: 'book.pdf',
    })
    const pages: PageRecord[] = []
    for (let i = 0; i < PAGES; i += 1) {
      pages.push(
        await pageRepo.upsert({ projectId: project.id, index: i, width: 612, height: 792 }),
      )
    }
    for (let i = 0; i < BLOCKS; i += 1) {
      await blockRepo.upsert({
        projectId: project.id,
        pageId: pages[i % PAGES].id,
        order: i,
        kind: 'paragraph',
        sourceText: `Line ${i} — React renders a tree of components.`,
        translatedText: `စာကြောင်း ${i} — React သည် အစိတ်အပိုင်းများကို ဖန်တီးသည်။`,
        status: 'translated',
      })
    }

    // Hand out spread-out stamps, parent before child. A bulk parse stamps a
    // whole page range in one millisecond, and a tied group straddling the
    // page boundary is then handed over in a single page — which would
    // quietly hide the paging this test exists to prove.
    let stamp = BASE
    await dbA.projects.update(project.id, { updatedAt: (stamp += 10) })
    for (const page of pages) {
      stamp += 10
      await dbA.pages.update(page.id, { updatedAt: stamp })
    }
    await dbA.blocks
      .where('projectId')
      .equals(project.id)
      .modify((row) => {
        stamp += 10
        row.updatedAt = stamp
      })

    // Every change the wire actually delivered, in order — the only way to
    // prove a paged pull neither drops nor repeats a row.
    const delivered: string[] = []
    const recordingFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit): Promise<Response> => {
      const res = await recordingFetch(input as RequestInfo, init)
      const body = JSON.parse(String(init?.body)) as { action?: string }
      if (body.action === 'pullChanges') {
        const parsed = (await res.clone().json()) as { changes?: Array<{ id: string }> }
        for (const change of parsed.changes ?? []) delivered.push(change.id)
      }
      return res
    })
    /** `since` of every pull request issued after `from`. */
    const pullSinces = (from: number): number[] =>
      backend.calls
        .slice(from)
        .filter((call) => call.action === 'pullChanges')
        .map((call) => Number(call.body.since))
    /** Rows this run got the server to confirm. */
    const acked = (stats: SyncStats) => stats.pushed - stats.deferred

    // Provision the tabs before the clock is armed: the capability probe
    // writes the header rows, and that write must not trip the budget.
    expectOk(backend.post({ action: 'ping', deviceId: 'dev_seed00001', token: TOKEN }), 'ping')

    // Cycle 1 — the budget dies between the first two sheets.
    const disarmFirst = armBudgetExpiry(backend)
    const first = await syncNow('manual').finally(disarmFirst)
    expect(first.collected).toBe(TOTAL)
    expect(first.pushed).toBeGreaterThan(0)
    expect(first.pushed).toBeLessThanOrEqual(MAX_CHANGES_PER_PUSH)
    expect(first.deferred).toBeGreaterThan(0)
    expect(first.hasMore).toBe(true)
    // A sheet is written completely or not at all, so a resumed run never
    // has to repair a half-written tab: Projects landed, Pages did not start.
    expect(backend.sheet('Projects')!.dataRowCount()).toBe(1)
    expect(backend.sheet('Pages')!.dataRowCount()).toBe(0)
    // The queue holds exactly the rows the server has not confirmed yet.
    expect(await outboxRepo.pendingCount()).toBe(TOTAL - acked(first))

    // Cycle 2 — picks up where cycle 1 stopped, and runs out of time again.
    const disarmSecond = armBudgetExpiry(backend)
    const second = await syncNow('manual').finally(disarmSecond)
    expect(second.pushed).toBeGreaterThan(0)
    expect(second.deferred).toBeGreaterThan(0)
    expect(second.hasMore).toBe(true)
    expect(await outboxRepo.pendingCount()).toBe(TOTAL - acked(first) - acked(second))
    expect(backend.sheet('Pages')!.dataRowCount()).toBe(PAGES)
    expect(backend.sheet('Blocks')!.dataRowCount()).toBe(0)

    // Cycle 3 — the budget holds and the queue drains.
    const third = await syncNow('manual')
    expect(third.pushed).toBe(TOTAL - acked(first) - acked(second))
    expect(third.deferred).toBe(0)
    expect(third.hasMore).toBe(false)
    expect(await outboxRepo.pendingCount()).toBe(0)
    expect(acked(first) + acked(second) + acked(third)).toBe(TOTAL)
    expect(backend.sheet('Pages')!.dataRowCount()).toBe(PAGES)
    expect(backend.sheet('Blocks')!.dataRowCount()).toBe(BLOCKS)

    // A device also receives its own rows back: one delivery per pushed row
    // across the three cycles, and not one of them rewritten — merge
    // recognises the copy it already holds instead of re-applying it or
    // logging a conflict.
    expect(first.pulled + second.pulled + third.pulled).toBe(TOTAL)
    expect(third.pulled - third.appliedRemote).toBe(BLOCKS)
    expect(await dbA.blocks.count()).toBe(BLOCKS)
    expect(await dbA.syncConflicts.count()).toBe(0)
    expect(delivered.length).toBe(TOTAL)
    expect(new Set(delivered).size).toBe(TOTAL)

    // A second device pulls the whole backlog — paged, once, into Dexie.
    activate(dbB, 'BBB01')
    await configure()
    delivered.length = 0
    let mark = backend.calls.length

    const pull = await syncNow('manual')
    expect(pull.pulled).toBe(TOTAL)
    expect(pull.pullPages).toBe(2)
    expect(pull.hasMore).toBe(false)
    expect(pull.deferred).toBe(0)
    expect(delivered.length).toBe(TOTAL)
    expect(new Set(delivered).size).toBe(TOTAL)
    const sinces = pullSinces(mark)
    expect(sinces).toHaveLength(2)
    expect(sinces[0]).toBe(0)
    expect(sinces[1]).toBeGreaterThan(0)
    // The cursor moved forward monotonically and was persisted after each
    // page — the next cycle resumes from the end, never from zero.
    const storedCursor = (await dbB.syncMeta.toArray())[0].pullCursor
    expect(storedCursor).toBeGreaterThan(sinces[1])

    expect(await dbB.projects.get(project.id)).toBeDefined()
    expect(await dbB.pages.count()).toBe(PAGES)
    expect(await dbB.blocks.count()).toBe(BLOCKS)
    const landed = await dbB.blocks.filter((row) => row.order === 42).first()
    expect(landed?.sourceText).toContain('Line 42')
    expect(landed?.translatedText).toContain('စာကြောင်း 42')
    expect(landed?.status).toBe('translated')

    // A third device adds ten rows; the next cycle must fetch those ten and
    // nothing else, resuming at the stored cursor instead of starting at 0.
    const remoteBase = BASE + 10_000
    const extra = Array.from({ length: 10 }, (_, i) => ({
      entity: 'blocks',
      id: `blk_remote_${i}`,
      op: 'upsert',
      record: {
        id: `blk_remote_${i}`,
        projectId: project.id,
        pageId: pages[0].id,
        order: 1000 + i,
        kind: 'paragraph',
        sourceText: `Remote line ${i}`,
        translatedText: `အဝေးက စာကြောင်း ${i}`,
        status: 'translated',
        createdAt: remoteBase,
        updatedAt: remoteBase + i,
        deviceId: 'dev_cloud0001',
        version: 1,
      },
      updatedAt: remoteBase + i,
      version: 1,
      deviceId: 'dev_cloud0001',
    }))
    expectOk(
      backend.post({
        action: 'pushChanges',
        deviceId: 'dev_cloud0001',
        token: TOKEN,
        changes: extra,
      }),
      'third device push',
    )

    delivered.length = 0
    mark = backend.calls.length
    const delta = await syncNow('manual')
    expect(delta.pulled).toBe(10)
    expect(delta.pullPages).toBe(1)
    expect(pullSinces(mark)).toEqual([storedCursor])
    expect(delivered).toHaveLength(10)
    expect(await dbB.blocks.count()).toBe(BLOCKS + 10)

    // A run with nothing new still pages once and reads nothing twice.
    mark = backend.calls.length
    const idle = await syncNow('manual')
    expect(idle.pulled).toBe(0)
    expect(idle.pullPages).toBe(1)
    expect(pullSinces(mark)).toEqual([remoteBase + 9])
    expect(await dbB.blocks.count()).toBe(BLOCKS + 10)
  }, 120_000)
})
