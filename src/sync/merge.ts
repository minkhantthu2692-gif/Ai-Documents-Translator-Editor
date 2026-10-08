/**
 * Last-write-wins merge — pure decision logic shared by the pull applier and
 * the unit tests.
 *
 * Winner rules mirror `incomingWins_` in Code.gs so client and server always
 * agree:
 *   1. newer updatedAt wins,
 *   2. equal updatedAt → higher version wins,
 *   3. both equal → greater deviceId (string compare) wins.
 *
 * The configured `conflictPolicy` can override LWW:
 *   'newest' (default) — plain LWW.
 *   'local'   — the local copy always survives; a differing newer cloud copy
 *               is rejected (logged as a conflict).
 *   'remote'  — the cloud copy always survives (logged as a conflict when LWW
 *               would have kept the local copy).
 *
 * A conflict row is only written when real content differs AND either (a) the
 * local side had unsynced changes in the outbox that the merge destroys, or
 * (b) the policy forced a non-LWW winner. Routine catch-up (local stale,
 * remote newer, local fully pushed) is not a conflict.
 */

import type { ConflictPolicy, WireChange } from './protocol'

interface Meta {
  updatedAt: number
  version: number
  deviceId: string
}

export interface MergeContext {
  policy: ConflictPolicy
  /** True when the outbox still holds unsent changes for this entity+id. */
  localPending: boolean
}

export interface MergeOutcome {
  /** 'apply' — write `incoming` over the local row; 'skip' — keep local. */
  action: 'apply' | 'skip'
  conflict: null | {
    winner: 'local' | 'remote'
    /** Snapshot of the losing side (local row or incoming record). */
    loser: Record<string, unknown>
  }
}

/** Server-faithful comparison: does incoming beat stored? */
export function lwwWins(incoming: Meta, stored: Meta): boolean {
  if (incoming.updatedAt !== stored.updatedAt) return incoming.updatedAt > stored.updatedAt
  if (incoming.version !== stored.version) return incoming.version > stored.version
  return incoming.deviceId > stored.deviceId
}

function metaOf(value: Record<string, unknown>): Meta {
  const updatedAt = Number(value.updatedAt)
  const version = Number(value.version)
  return {
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    version: Number.isFinite(version) ? version : 0,
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : '',
  }
}

/**
 * Content comparison used to decide whether a merge actually loses data.
 * Key order is irrelevant (the Sheets round-trip reorders fields) and
 * `null` / `''` / `undefined` are treated as the same "empty" value.
 */
export function recordsDiffer(
  a: Record<string, unknown> | undefined | null,
  b: Record<string, unknown> | undefined | null,
): boolean {
  return !deepEqual(normalize(a), normalize(b))
}

function normalize(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const normalized = normalize(source[key])
      // Empty values are indistinguishable from absent keys.
      if (normalized === null) continue
      out[key] = normalized
    }
    return out
  }
  return value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>
    const rb = b as Record<string, unknown>
    const keys = Object.keys(ra)
    if (keys.length !== Object.keys(rb).length) return false
    return keys.every((key) => deepEqual(ra[key], rb[key]))
  }
  return false
}

/**
 * Decides what the pull applier should do with one incoming change.
 *
 * @param local     The local row (undefined when it does not exist).
 * @param incoming  The change pulled from the cloud.
 * @param ctx       Policy + outbox awareness.
 */
export function mergeRemote(
  local: Record<string, unknown> | undefined,
  incoming: WireChange,
  ctx: MergeContext,
): MergeOutcome {
  const incomingMeta: Meta = {
    updatedAt: incoming.updatedAt,
    version: incoming.version,
    deviceId: incoming.deviceId,
  }
  const incomingRecord = (incoming.record ?? { id: incoming.id }) as Record<string, unknown>

  // Nothing local: an upsert materialises the row; a tombstone has nothing to
  // remove (and must not resurrect a placeholder).
  if (!local) {
    return incoming.op === 'delete'
      ? { action: 'skip', conflict: null }
      : { action: 'apply', conflict: null }
  }

  const localMeta = metaOf(local)
  const sameMeta =
    localMeta.updatedAt === incomingMeta.updatedAt &&
    localMeta.version === incomingMeta.version &&
    localMeta.deviceId === incomingMeta.deviceId
  if (sameMeta) return { action: 'skip', conflict: null }

  const lwwRemoteWins = lwwWins(incomingMeta, localMeta)
  const differs = recordsDiffer(local, incomingRecord)

  let remoteWins: boolean
  if (ctx.policy === 'local') remoteWins = false
  else if (ctx.policy === 'remote') remoteWins = true
  else remoteWins = lwwRemoteWins

  if (remoteWins) {
    const forcedOverLww = ctx.policy === 'remote' && !lwwRemoteWins
    const destroysUnsyncedWork = ctx.localPending && differs
    const conflict =
      differs && (forcedOverLww || destroysUnsyncedWork)
        ? { winner: 'remote' as const, loser: local }
        : null
    return { action: 'apply', conflict }
  }

  // Local copy survives.
  const forcedOverLww = ctx.policy === 'local' && lwwRemoteWins
  const conflict =
    differs && forcedOverLww ? { winner: 'local' as const, loser: incomingRecord } : null
  return { action: 'skip', conflict }
}
