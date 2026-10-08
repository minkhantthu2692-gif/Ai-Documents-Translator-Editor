/**
 * Headless auto-sync controller mounted once in the AppShell.
 *
 * - re-reads sync settings when the app boots,
 * - runs a sync every `intervalMinutes` while auto-sync is enabled,
 * - resets per-row backoff and syncs immediately when the browser comes back
 *   online (offline edits replay from the outbox),
 * - tracks online/offline for the status indicator.
 */

import { useEffect } from 'react'
import { initSyncMeta, useSyncStore } from './store'

export function SyncBootstrap() {
  const refresh = useSyncStore((state) => state.refresh)
  const noteOnline = useSyncStore((state) => state.noteOnline)
  const noteOffline = useSyncStore((state) => state.noteOffline)
  const enabled = useSyncStore((state) => state.enabled)
  const autoSync = useSyncStore((state) => state.autoSync)
  const autoPaused = useSyncStore((state) => state.autoPaused)
  const intervalMinutes = useSyncStore((state) => state.intervalMinutes)

  // Boot: materialise the meta row and read config once.
  useEffect(() => {
    void initSyncMeta()
    void refresh()
  }, [refresh])

  // Periodic auto-sync.
  useEffect(() => {
    if (!enabled || !autoSync || autoPaused) return undefined
    const timer = window.setInterval(
      () => {
        void useSyncStore.getState().run('auto')
      },
      Math.max(1, intervalMinutes) * 60_000,
    )
    return () => window.clearInterval(timer)
  }, [enabled, autoSync, autoPaused, intervalMinutes])

  // Reconnect: pending outbox rows become due immediately, then sync.
  useEffect(() => {
    const onOnline = () => {
      void noteOnline()
    }
    const onOffline = () => {
      noteOffline()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    if (typeof navigator !== 'undefined' && navigator.onLine === false) noteOffline()
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [noteOnline, noteOffline])

  return null
}
