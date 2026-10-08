/**
 * Zustand store for sync UI state. Wraps the engine so components never
 * import it directly; toasts stay in the components (this store is also used
 * by silent auto-sync runs).
 *
 * Status values are surfaced as `data-state` on the `sync-status` element:
 *   disabled | idle | syncing | error | offline
 */

import { create } from 'zustand'
import { FATAL_SYNC_CODES, isSyncError, toSyncErrorCode, type SyncErrorCode } from './protocol'
import {
  ensureSyncMeta,
  readSyncConfig,
  resetOutboxBackoff,
  syncNow as engineSyncNow,
  testConnection as engineTestConnection,
  wipeCloud as engineWipeCloud,
  type SyncConfig,
  type SyncStats,
  type TestConnectionResult,
} from './engine'

export type SyncUiStatus = 'disabled' | 'idle' | 'syncing' | 'error' | 'offline'

export type SyncRunOutcome =
  { ok: true; stats: SyncStats } | { ok: false; code: SyncErrorCode; message: string }

interface SyncStoreState {
  status: SyncUiStatus
  /** URL + token present. */
  configured: boolean
  enabled: boolean
  autoSync: boolean
  intervalMinutes: number
  running: boolean
  /** Auto-sync pauses after a fatal code (bad token etc.) until settings change. */
  autoPaused: boolean
  lastStats: SyncStats | null
  lastError: { code: SyncErrorCode; message: string } | null
  refresh: () => Promise<void>
  run: (trigger?: SyncStats['trigger']) => Promise<SyncRunOutcome>
  testConnection: () => Promise<TestConnectionResult>
  wipeCloud: () => Promise<number>
  noteOnline: () => Promise<void>
  noteOffline: () => void
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

function deriveStatus(
  base: Omit<
    SyncStoreState,
    'status' | 'refresh' | 'run' | 'testConnection' | 'wipeCloud' | 'noteOnline' | 'noteOffline'
  >,
): SyncUiStatus {
  if (base.running) return 'syncing'
  if (isOffline()) return 'offline'
  if (base.lastError) return 'error'
  if (!base.enabled) return 'disabled'
  return 'idle'
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  status: 'idle',
  configured: false,
  enabled: false,
  autoSync: true,
  intervalMinutes: 5,
  running: false,
  autoPaused: false,
  lastStats: null,
  lastError: null,

  refresh: async () => {
    let config: SyncConfig
    try {
      config = await readSyncConfig()
    } catch {
      // Device secret destroyed / DB unavailable → treat as unconfigured.
      set({
        configured: false,
        enabled: false,
        status: deriveStatus({
          ...get(),
          enabled: false,
          configured: false,
          lastError: get().lastError,
        }),
      })
      return
    }
    set({
      configured: config.configured,
      enabled: config.enabled,
      autoSync: config.autoSync,
      intervalMinutes: config.intervalMinutes,
      status: deriveStatus({ ...get(), ...config, lastError: get().lastError }),
    })
  },

  run: async (trigger = 'manual') => {
    const state = get()
    set({
      running: true,
      status: 'syncing',
      // A manual run always retries — it clears the fatal pause.
      autoPaused: trigger === 'auto' ? state.autoPaused : false,
      lastError: trigger === 'auto' ? state.lastError : null,
    })
    try {
      const stats = await engineSyncNow(trigger)
      set({
        running: false,
        lastStats: stats,
        lastError: null,
        autoPaused: false,
        status: deriveStatus({ ...get(), running: false, lastError: null }),
      })
      return { ok: true, stats }
    } catch (err) {
      const code = toSyncErrorCode(err)
      const message = err instanceof Error ? err.message : String(err)
      const fatal = isSyncError(err) ? FATAL_SYNC_CODES.includes(code) : false
      set({
        running: false,
        lastError: { code, message },
        autoPaused: get().autoPaused || (fatal && trigger === 'auto'),
        status: deriveStatus({ ...get(), running: false, lastError: { code, message } }),
      })
      return { ok: false, code, message }
    }
  },

  testConnection: () => engineTestConnection(),

  wipeCloud: async () => {
    const res = await engineWipeCloud()
    await get().refresh()
    return res.cleared
  },

  noteOnline: async () => {
    await resetOutboxBackoff()
    await get().refresh()
    const { enabled, autoSync, autoPaused, running } = get()
    if (enabled && autoSync && !autoPaused && !running) {
      await get().run('online')
    } else {
      set({ status: deriveStatus({ ...get(), running: false }) })
    }
  },

  noteOffline: () => {
    set({ status: 'offline' })
  },
}))

/** Seeds cursors/meta (called once at app start so the first run is cheap). */
export async function initSyncMeta(): Promise<void> {
  try {
    await ensureSyncMeta()
  } catch {
    // IndexedDB unavailable — sync simply stays inactive.
  }
}
