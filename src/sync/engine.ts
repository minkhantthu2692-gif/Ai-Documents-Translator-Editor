/**
 * Sync engine — collect → push → pull → apply, plus connection probes.
 *
 * Source of truth stays in IndexedDB; the Google Sheet is only a relay so two
 * browsers (or two machines) can converge through one spreadsheet.
 *
 * Run shape:
 *   1. collect   — rows with `updatedAt > pushCursor` are copied into the
 *                  outbox (future-dated rows come from a remote clock that is
 *                  ahead of ours and are never echoed back).
 *   2. push      — outbox rows travel in ≤200-change / ≤3MB chunks; project
 *                  deletes go through the dedicated `deleteProject` action so
 *                  the server can cascade. A `partial` response resumes from
 *                  `nextCursor` (first deferred index) on the next run.
 *   3. pull      — `pullChanges(since: pullCursor)` pages forward, projects
 *                  first, then children; every change goes through
 *                  `mergeRemote` (LWW + conflict policy + conflict log).
 *
 * Offline runs fail fast (NETWORK) and leave the outbox untouched; the
 * 'online' listener resets per-row backoff so the next attempt is immediate.
 */

import type { Table } from 'dexie'
import { decodeSealed, encodeSealed, openText, sealText, type SealedPayload } from '@/core/crypto'
import { logEvent } from '@/core/eventLogger'
import { getDeviceId } from '@/core/id'
import { vaultPassphrase } from '@/core/vault'
import { getDb } from '@/db/db'
import { outboxRepo } from '@/db/repo-outbox'
import { stampNew, stampUpdate } from '@/db/repo-common'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type {
  BaseRecord,
  OutboxEntity,
  OutboxRecord,
  SyncConflictRecord,
  SyncMetaRecord,
  SyncableEntity,
} from '@/db/types'
import { SyncClient } from './client'
import { mergeRemote } from './merge'
import {
  FATAL_SYNC_CODES,
  MAX_CHANGES_PER_PUSH,
  MAX_CONFLICTS,
  MAX_PULL_PAGES,
  MAX_PUSH_BATCHES,
  MAX_PUSH_BYTES,
  OUTBOX_TO_WIRE,
  PULL_PAGE_SIZE,
  SYNC_SCAN_TABLES,
  TABLE_TO_OUTBOX,
  TABLE_TO_WIRE,
  WIRE_TO_OUTBOX,
  WIRE_TO_TABLE,
  SyncError,
  defaultEntityToggles,
  isSecretSettingId,
  normalizeConflictPolicy,
  settingsToggleFor,
  toSyncErrorCode,
  type ConflictPolicy,
  type EntityToggles,
  type SyncErrorCode,
  type SyncToggle,
  type WireChange,
} from './protocol'

/** Shape stored in `SETTING_KEYS.appsScriptToken` (sealed with device secret). */
export interface TokenSettingValue {
  sealed: SealedPayload | null
  lastFour: string
}

export interface SyncConfig {
  url: string
  token: string
  enabled: boolean
  autoSync: boolean
  intervalMinutes: number
  conflictPolicy: ConflictPolicy
  entities: EntityToggles
  /** URL + token present — i.e. a run would get past NOT_CONFIGURED. */
  configured: boolean
}

export interface SyncStats {
  trigger: 'manual' | 'auto' | 'online'
  startedAt: number
  durationMs: number
  collected: number
  pushed: number
  applied: number
  skipped: number
  deferred: number
  pulled: number
  appliedRemote: number
  conflicts: number
  orphans: number
  pullPages: number
  /** True when the pull backlog outlived MAX_PULL_PAGES — sync again. */
  hasMore: boolean
}

export interface TestConnectionResult {
  latencyMs: number
  sheetNames: string[]
  serverTime: number
  /** Entities the deployed backend declared support for (old builds omit it). */
  entities: string[]
}

const DEFAULT_INTERVAL_MINUTES = 5

/* -------------------------------------------------------------------------- */
/* Config + meta                                                              */
/* -------------------------------------------------------------------------- */

