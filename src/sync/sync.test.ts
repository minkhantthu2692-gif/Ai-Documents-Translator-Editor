/**
 * Phase 5 sync engine tests — two "browsers" converging through one mock
 * Apps Script backend (the in-memory twin of apps-script/Code.gs: token auth,
 * LWW push, paged pull, deleteProject cascade, wipe, partial pushes).
 *
 * Acceptance coverage:
 *   - two devices → one sheet → both converge,
 *   - offline run keeps the outbox; reconnect replays it,
 *   - LWW conflict is logged with the losing snapshot,
 *   - selective toggles + the secret-settings filter,
 *   - partial push resumes from nextCursor.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase, setDb } from '@/db/db'
import { resetDeviceIdCache } from '@/core/id'
import { outboxRepo } from '@/db/repo-outbox'
import { glossaryRepo } from '@/db/repo-knowledge'
import { projectRepo } from '@/db/repo-projects'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import {
  ensureSyncMeta,
  resetOutboxBackoff,
  restoreConflict,
  syncNow,
  testConnection,
  wipeCloud,
} from './engine'
import { defaultEntityToggles, isSyncError } from './protocol'

/* -------------------------------------------------------------------------- */
/* Mock Apps Script server                                                    */
/* -------------------------------------------------------------------------- */

const SHEET_ORDER = ['projects', 'pages', 'blocks', 'glossary', 'settings', 'usageStats'] as const
const SHEET_NAMES = ['Projects', 'Pages', 'Blocks', 'Glossary', 'Settings', 'UsageStats']
const EXEC_URL = 'https://script.google.example/exec'
const TEST_TOKEN = 'test-token'

type Row = Record<string, unknown>

interface ServerCall {
  action: string
  body: Record<string, unknown>
}

interface MockServer {
  sheets: Record<string, Map<string, Row>>
  calls: ServerCall[]
  token: string
  mode: 'ok' | 'network' | 'html' | 'code'
  errorCode: string
  pushCalls: number
  /** On the first pushChanges call, defer everything after N changes. */
  deferFirstPush: number
  rows(entity: string): Row[]
  has(entity: string, id: string): boolean
}

function serverWins(incoming: Row, stored: Row): boolean {
  const a = {
    updatedAt: Number(incoming.updatedAt),
    version: Number(incoming.version),
    deviceId: String(incoming.deviceId),
  }
  const b = {
    updatedAt: Number(stored.updatedAt),
    version: Number(stored.version),
    deviceId: String(stored.deviceId),
  }
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt
  if (a.version !== b.version) return a.version > b.version
  return a.deviceId > b.deviceId
}

