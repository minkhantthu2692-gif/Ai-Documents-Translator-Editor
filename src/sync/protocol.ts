/**
 * Cloud-sync wire protocol — the browser side of `apps-script/Code.gs`.
 *
 * Every request is a single `POST text/plain` body of
 * `{ token, action, deviceId, ...payload }`; every response (success or
 * failure) is HTTP 200 JSON. Text/plain keeps the request "simple" so browsers
 * never preflight it with CORS.
 *
 * Error codes produced by the server (anything unknown is treated
 * generically by the UI):
 *   OK             — doGet health probe only
 *   UNAUTHORIZED   — token missing/mismatched
 *   BAD_REQUEST    — malformed body/fields
 *   UNKNOWN_ACTION — action not in ACTIONS_
 *   LOCK_TIMEOUT   — another session holds the script lock
 *   SECRET_NOT_ALLOWED — a secret-looking Settings row was pushed
 *   NOT_FOUND      — referenced project missing
 *   INTERNAL       — unhandled server failure
 * Codes added client-side: NOT_CONFIGURED, NETWORK, TIMEOUT, BAD_RESPONSE.
 */

import type { OutboxEntity, SyncableEntity } from '@/db/types'

/** Server + client error codes carried in `{ ok:false, code, message }`. */
export type SyncErrorCode =
  | 'OK'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'UNKNOWN_ACTION'
  | 'LOCK_TIMEOUT'
  | 'SECRET_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'INTERNAL'
  // Client-only codes (never sent by the server).
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'

/** Codes that will not fix themselves without user action. */
export const FATAL_SYNC_CODES: readonly SyncErrorCode[] = [
  'UNAUTHORIZED',
  'BAD_REQUEST',
  'UNKNOWN_ACTION',
  'SECRET_NOT_ALLOWED',
  'NOT_CONFIGURED',
]

export class SyncError extends Error {
  readonly code: SyncErrorCode
  constructor(code: SyncErrorCode, message: string) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}

export function isSyncError(err: unknown): err is SyncError {
  return err instanceof SyncError
}

export function toSyncErrorCode(err: unknown): SyncErrorCode {
  return isSyncError(err) ? err.code : 'INTERNAL'
}

/** One change travelling in `pushChanges` / arriving from `pullChanges`. */
export interface WireChange {
  entity: SyncableEntity
  id: string
  op: 'upsert' | 'delete'
  record?: Record<string, unknown>
  updatedAt: number
  version: number
  deviceId: string
}

export interface PingResponse {
  ok: true
  pong: true
  serverTime: number
  sheetNames: string[]
}

export interface PushResponse {
  ok: true
  applied: number
  skipped: number
  deferred: number
  truncated: number
  chunks: number
  partial: boolean
  /** Index into the submitted `changes` array of the first deferred change. */
  nextCursor: number | null
}

export interface PullResponse {
  ok: true
  changes: WireChange[]
  count: number
  hasMore: boolean
  nextCursor: number
  since: number
  serverTime: number
}

export interface DeleteProjectResponse {
  ok: true
  project: number
  pages: number
  blocks: number
}

export interface WipeResponse {
  ok: true
  cleared: number
  total: number
  chunks: number
}

/* -------------------------------------------------------------------------- */
/* Chunking limits (client side)                                              */
/* -------------------------------------------------------------------------- */

/** Changes per pushChanges call — keeps one call well inside the 6-min budget. */
export const MAX_CHANGES_PER_PUSH = 200
/** Serialized body budget per pushChanges call (server hard limit is 5MB). */
export const MAX_PUSH_BYTES = 3 * 1024 * 1024
/** Rows per pullChanges call (server default 500, max 5000). */
export const PULL_PAGE_SIZE = 500
/** Pull pages per sync run — bounds wall-clock time on a huge backlog. */
export const MAX_PULL_PAGES = 100
/** Push batches per sync run — same bound for the push direction. */
export const MAX_PUSH_BATCHES = 60
/** Conflict log cap; oldest entries are pruned beyond this. */
export const MAX_CONFLICTS = 200
/** Per-request timeout (Apps Script cold starts can take ~30s). */
export const REQUEST_TIMEOUT_MS = 120_000

/* -------------------------------------------------------------------------- */
/* Entity mapping                                                             */
/* -------------------------------------------------------------------------- */

/** Dexie table name → wire entity (as used by SHEET_DEFS_ in Code.gs). */
export const TABLE_TO_WIRE: Record<string, SyncableEntity> = {
  projects: 'projects',
  pages: 'pages',
  blocks: 'blocks',
  glossary: 'glossary',
  settings: 'settings',
  usageStats: 'usageStats',
}

/** Tables scanned by collect(), in child-after-parent order for readable logs. */
export const SYNC_SCAN_TABLES: readonly string[] = [
  'projects',
  'pages',
  'blocks',
  'glossary',
  'settings',
  'usageStats',
]

/** Outbox entity (singular, per OutboxEntity) → wire entity. */
export const OUTBOX_TO_WIRE: Record<string, SyncableEntity> = {
  project: 'projects',
  page: 'pages',
  block: 'blocks',
  glossary: 'glossary',
  settings: 'settings',
  usage: 'usageStats',
}

/** Dexie table name → outbox entity (collect side). */
export const TABLE_TO_OUTBOX: Record<string, OutboxEntity> = {
  projects: 'project',
  pages: 'page',
  blocks: 'block',
  glossary: 'glossary',
  settings: 'settings',
  usageStats: 'usage',
}

/** Wire entity → outbox entity (inverse of OUTBOX_TO_WIRE). */
export const WIRE_TO_OUTBOX: Record<SyncableEntity, OutboxEntity> = {
  projects: 'project',
  pages: 'page',
  blocks: 'block',
  glossary: 'glossary',
  settings: 'settings',
  usageStats: 'usage',
}

/** Wire entity → Dexie table name (identity except usageStats). */
export const WIRE_TO_TABLE: Record<SyncableEntity, string> = {
  projects: 'projects',
  pages: 'pages',
  blocks: 'blocks',
  glossary: 'glossary',
  settings: 'settings',
  usageStats: 'usageStats',
}

/**
 * Mirrors `SECRET_RE_` in Code.gs. Settings rows whose id (or field name)
 * matches are never pushed: the server would abort the whole batch with
 * SECRET_NOT_ALLOWED. `sync.appsScriptToken` is the important one — the sealed
 * token must not even be attempted.
 */
const SECRET_RE = /key|token|secret|password|authorization/i

export function isSecretSettingId(id: string): boolean {
  return SECRET_RE.test(id)
}

/** Default selective-sync toggles (apiKeys has no toggle — never syncable). */
export function defaultEntityToggles(): Record<SyncableEntity, boolean> {
  return {
    projects: true,
    pages: true,
    blocks: true,
    glossary: true,
    settings: false,
    usageStats: false,
  }
}

export type ConflictPolicy = 'local' | 'remote' | 'newest'

export function normalizeConflictPolicy(value: unknown): ConflictPolicy {
  return value === 'local' || value === 'remote' ? value : 'newest'
}