function envVar(name: 'VITE_APPS_SCRIPT_URL' | 'VITE_APPS_SCRIPT_TOKEN'): string {
  const value = import.meta.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

/** Reads sync settings (settings rows win over VITE_ env defaults). */
export async function readSyncConfig(): Promise<SyncConfig> {
  const [url, tokenSetting, enabled, autoSync, interval, policy, entities] = await Promise.all([
    settingsRepo.get<string>(SETTING_KEYS.appsScriptUrl, ''),
    settingsRepo.get<TokenSettingValue | null>(SETTING_KEYS.appsScriptToken, null),
    settingsRepo.get<boolean>(SETTING_KEYS.syncEnabled, false),
    settingsRepo.get<boolean>(SETTING_KEYS.autoSync, true),
    settingsRepo.get<number>(SETTING_KEYS.autoSyncInterval, DEFAULT_INTERVAL_MINUTES),
    settingsRepo.get<string>(SETTING_KEYS.conflictPolicy, 'newest'),
    settingsRepo.get<Partial<EntityToggles>>(SETTING_KEYS.syncEntities, {}),
  ])

  let token = ''
  if (tokenSetting?.sealed) {
    try {
      token = await openText(tokenSetting.sealed)
    } catch {
      token = ''
    }
  }
  if (!token) token = envVar('VITE_APPS_SCRIPT_TOKEN')

  const finalUrl = (url || envVar('VITE_APPS_SCRIPT_URL')).trim()
  const minutes =
    typeof interval === 'number' && Number.isFinite(interval) && interval >= 1
      ? Math.floor(interval)
      : DEFAULT_INTERVAL_MINUTES

  const entityToggles = defaultEntityToggles()
  for (const key of Object.keys(entityToggles) as SyncToggle[]) {
    if (typeof entities[key] === 'boolean') entityToggles[key] = entities[key] as boolean
  }

  return {
    url: finalUrl,
    token,
    enabled: enabled === true,
    autoSync: autoSync !== false,
    intervalMinutes: minutes,
    conflictPolicy: normalizeConflictPolicy(policy),
    entities: entityToggles,
    configured: Boolean(finalUrl && token),
  }
}

const META_ID = 'meta' as const

/** Loads (or creates) the single device-local sync meta row. */
export async function ensureSyncMeta(): Promise<SyncMetaRecord> {
  const db = getDb()
  const deviceId = getDeviceId()
  const existing = await db.syncMeta.get(META_ID)
  if (existing) {
    if (existing.deviceId !== deviceId) {
      const next = { ...existing, deviceId, updatedAt: Date.now() }
      await db.syncMeta.put(next)
      return next
    }
    return existing
  }
  const fresh: SyncMetaRecord = {
    id: META_ID,
    pushCursor: 0,
    pullCursor: 0,
    deviceId,
    vector: {},
    lastPushAt: null,
    lastPullAt: null,
    lastSyncAt: null,
    lastError: null,
    lastErrorCode: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.syncMeta.put(fresh)
  return fresh
}

async function persistMeta(meta: SyncMetaRecord): Promise<void> {
  meta.updatedAt = Date.now()
  await getDb().syncMeta.put(meta)
}

function makeClient(config: SyncConfig): SyncClient {
  if (!config.url || !config.token) {
    throw new SyncError('NOT_CONFIGURED', 'Cloud sync needs an Apps Script URL and access token.')
  }
  return new SyncClient({ url: config.url, token: config.token, deviceId: getDeviceId() })
}

/* -------------------------------------------------------------------------- */
/* Public probes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Asks the backend which entities it can store.
 *
 * An empty set is the answer given by a Code.gs that predates the apiKeys
 * sheet: that build omits the field instead of naming what it supports.
 */
async function probeEntities(client: SyncClient): Promise<Set<string>> {
  const res = await client.ping()
  return new Set(res.entities ?? [])
}

/** Settings → Data "Test connection": ping only, no data moves. */
export async function testConnection(): Promise<TestConnectionResult> {
  const config = await readSyncConfig()
  const client = makeClient(config)
  const started = Date.now()
  const res = await client.ping()
  return {
    latencyMs: Date.now() - started,
    sheetNames: res.sheetNames ?? [],
    serverTime: res.serverTime,
    entities: res.entities ?? [],
  }
}

/**
 * Settings → Data "Delete cloud data": wipes every row in the spreadsheet,
 * then rewinds the local cursors so the next sync rebuilds the cloud from
 * this device. Local rows are untouched.
 */
export async function wipeCloud(): Promise<{ cleared: number }> {
  const config = await readSyncConfig()
  const client = makeClient(config)
  const res = await client.wipe()

  const meta = await ensureSyncMeta()
  meta.pushCursor = 0
  meta.pullCursor = 0
  meta.vector = {}
  meta.lastError = null
  meta.lastErrorCode = null
  await persistMeta(meta)
  await outboxRepo.clearAll()

  logEvent({
    state: 'SYNC',
    action: 'sync.wipe-cloud',
    severity: 'warning',
    messageMy: 'クラウドのデータをすべて削除しました',
    messageEn: 'Deleted all cloud-sync data from the spreadsheet',
    technicalDetail: `wipe: ${res.cleared} row(s) cleared`,
  })
  return { cleared: res.cleared }
}

/** Reconnect handler: drops per-row backoff so pending pushes retry now. */
export async function resetOutboxBackoff(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  await db.outbox
    .filter((row) => row.sentAt === null && row.nextAttemptAt > now)
    .modify({ nextAttemptAt: now })
}

/* -------------------------------------------------------------------------- */
/* Collect                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Copies every locally-changed row (updatedAt > pushCursor) into the outbox.
 * `pushCursor` advances to just before the scan start: rows edited during the
 * scan are guaranteed to be caught by the next run even if they land in the
 * same millisecond.
 */
async function collectDeltas(meta: SyncMetaRecord, entities: EntityToggles): Promise<number> {
  const db = getDb()
  const scanStart = Date.now()
  let collected = 0

  // Turning an entity ON must rescan history: rows synced (or skipped) under
  // the old cursor belong to a period when the entity was excluded.
  //
  // `settings` and `providerSettings` share one sheet, so the table is scanned
  // when *either* is on and each row is gated individually below. The trigger
  // therefore compares toggle keys rather than wire names — comparing wires
  // would make turning on `settings` look like no change while
  // `providerSettings` already enabled the table.
  const enabledTables = SYNC_SCAN_TABLES.filter((table) => {
    const wire = TABLE_TO_WIRE[table]
    if (wire === 'settings') return entities.settings || entities.providerSettings
    return entities[wire] === true
  })
  const enabledToggles: SyncToggle[] = []
  for (const table of enabledTables) {
    const wire = TABLE_TO_WIRE[table]
    if (wire === 'settings') {
      if (entities.settings) enabledToggles.push('settings')
      if (entities.providerSettings) enabledToggles.push('providerSettings')
    } else {
      enabledToggles.push(wire)
    }
  }
  const previous = meta.syncedEntities
  if (previous && enabledToggles.some((toggle) => !previous.includes(toggle))) {
    meta.pushCursor = 0
  }

  for (const tableName of enabledTables) {
    const wire = TABLE_TO_WIRE[tableName]

    const table = db.table(tableName) as Table<Record<string, unknown>, string>
    const rows = await table.where('updatedAt').above(meta.pushCursor).toArray()
    for (const row of rows) {
      if (row.id === undefined || row.id === null) continue
      const updatedAt = Number(row.updatedAt)
      // A local edit can never be stamped in the future (updatedAt comes from
      // this device's clock); future dates are remote data from a clock that
      // runs ahead — echoing them back would be pointless.
      if (Number.isFinite(updatedAt) && updatedAt > scanStart) continue
      if (wire === 'settings' && !settingsToggleFor(String(row.id), entities)) continue
      if (wire === 'settings' && isSecretSettingId(String(row.id))) continue
      if (
        wire === 'settings' &&
        row.value &&
        typeof row.value === 'object' &&
        !Array.isArray(row.value) &&
        // Only a string or a nested object/array can *hold* a credential, so
        // only those are worth inspecting. Booleans and numbers are not —
        // without this the `apiKeys: true` toggle inside `sync.entities` would
        // read as a secret and freeze the entire setting locally.
        Object.entries(row.value as Record<string, unknown>).some(
          ([key, value]) =>
            (typeof value === 'string' || (value !== null && typeof value === 'object')) &&
            isSecretSettingId(key),
        )
      ) {
        continue
      }
      await outboxRepo.enqueue({
        entity: TABLE_TO_OUTBOX[tableName],
        entityId: String(row.id),
        op: 'upsert',
        payload: row,
      })
      collected += 1
    }
  }

  meta.pushCursor = scanStart - 1
  meta.syncedEntities = enabledToggles
  await persistMeta(meta)
  return collected
}

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

function retryDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.min(attempts, 8), 600_000)
}

