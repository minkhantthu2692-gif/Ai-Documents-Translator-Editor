/** Cloud sync — public surface (see protocol.ts for the wire contract). */

export { SyncClient, type SyncClientConfig } from './client'
export {
  clearConflicts,
  ensureSyncMeta,
  isSyncRunning,
  readSyncConfig,
  resetOutboxBackoff,
  restoreConflict,
  syncNow,
  testConnection,
  wipeCloud,
  type SyncConfig,
  type SyncStats,
  type TestConnectionResult,
  type TokenSettingValue,
} from './engine'
export { enqueueDelete, dropPendingProjectChildren } from './hooks'
export { lwwWins, mergeRemote, recordsDiffer, type MergeContext, type MergeOutcome } from './merge'
export * from './protocol'
export { initSyncMeta, useSyncStore, type SyncRunOutcome, type SyncUiStatus } from './store'
export { SyncBootstrap } from './SyncBootstrap'
