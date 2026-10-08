/**
 * In-memory ring of the most recent failures.
 *
 * The assistant seeds its context from here so it can explain "what just
 * happened" even when the user opens it from a different page than the one
 * that failed. Nothing is persisted (the durable copy of every failure is the
 * Logs table); entries are redacted on the way in and capped at 20.
 */

import { redactText } from './redact'

export interface MemoryEntry {
  at: number
  /** Reason code, sync error code or free-form code. */
  code: string | null
  message: string
}

const MAX_ENTRIES = 20
const entries: MemoryEntry[] = []

export const errorMemory = {
  remember(code: string | null, message: string): void {
    const clean = redactText(message).slice(0, 400)
    entries.push({ at: Date.now(), code, message: clean })
    while (entries.length > MAX_ENTRIES) entries.shift()
  },

  /** Newest last. */
  recent(limit = 5): MemoryEntry[] {
    return entries.slice(-limit)
  },

  /** Most recent entry (convenience for context building). */
  last(): MemoryEntry | null {
    return entries.length > 0 ? entries[entries.length - 1] : null
  },

  clear(): void {
    entries.length = 0
  },
}