function describe(err: unknown): string {
  const code = toSyncErrorCode(err)
  const message = err instanceof Error ? err.message : String(err)
  return `${code}: ${message}`.slice(0, 500)
}

/** Codes where continuing the run is pointless (server unreachable/busy/fatal). */
function shouldAbortRun(code: SyncErrorCode): boolean {
  if (FATAL_SYNC_CODES.includes(code)) return true
  return (
    code === 'NETWORK' || code === 'TIMEOUT' || code === 'BAD_RESPONSE' || code === 'LOCK_TIMEOUT'
  )
}

function toWireChange(row: OutboxRecord): WireChange | null {
  const entity = OUTBOX_TO_WIRE[row.entity]
  if (!entity) return null
  const record = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<
    string,
    unknown
  >
  const updatedAt = Number(record.updatedAt)
  const version = Number(record.version)
  return {
    entity,
    id: row.entityId,
    op: row.op,
    record,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    version: Number.isFinite(version) ? version : 1,
    deviceId:
      typeof record.deviceId === 'string' && record.deviceId ? record.deviceId : getDeviceId(),
  }
}

/**
 * Turns outbox rows into wire changes.
 *
 * `apiKeys` is the one entity whose payload has to be *opened* on the way out:
 * the row sits in IndexedDB sealed with AES-GCM while the sheet stores the
 * plaintext the user opted into sharing. Decryption happens here — the last
 * moment before the request is built — so no readable secret is ever written
 * back into the outbox, and the sealed field is stripped so a cipher cannot
 * travel by mistake.
 *
 * A row that cannot be opened (a vault this session has not unlocked) returns
 * `null`, which retires the outbox row instead of failing the whole run: the
 * key simply does not travel until the user unlocks and edits it again.
 */
