/**
 * Repository helpers: identity, sync metadata and generic query utilities.
 * Every write goes through here so `createdAt / updatedAt / deviceId / version`
 * are never forgotten.
 */

import type { Table } from 'dexie'
import { createId, getDeviceId } from '@/core/id'
import type { BaseRecord } from './types'

export function now(): number {
  return Date.now()
}

/** Fills id/timestamps/deviceId on a record that has never been persisted. */
export function stampNew<T extends BaseRecord>(record: Partial<T>, prefix: string): T {
  const timestamp = now()
  return {
    ...(record as T),
    id: record.id ?? createId(prefix),
    createdAt: record.createdAt ?? timestamp,
    updatedAt: timestamp,
    deviceId: record.deviceId ?? getDeviceId(),
    version: record.version ?? 1,
  } as T
}

/** Prepares an existing record for an update, bumping its revision. */
export function stampUpdate<T extends BaseRecord>(existing: T, patch: Partial<T>): T {
  return {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: now(),
    deviceId: existing.deviceId,
    version: existing.version + 1,
  }
}

export async function countWhere<T, TKey>(
  table: Table<T, TKey>,
  predicate: (record: T) => boolean,
): Promise<number> {
  return table.filter(predicate).count()
}

export async function listAll<T, TKey>(table: Table<T, TKey>): Promise<T[]> {
  return table.toArray()
}

export async function listByIndex<T, TKey>(
  table: Table<T, TKey>,
  index: string,
  value: string | number,
): Promise<T[]> {
  // Dexie index names are validated at runtime; cast keeps the call site typed.
  return table
    .where(index as never)
    .equals(value as never)
    .toArray()
}

/** Approximate byte size of a JSON-serialisable value (used for cache accounting). */
export function estimateSize(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return value.length * 2
  try {
    return JSON.stringify(value).length * 2
  } catch {
    return 1024
  }
}

/** FNV-1a — stable, dependency-free content hash for cache/TM keys. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + `-${text.length.toString(36)}`
}