function createMockServer(): MockServer {
  const sheets: Record<string, Map<string, Row>> = {}
  for (const name of SHEET_ORDER) sheets[name] = new Map()
  const server: MockServer = {
    sheets,
    calls: [],
    token: TEST_TOKEN,
    mode: 'ok',
    errorCode: 'INTERNAL',
    pushCalls: 0,
    deferFirstPush: -1,
    rows: (entity) => [...sheets[entity].values()],
    has: (entity, id) => sheets[entity].has(id),
  }

  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const fetchMock = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (server.mode === 'network') throw new TypeError('Failed to fetch')
    if (server.mode === 'html') return new Response('<html>error</html>', { status: 200 })

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    server.calls.push({ action: String(body.action), body })

    if (server.mode === 'code') {
      return json({ ok: false, code: server.errorCode, message: 'boom' })
    }
    if (body.token !== server.token) {
      return json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid or missing token.' })
    }

    switch (body.action) {
      case 'ping':
        return json({ ok: true, pong: true, serverTime: Date.now(), sheetNames: SHEET_NAMES })

      case 'pushChanges': {
        server.pushCalls += 1
        const changes = (body.changes ?? []) as Row[]
        const deferAfter = server.pushCalls === 1 ? server.deferFirstPush : -1
        let applied = 0
        let skipped = 0
        let deferred = 0
        let firstDeferred = -1
        let processed = 0
        for (let i = 0; i < changes.length; i += 1) {
          const change = changes[i]
          if (deferAfter >= 0 && processed >= deferAfter) {
            deferred += 1
            if (firstDeferred < 0) firstDeferred = i
            continue
          }
          const sheet = sheets[String(change.entity)]
          if (!sheet) {
            return json({ ok: false, code: 'BAD_REQUEST', message: 'not a syncable entity' })
          }
          const id = String(change.id)
          const record: Row = {
            ...((change.record ?? {}) as Row),
            id,
            updatedAt: Number(change.updatedAt),
            version: Number(change.version ?? 0),
            deviceId: String(change.deviceId ?? 'server'),
            deleted: change.op === 'delete',
          }
          const stored = sheet.get(id)
          if (stored && !serverWins(record, stored)) {
            skipped += 1
          } else {
            sheet.set(id, record)
            applied += 1
          }
          processed += 1
        }
        return json({
          ok: true,
          applied,
          skipped,
          deferred,
          truncated: 0,
          chunks: 1,
          partial: deferred > 0,
          nextCursor: deferred > 0 ? firstDeferred : null,
        })
      }

      case 'pullChanges': {
        const since = Number(body.since ?? 0)
        const limit = Math.min(Number(body.limit ?? 500), 5000)
        const all: { entity: string; sheetOrder: number; rowOrder: number; row: Row }[] = []
        SHEET_ORDER.forEach((entity, sheetOrder) => {
          let rowOrder = 0
          for (const row of sheets[entity].values()) {
            if (Number(row.updatedAt) > since) all.push({ entity, sheetOrder, rowOrder, row })
            rowOrder += 1
          }
        })
        all.sort(
          (a, b) =>
            Number(a.row.updatedAt) - Number(b.row.updatedAt) ||
            a.sheetOrder - b.sheetOrder ||
            a.rowOrder - b.rowOrder,
        )
        let take = Math.min(limit, all.length)
        if (take < all.length) {
          const boundary = Number(all[take - 1].row.updatedAt)
          while (take < all.length && Number(all[take].row.updatedAt) === boundary) take += 1
        }
        const changes = all.slice(0, take).map((item) => ({
          entity: item.entity,
          id: String(item.row.id),
          op: item.row.deleted ? 'delete' : 'upsert',
          updatedAt: Number(item.row.updatedAt),
          version: Number(item.row.version ?? 0),
          deviceId: String(item.row.deviceId ?? ''),
          record: item.row,
        }))
        return json({
          ok: true,
          changes,
          count: changes.length,
          hasMore: take < all.length,
          nextCursor: take > 0 ? Number(all[take - 1].row.updatedAt) : since,
          since,
          serverTime: Date.now(),
        })
      }

      case 'deleteProject': {
        const id = String(body.projectId)
        const project = sheets.projects.get(id)
        if (!project || project.deleted) {
          return json({ ok: false, code: 'NOT_FOUND', message: 'Project not found.' })
        }
        const now = Date.now()
        sheets.projects.set(id, {
          ...project,
          deleted: true,
          updatedAt: now,
          version: Number(project.version ?? 0) + 1,
          deviceId: 'server',
        })
        let pages = 0
        let blockCount = 0
        for (const page of [...sheets.pages.values()]) {
          if (page.projectId === id && !page.deleted) {
            sheets.pages.set(String(page.id), {
              ...page,
              deleted: true,
              updatedAt: now,
              version: Number(page.version ?? 0) + 1,
              deviceId: 'server',
            })
            pages += 1
          }
        }
        for (const block of [...sheets.blocks.values()]) {
          if (block.projectId === id && !block.deleted) {
            sheets.blocks.set(String(block.id), {
              ...block,
              deleted: true,
              updatedAt: now,
              version: Number(block.version ?? 0) + 1,
              deviceId: 'server',
            })
            blockCount += 1
          }
        }
        return json({ ok: true, project: 1, pages, blocks: blockCount })
      }

      case 'wipe': {
        if (body.confirm !== 'WIPE') {
          return json({ ok: false, code: 'BAD_REQUEST', message: 'confirm must be WIPE.' })
        }
        let cleared = 0
        for (const name of SHEET_ORDER) {
          cleared += sheets[name].size
          sheets[name].clear()
        }
        return json({ ok: true, cleared, total: cleared, chunks: 1 })
      }

      default:
        return json({ ok: false, code: 'UNKNOWN_ACTION', message: 'Unknown action.' })
    }
  }

  vi.stubGlobal('fetch', fetchMock)
  return server
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let dbCounter = 0