async function toWireChanges(rows: OutboxRecord[]): Promise<(WireChange | null)[]> {
  const out: (WireChange | null)[] = []
  for (const row of rows) {
    const change = toWireChange(row)
    if (!change) {
      out.push(null)
      continue
    }
    out.push(change.entity === 'apiKeys' ? await toPlainKeyChange(change) : change)
  }
  return out
}

/** Shortest plaintext we will accept as a key (matches the add-key form). */
const KEY_MIN_LENGTH = 8

/**
 * Rebuilds a key change as the opt-in plaintext payload.
 *
 * An explicit allow-list travels, because last-writer-wins would otherwise let
 * one device's runtime bookkeeping (cooldowns, lifetime request counters, probe
 * status) clobber the other's. Deletes carry no payload at all — a tombstone
 * needs only the id and the stamp, and this is where a stale cipher would
 * otherwise leak into the sheet.
 */
async function toPlainKeyChange(change: WireChange): Promise<WireChange | null> {
  if (change.op === 'delete') return { ...change, record: {} }

  const source = { ...((change.record ?? {}) as Record<string, unknown>) }
  const cipher = typeof source.cipher === 'string' ? source.cipher : ''
  if (!cipher) return null

  let opened: string
  try {
    opened = await openText(decodeSealed(cipher), vaultPassphrase() ?? undefined)
  } catch {
    // Vault locked, or a cipher sealed by another device — nothing to send.
    return null
  }
  const secret = opened.trim()
  if (secret.length < KEY_MIN_LENGTH) return null

  return {
    ...change,
    record: {
      provider: typeof source.provider === 'string' ? source.provider : '',
      label: typeof source.label === 'string' ? source.label : '',
      models: Array.isArray(source.models) ? source.models : [],
      enabled: source.enabled !== false,
      lastFour: secret.slice(-4),
      secret,
      createdAt: Number.isFinite(Number(source.createdAt))
        ? Number(source.createdAt)
        : change.updatedAt,
    },
  }
}

/** Splits rows into ≤200-change chunks that also fit the 3MB body budget. */
function chunkRows(rows: OutboxRecord[]): OutboxRecord[][] {
  const chunks: OutboxRecord[][] = []
  let current: OutboxRecord[] = []
  let bytes = 0
  for (const row of rows) {
    const size = JSON.stringify(row.payload ?? {}).length + 256
    if (
      current.length >= MAX_CHANGES_PER_PUSH ||
      (current.length > 0 && bytes + size > MAX_PUSH_BYTES)
    ) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += size
  }
  if (current.length) chunks.push(current)
  return chunks
}

