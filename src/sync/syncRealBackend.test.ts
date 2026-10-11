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
import { projectRepo } from '@/db/repo-projects'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { createBackend, type AppsScriptBackend } from './appsScriptRuntime'
import { syncNow, testConnection, wipeCloud } from './engine'
import { defaultEntityToggles } from './protocol'

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
})