function freshDb(): AppDatabase {
  dbCounter += 1
  return new AppDatabase(`aidt-sync-${Date.now()}-${dbCounter}`)
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

describe('sync engine', () => {
  let server: MockServer
  let dbA: AppDatabase
  let dbB: AppDatabase

  beforeEach(async () => {
    vi.stubEnv('VITE_APPS_SCRIPT_URL', EXEC_URL)
    vi.stubEnv('VITE_APPS_SCRIPT_TOKEN', TEST_TOKEN)
    server = createMockServer()
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

  it('tests the connection with ping (no data moves)', async () => {
    const res = await testConnection()
    expect(res.sheetNames).toHaveLength(6)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(server.calls.map((call) => call.action)).toEqual(['ping'])
  })

  it('converges two browsers through one sheet', async () => {
    // Device A creates data and pushes it.
    const project = await projectRepo.create({ name: 'Manual', sourceLang: 'en', targetLang: 'my' })
    await glossaryRepo.create({ sourceTerm: 'hello', targetTerm: 'မင်္ဂလာပါ' })
    const first = await syncNow('manual')
    expect(first.pushed).toBeGreaterThanOrEqual(2)
    expect(server.rows('projects')).toHaveLength(1)
    expect(server.rows('glossary')).toHaveLength(1)

    // Device B pulls everything.
    activate(dbB, 'BBB01')
    await configure()
    await syncNow('manual')
    const bProject = await dbB.projects.get(project.id)
    expect(bProject?.name).toBe('Manual')
    const bGlossary = await dbB.glossary.toArray()
    expect(bGlossary).toHaveLength(1)
    expect(bGlossary[0].targetTerm).toBe('မင်္ဂလာပါ')

    // Device B renames the project → A follows after its own sync.
    await sleep(3)
    await dbB.projects.get(project.id)
    await glossaryRepo.update(bGlossary[0].id, { notes: 'edited on B' })
    const renamed = await projectRepo.update(project.id, { name: 'Renamed on B' })
    expect(renamed.updatedAt).toBeGreaterThan(bProject?.updatedAt ?? 0)
    await syncNow('manual')

    activate(dbA, 'AAA01')
    const statsA = await syncNow('manual')
    expect(statsA.pulled).toBeGreaterThanOrEqual(1)
    const aProject = await dbA.projects.get(project.id)
    expect(aProject?.name).toBe('Renamed on B')
    const aGlossary = await dbA.glossary.toArray()
    expect(aGlossary[0].notes).toBe('edited on B')

    // Routine catch-up (A's copy was already pushed) must not log conflicts.
    expect(await dbA.syncConflicts.count()).toBe(0)
    expect(await dbB.syncConflicts.count()).toBe(0)
    expect(await outboxRepo.pendingCount()).toBe(0)
  })

  it('keeps offline changes queued and replays them after reconnect', async () => {
    server.mode = 'network'
    await projectRepo.create({ name: 'Offline edit', sourceLang: 'en', targetLang: 'my' })

    await expect(syncNow('manual')).rejects.toSatisfy(
      (err: unknown) => isSyncError(err) && err.code === 'NETWORK',
    )
    expect(await outboxRepo.pendingCount()).toBe(1)
    const meta = await ensureSyncMeta()
    expect(meta.lastErrorCode).toBe('NETWORK')
    expect(server.rows('projects')).toHaveLength(0)

    // Reconnect → SyncBootstrap resets the backoff, then syncs.
    server.mode = 'ok'
    await resetOutboxBackoff()
    const stats = await syncNow('manual')
    expect(stats.pushed).toBe(1)
    expect(server.rows('projects')).toHaveLength(1)
    expect(await outboxRepo.pendingCount()).toBe(0)
    const healed = await ensureSyncMeta()
    expect(healed.lastErrorCode).toBeNull()
  })

  it('logs an LWW conflict with the losing snapshot', async () => {
    const project = await projectRepo.create({ name: 'Base', sourceLang: 'en', targetLang: 'my' })
    await syncNow('manual')

    activate(dbB, 'BBB01')
    await configure()
    await syncNow('manual')
    expect((await dbB.projects.get(project.id))?.name).toBe('Base')

    // B edits (older), A edits afterwards (newer) and wins the sheet.
    await projectRepo.update(project.id, { name: 'B edit' })
    await sleep(5)
    activate(dbA, 'AAA01')
    await projectRepo.update(project.id, { name: 'A edit' })
    await syncNow('manual')

    // B pushes its stale copy (server keeps A's), pulls A's and logs the loss.
    activate(dbB, 'BBB01')
    const stats = await syncNow('manual')
    expect(stats.pushed).toBe(1)
    expect(stats.conflicts).toBe(1)
    expect((await dbB.projects.get(project.id))?.name).toBe('A edit')

    const conflicts = await dbB.syncConflicts.toArray()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      entity: 'projects',
      entityId: project.id,
      winner: 'remote',
      policy: 'newest',
    })
    expect(conflicts[0].loser).toMatchObject({ name: 'B edit' })

    // Restoring the loser re-queues it as the new local winner.
    await restoreConflict(conflicts[0].id)
    expect((await dbB.projects.get(project.id))?.name).toBe('B edit')
    expect(await dbB.syncConflicts.count()).toBe(0)
    expect(await outboxRepo.pendingCount()).toBe(1)
  })

  it('cascades a project deletion to the other device', async () => {
    const project = await projectRepo.create({ name: 'Doomed', sourceLang: 'en', targetLang: 'my' })
    await syncNow('manual')

    activate(dbB, 'BBB01')
    await configure()
    await syncNow('manual')
    expect(await dbB.projects.get(project.id)).toBeDefined()

    activate(dbA, 'AAA01')
    await projectRepo.remove(project.id)
    await syncNow('manual')
    expect(server.calls.some((call) => call.action === 'deleteProject')).toBe(true)
    expect(server.has('projects', project.id)).toBe(true)
    expect(server.sheets.projects.get(project.id)?.deleted).toBe(true)

    activate(dbB, 'BBB01')
    await syncNow('manual')
    expect(await dbB.projects.get(project.id)).toBeUndefined()
    expect(await dbB.syncConflicts.count()).toBe(0)
  })

  it('resumes a partial push from nextCursor on the next run', async () => {
    server.deferFirstPush = 2
    for (let i = 0; i < 5; i += 1) {
      await projectRepo.create({ name: `P${i}`, sourceLang: 'en', targetLang: 'my' })
    }

    const firstRun = await syncNow('manual')
    expect(firstRun.deferred).toBe(3)
    expect(server.rows('projects')).toHaveLength(2)
    expect(await outboxRepo.pendingCount()).toBe(3)

    const secondRun = await syncNow('manual')
    expect(secondRun.pushed).toBe(3)
    expect(server.rows('projects')).toHaveLength(5)
    expect(await outboxRepo.pendingCount()).toBe(0)
  })

  it('never lets secret-looking settings onto the wire', async () => {
    await settingsRepo.set(
      SETTING_KEYS.syncEntities,
      { ...defaultEntityToggles(), settings: true },
      'sync',
    )
    await settingsRepo.set(SETTING_KEYS.appsScriptToken, { sealed: null, lastFour: '1234' }, 'sync')
    await settingsRepo.set(SETTING_KEYS.syncEnabled, true, 'sync')

    // Collect must skip it …
    await syncNow('manual')
    expect(server.rows('settings').some((row) => row.id === 'sync.appsScriptToken')).toBe(false)

    // … and even a hand-queued tombstone is dropped before the wire.
    await outboxRepo.enqueue({
      entity: 'settings',
      entityId: 'sync.appsScriptToken',
      op: 'delete',
      payload: {
        id: 'sync.appsScriptToken',
        group: 'sync',
        value: 'cipher',
        updatedAt: Date.now(),
        version: 2,
        deviceId: 'dev_AAA01000',
      },
    })
    const stats = await syncNow('manual')
    expect(stats.pushed).toBe(0)
    expect(server.rows('settings').some((row) => row.id === 'sync.appsScriptToken')).toBe(false)
    expect(await outboxRepo.pendingCount()).toBe(0)
    // Non-secret settings still travel.
    expect(server.rows('settings').some((row) => row.id === SETTING_KEYS.syncEntities)).toBe(true)
  })

  it('honours selective toggles (settings stay local by default)', async () => {
    await settingsRepo.set('ui.language', 'my', 'ui')
    await syncNow('manual')
    expect(server.rows('settings')).toHaveLength(0)

    await settingsRepo.set(
      SETTING_KEYS.syncEntities,
      { ...defaultEntityToggles(), settings: true },
      'sync',
    )
    await syncNow('manual')
    expect(server.rows('settings').some((row) => row.id === 'ui.language')).toBe(true)
  })

  it('wipes the cloud, rewinds cursors and keeps local data', async () => {
    await projectRepo.create({ name: 'Kept locally', sourceLang: 'en', targetLang: 'my' })
    await syncNow('manual')
    expect(server.rows('projects')).toHaveLength(1)

    const cleared = await wipeCloud()
    expect(cleared.cleared).toBeGreaterThanOrEqual(1)
    expect(server.rows('projects')).toHaveLength(0)

    const meta = await ensureSyncMeta()
    expect(meta.pushCursor).toBe(0)
    expect(meta.pullCursor).toBe(0)

    // Next run rebuilds the cloud from this device.
    await syncNow('manual')
    expect(server.rows('projects')).toHaveLength(1)
    expect(await dbA.projects.count()).toBe(1)
  })

  it('rejects a wrong token with UNAUTHORIZED and records it', async () => {
    server.token = 'rotated-token'
    await expect(syncNow('manual')).rejects.toSatisfy(
      (err: unknown) => isSyncError(err) && err.code === 'UNAUTHORIZED',
    )
    const meta = await ensureSyncMeta()
    expect(meta.lastErrorCode).toBe('UNAUTHORIZED')
  })

  it('fails with NOT_CONFIGURED when URL/token are missing', async () => {
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_APPS_SCRIPT_URL', '')
    vi.stubEnv('VITE_APPS_SCRIPT_TOKEN', '')
    await settingsRepo.remove(SETTING_KEYS.appsScriptUrl)
    await expect(syncNow('manual')).rejects.toSatisfy(
      (err: unknown) => isSyncError(err) && err.code === 'NOT_CONFIGURED',
    )
  })

  it('maps a non-JSON response to BAD_RESPONSE', async () => {
    server.mode = 'html'
    await expect(syncNow('manual')).rejects.toSatisfy(
      (err: unknown) => isSyncError(err) && err.code === 'BAD_RESPONSE',
    )
  })
})