async function pushPhase(
  client: SyncClient,
  meta: SyncMetaRecord,
  stats: SyncStats,
  entities: EntityToggles,
  supported: Set<string>,
): Promise<void> {
  let iterations = 0
  let deferredError: unknown = null

  while (iterations < MAX_PUSH_BATCHES) {
    const due = await outboxRepo.due(1000)
    if (due.length === 0) break
    iterations += 1

    // Queue triage: non-syncable legacy rows and secret settings are retired,
    // rows for entities the user switched off are dropped (re-enabled entities
    // get a full rescan anyway), and the rest is split into the dedicated
    // deleteProject stream plus regular pushChanges chunks.
    const projectDeletes: OutboxRecord[] = []
    const pushable: OutboxRecord[] = []
    for (const row of due) {
      const wire = OUTBOX_TO_WIRE[row.entity]
      if (!wire) {
        await outboxRepo.markSent(row.id)
        continue
      }
      if (row.entity === 'settings') {
        // Two toggles share this sheet: a row follows *its own* one — `ai.`-
        // prefixed ids ride providerSettings, everything else rides settings —
        // while credential-shaped ids are retired outright.
        if (isSecretSettingId(row.entityId)) {
          await outboxRepo.markSent(row.id)
          continue
        }
        if (!settingsToggleFor(row.entityId, entities)) {
          await getDb().outbox.delete(row.id)
          continue
        }
      } else if (!entities[wire]) {
        await getDb().outbox.delete(row.id)
        continue
      }
      if (wire === 'apiKeys' && !supported.has('apiKeys')) {
        // Hold rather than drop. Dropping would strand the change — collect()
        // only looks at rows newer than the push cursor — so the row keeps its
        // backoff (capped at ten minutes) and goes out on the first run after
        // the sheet is re-deployed with the newer Code.gs.
        await outboxRepo.markFailed(
          row.id,
          'Backend predates the ApiKeys sheet — re-deploy apps-script/Code.gs, then sync again.',
          retryDelayMs(row.attempts),
        )
        continue
      }
      if (row.entity === 'project' && row.op === 'delete') projectDeletes.push(row)
      else pushable.push(row)
    }

    for (const row of projectDeletes) {
      try {
        await client.deleteProject(row.entityId)
        await outboxRepo.markSent(row.id)
      } catch (err) {
        const code = toSyncErrorCode(err)
        if (code === 'NOT_FOUND') {
          // Already gone on the server — that is a successful delete.
          await outboxRepo.markSent(row.id)
          continue
        }
        await outboxRepo.markFailed(row.id, describe(err), retryDelayMs(row.attempts))
        if (shouldAbortRun(code)) throw err
        deferredError = deferredError ?? err
      }
    }

    for (const chunk of chunkRows(pushable)) {
      const changes = (await toWireChanges(chunk)).filter((c): c is WireChange => c !== null)
      if (changes.length === 0) {
        for (const row of chunk) await outboxRepo.markSent(row.id)
        continue
      }
      try {
        const res = await client.pushChanges(changes)
        stats.pushed += changes.length
        stats.applied += res.applied
        stats.skipped += res.skipped
        if (res.partial && typeof res.nextCursor === 'number' && res.nextCursor >= 0) {
          // Server budget expired: everything before nextCursor is processed
          // (applied or skipped); the rest stays due for the next run.
          for (const row of chunk.slice(0, res.nextCursor)) await outboxRepo.markSent(row.id)
          stats.deferred += chunk.length - res.nextCursor
          meta.lastPushAt = Date.now()
          await persistMeta(meta)
          return
        }
        for (const row of chunk) await outboxRepo.markSent(row.id)
      } catch (err) {
        const code = toSyncErrorCode(err)
        for (const row of chunk) {
          await outboxRepo.markFailed(row.id, describe(err), retryDelayMs(row.attempts))
        }
        if (shouldAbortRun(code)) throw err
        // INTERNAL: one bad batch must not block the rest of the run.
        deferredError = deferredError ?? err
      }
      iterations += 1
      if (iterations >= MAX_PUSH_BATCHES) break
    }
  }

  meta.lastPushAt = Date.now()
  await persistMeta(meta)
  if (deferredError) throw deferredError
}

/* -------------------------------------------------------------------------- */
/* Pull + apply                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalises an incoming record for the local table, or drops it (`null`).
 *
 * Keys are the exception: the wire carries the **plaintext** the other device
 * opted into sharing, and it is re-sealed here before it can touch IndexedDB —
 * under this session's vault passphrase when one is unlocked, with the
 * per-device secret otherwise, exactly as `keyBundle` import does. A remote
 * `cipher` is never trusted: it was sealed on a device whose key does not
 * exist here, so accepting it would write a row that can never be opened.
 *
 * Runtime bookkeeping arrives reset rather than copied: cooldowns and lifetime
 * counters describe the *other* device's traffic.
 */
async function sanitizeIncoming(change: WireChange): Promise<Record<string, unknown> | null> {
  const record = { ...((change.record ?? {}) as Record<string, unknown>) }
  const table = WIRE_TO_TABLE[change.entity]

  if (table === 'pages') {
    if (typeof record.projectId !== 'string' || !record.projectId) return null
  } else if (table === 'blocks') {
    if (typeof record.projectId !== 'string' || !record.projectId) return null
    if (typeof record.pageId !== 'string' || !record.pageId) return null
  } else if (table === 'projects') {
    if (typeof record.name !== 'string') return null
  } else if (table === 'glossary') {
    if (typeof record.sourceTerm !== 'string' || typeof record.targetTerm !== 'string') {
      return null
    }
  } else if (table === 'settings') {
    if (!('value' in record)) return null
    if (typeof record.group !== 'string') record.group = 'general'
  } else if (table === 'apiKeys') {
    if (typeof record.provider !== 'string' || !record.provider) return null
    const secret = typeof record.secret === 'string' ? record.secret.trim() : ''
    if (secret.length < KEY_MIN_LENGTH) return null
    record.cipher = encodeSealed(await sealText(secret, vaultPassphrase() ?? undefined))
    record.lastFour = secret.slice(-4)
    delete record.secret
    record.status = 'unknown'
    record.statusDetail = ''
    record.lastCheckedAt = null
    record.enabled = record.enabled !== false
    record.cooldownUntil = 0
    record.cooldownReason = null
    record.requests = 0
    record.tokensIn = 0
    record.tokensOut = 0
    record.lastUsedAt = null
    record.buckets = null
  }

  record.id = change.id
  record.updatedAt = change.updatedAt
  record.version = change.version
  record.deviceId = change.deviceId
  if (typeof record.createdAt !== 'number') record.createdAt = change.updatedAt
  return record
}

/** Local cascade mirroring ProjectRepository.remove() (no outbox — pull side). */
async function cascadeDelete(entity: SyncableEntity, id: string): Promise<void> {
  const db = getDb()
  if (entity === 'projects') {
    await db.pages.where('projectId').equals(id).delete()
    await db.blocks.where('projectId').equals(id).delete()
    await db.translations.where('projectId').equals(id).delete()
    await db.jobs.where('projectId').equals(id).delete()
    await db.projects.delete(id)
    return
  }
  if (entity === 'pages') {
    await db.blocks.where('pageId').equals(id).delete()
    await db.translations.where('pageId').equals(id).delete()
    await db.pages.delete(id)
    return
  }
  const table = db.table(WIRE_TO_TABLE[entity]) as Table<unknown, string>
  await table.delete(id)
}

/**
 * Seals a key snapshot that is about to be written to the conflict log.
 *
 * A remote loser carries the plaintext its device pushed; a local one arrives
 * already sealed. Either way the log must not hold a readable secret —
 * `syncConflicts` is IndexedDB like everything else. Returns `false` only when
 * a secret *was* carried but cannot be sealed, in which case the conflict is
 * dropped rather than recorded in the clear.
 */
async function sealLoserSecret(loser: Record<string, unknown>): Promise<boolean> {
  const carried = typeof loser.secret === 'string' ? loser.secret.trim() : ''
  delete loser.secret
  if (typeof loser.cipher === 'string' && loser.cipher) return true
  // No secret at all — a delete tombstone, or a payload the sender already
  // stripped. Nothing readable to protect, so the conflict is still worth
  // logging.
  if (!carried) return true
  if (carried.length < KEY_MIN_LENGTH) return false
  loser.cipher = encodeSealed(await sealText(carried, vaultPassphrase() ?? undefined))
  loser.lastFour = carried.slice(-4)
  return true
}

async function recordConflict(
  change: WireChange,
  conflict: NonNullable<ReturnType<typeof mergeRemote>['conflict']>,
  policy: ConflictPolicy,
  local: Record<string, unknown> | undefined,
  stats: SyncStats,
): Promise<void> {
  const db = getDb()
  const loser = { ...conflict.loser }
  if (loser.id === undefined) loser.id = change.id
  if (change.entity === 'apiKeys' && !(await sealLoserSecret(loser))) return

  const projectId =
    typeof (change.record ?? {}).projectId === 'string'
      ? String((change.record as Record<string, unknown>).projectId)
      : typeof local?.projectId === 'string'
        ? String(local.projectId)
        : null

  const entry: SyncConflictRecord = stampNew<SyncConflictRecord>(
    {
      entity: change.entity,
      entityId: change.id,
      projectId,
      winner: conflict.winner,
      policy,
      localUpdatedAt: Number(local?.updatedAt ?? 0),
      remoteUpdatedAt: change.updatedAt,
      localVersion: Number(local?.version ?? 0),
      remoteVersion: change.version,
      loser,
      detectedAt: Date.now(),
      resolvedAt: Date.now(),
    },
    'scf',
  )

  // Dedupe: the same resolution of the same record is only logged once.
  const existing = await db.syncConflicts.where('entityId').equals(change.id).toArray()
  const duplicate = existing.some(
    (row) =>
      row.entity === change.entity &&
      row.winner === entry.winner &&
      row.localUpdatedAt === entry.localUpdatedAt &&
      row.remoteUpdatedAt === entry.remoteUpdatedAt,
  )
  if (duplicate) return

  await db.syncConflicts.add(entry)
  stats.conflicts += 1

  const count = await db.syncConflicts.count()
  if (count > MAX_CONFLICTS) {
    const oldest = await db.syncConflicts
      .orderBy('detectedAt')
      .limit(count - MAX_CONFLICTS)
      .toArray()
    await db.syncConflicts.bulkDelete(oldest.map((row) => row.id))
  }
}

function noteVector(meta: SyncMetaRecord, deviceId: string, updatedAt: number): void {
  if (!deviceId) return
  const seen = Number(meta.vector[deviceId] ?? 0)
  if (updatedAt <= seen) return
  meta.vector[deviceId] = updatedAt
  const keys = Object.keys(meta.vector)
  if (keys.length > 50) {
    keys
      .sort((a, b) => meta.vector[a] - meta.vector[b])
      .slice(0, keys.length - 50)
      .forEach((key) => delete meta.vector[key])
  }
}

async function applyOne(
  change: WireChange,
  meta: SyncMetaRecord,
  policy: ConflictPolicy,
  stats: SyncStats,
): Promise<void> {
  // Defence in depth: the server refuses to store secret-looking settings and
  // this device refuses to materialise them locally either.
  if (change.entity === 'settings' && isSecretSettingId(change.id)) return

  // The sheet's `deleted` column is server bookkeeping — strip it from upserts
  // so local records keep their own shape (tombstones travel as op:'delete').
  if (change.op !== 'delete' && change.record && change.record.deleted !== true) {
    const record = { ...change.record }
    delete record.deleted
    change = { ...change, record }
  }

  const db = getDb()
  const tableName = WIRE_TO_TABLE[change.entity]
  const table = db.table(tableName) as Table<Record<string, unknown>, string>
  const local = await table.get(change.id)

  const outboxEntity = WIRE_TO_OUTBOX[change.entity]
  const pending = outboxEntity
    ? await db.outbox
        .where('[entity+entityId]')
        .equals([outboxEntity, change.id] as never)
        .first()
    : undefined
  const localPending = pending ? pending.sentAt === null : false
  // "Fresh" = edited since the last successful sync. The outbox alone is not
  // enough: a push that the server rejected under LWW is marked sent, yet the
  // local edit still loses when the winning copy arrives in this pull.
  const localFresh = local !== undefined && Number(local.updatedAt) > (meta.lastSyncAt ?? 0)

  const outcome = mergeRemote(local, change, {
    policy,
    localPending: localPending || localFresh,
  })
  stats.pulled += 1

  if (outcome.conflict) {
    await recordConflict(change, outcome.conflict, policy, local, stats)
  }

  if (outcome.action === 'apply') {
    if (change.op === 'delete') {
      await cascadeDelete(change.entity, change.id)
      stats.appliedRemote += 1
    } else {
      const record = await sanitizeIncoming(change)
      if (record) {
        await table.put(record as never)
        stats.appliedRemote += 1
        if (change.entity === 'pages' || change.entity === 'blocks') {
          if (!(await db.projects.get(String(record.projectId)))) stats.orphans += 1
        }
      } else {
        stats.skipped += 1
      }
    }
  }

  noteVector(meta, change.deviceId, change.updatedAt)
}

/** Two-pass apply: projects first so child rows never arrive parentless. */
async function applyChanges(
  changes: WireChange[],
  meta: SyncMetaRecord,
  policy: ConflictPolicy,
  stats: SyncStats,
): Promise<void> {
  const projects = changes.filter((change) => change.entity === 'projects')
  const rest = changes.filter((change) => change.entity !== 'projects')
  for (const change of projects) await applyOne(change, meta, policy, stats)
  for (const change of rest) await applyOne(change, meta, policy, stats)
}

async function pullPhase(
  client: SyncClient,
  meta: SyncMetaRecord,
  stats: SyncStats,
  policy: ConflictPolicy,
): Promise<void> {
  let since = meta.pullCursor
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const res = await client.pullChanges(since, PULL_PAGE_SIZE)
    if (res.changes.length > 0) {
      await applyChanges(res.changes, meta, policy, stats)
    }
    since = Number(res.nextCursor) || since
    meta.pullCursor = since
    meta.lastPullAt = Date.now()
    await persistMeta(meta)
    stats.pullPages += 1
    if (!res.hasMore) {
      stats.hasMore = false
      return
    }
  }
  stats.hasMore = true
}

/* -------------------------------------------------------------------------- */
/* One full sync run                                                          */
/* -------------------------------------------------------------------------- */

let currentRun: Promise<SyncStats> | null = null

/** True while a sync run is in flight (single-flight guard). */
export function isSyncRunning(): boolean {
  return currentRun !== null
}

/**
 * Runs a full collect → push → pull cycle.
 * Resolves with per-phase statistics; rejects with a SyncError whose code the
 * UI maps to a toast. Concurrent calls join the in-flight run.
 */
export function syncNow(trigger: SyncStats['trigger'] = 'manual'): Promise<SyncStats> {
  if (currentRun) return currentRun
  const run = executeSync(trigger).finally(() => {
    currentRun = null
  })
  currentRun = run
  return run
}

async function executeSync(trigger: SyncStats['trigger']): Promise<SyncStats> {
  const config = await readSyncConfig()
  if (!config.url || !config.token) {
    throw new SyncError('NOT_CONFIGURED', 'Cloud sync needs an Apps Script URL and access token.')
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new SyncError('NETWORK', 'Device is offline — changes stay queued until you reconnect.')
  }

  const meta = await ensureSyncMeta()
  // A manual Sync Now ignores per-row backoff — the user asked for it now.
  if (trigger === 'manual') await resetOutboxBackoff()
  const client = makeClient(config)
  const stats: SyncStats = {
    trigger,
    startedAt: Date.now(),
    durationMs: 0,
    collected: 0,
    pushed: 0,
    applied: 0,
    skipped: 0,
    deferred: 0,
    pulled: 0,
    appliedRemote: 0,
    conflicts: 0,
    orphans: 0,
    pullPages: 0,
    hasMore: false,
  }

  try {
    stats.collected = await collectDeltas(meta, config.entities)
    // Capability handshake before the first network write. `validateChanges_`
    // rejects an unknown entity across the *whole* request before a single row
    // is written, so one change this deployment cannot store would fail every
    // push in the run — key rows are held back until the server says it wants
    // them. Inside the try so a failed probe is recorded like any other error.
    const supported = await probeEntities(client)
    await pushPhase(client, meta, stats, config.entities, supported)
    await outboxRepo.clearSent()
    await pullPhase(client, meta, stats, config.conflictPolicy)

    meta.lastSyncAt = Date.now()
    meta.lastError = null
    meta.lastErrorCode = null
    await persistMeta(meta)

    if (trigger === 'manual') {
      logEvent({
        state: 'SYNC',
        action: 'sync.run',
        severity: 'info',
        messageMy: `စင့်အောင်းပြီး — တွန်းပို့ ${stats.pushed}ခု၊ ဆွဲယူ ${stats.pulled}ခု`,
        messageEn: `Sync complete — pushed ${stats.pushed}, pulled ${stats.pulled}`,
        technicalDetail: `collect=${stats.collected} applied=${stats.applied} skipped=${stats.skipped} deferred=${stats.deferred} conflicts=${stats.conflicts} pages=${stats.pullPages}`,
      })
    }
    stats.durationMs = Date.now() - stats.startedAt
    return stats
  } catch (err) {
    const code = toSyncErrorCode(err)
    meta.lastError = err instanceof Error ? err.message : String(err)
    meta.lastErrorCode = code
    await persistMeta(meta)
    logEvent({
      state: 'SYNC',
      action: `sync.${trigger}.failed`,
      severity: 'error',
      reasonCode: 'SYNC_FAILED',
      technicalDetail: describe(err),
    })
    stats.durationMs = Date.now() - stats.startedAt
    throw err
  }
}

/* -------------------------------------------------------------------------- */
/* Conflict restore                                                           */
/* -------------------------------------------------------------------------- */

const RESTORE_PREFIX: Record<SyncableEntity, string> = {
  projects: 'prj',
  pages: 'pg',
  blocks: 'blk',
  glossary: 'gl',
  settings: '',
  usageStats: 'us',
  apiKeys: 'key',
}

/**
 * Writes the losing snapshot back as the new local winner (fresh
 * `updatedAt` + `version`, this device's id) and queues it for push, then
 * drops the conflict entry.
 */
export async function restoreConflict(conflictId: string): Promise<void> {
  const db = getDb()
  const conflict = await db.syncConflicts.get(conflictId)
  if (!conflict) return

  const tableName = WIRE_TO_TABLE[conflict.entity]
  const table = db.table(tableName) as Table<Record<string, unknown>, string>
  const loser = { ...(conflict.loser as Record<string, unknown>), id: conflict.entityId }

  const existing = await table.get(conflict.entityId)
  const record = existing
    ? stampUpdate(existing as unknown as BaseRecord, loser as Partial<BaseRecord>)
    : stampNew(loser as unknown as BaseRecord, RESTORE_PREFIX[conflict.entity])

  await table.put(record as never)
  await outboxRepo.enqueue({
    entity: WIRE_TO_OUTBOX[conflict.entity] as OutboxEntity,
    entityId: conflict.entityId,
    op: 'upsert',
    payload: record,
  })
  await db.syncConflicts.delete(conflictId)
}

/** Deletes every conflict-log entry (Settings → Data). */
export async function clearConflicts(): Promise<void> {
  await getDb().syncConflicts.clear()
}
