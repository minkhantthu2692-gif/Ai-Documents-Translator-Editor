/**
 * Shared record shapes. Every persisted record carries:
 *   id, createdAt, updatedAt, deviceId, version
 * so backups and future cloud sync can merge without ambiguity.
 */

import type { AppEvent, EventState } from '@/core/events'
import type { FsmState } from '@/core/fsm'
import type { ReasonCode, Severity } from '@/core/reasonCodes'

export interface BaseRecord {
  id: string
  createdAt: number
  updatedAt: number
  deviceId: string
  /** Monotonic per-record revision, incremented on every write. */
  version: number
}

export type ProjectStatus =
  'draft' | 'ready' | 'processing' | 'review' | 'done' | 'failed' | 'archived'

export interface ProjectRecord extends BaseRecord {
  name: string
  sourceFileName: string | null
  sourceFileSize: number
  sourceLang: string
  targetLang: string
  status: ProjectStatus
  pageCount: number
  translatedPageCount: number
  blockCount: number
  characterCount: number
  /** 0..100 derived from translatedPageCount / pageCount. */
  progress: number
  archived: boolean
  archivedAt: number | null
  lastOpenedAt: number
  notes: string
}

export type OcrStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed'
export type RenderStatus = 'idle' | 'rendered' | 'stale' | 'failed'

export interface PageRecord extends BaseRecord {
  projectId: string
  index: number
  width: number
  height: number
  rotation: number
  hasTextLayer: boolean
  textCharacterCount: number
  ocrStatus: OcrStatus
  renderStatus: RenderStatus
  blockCount: number
}

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'caption' | 'shape'
export type BlockStatus = 'pending' | 'translated' | 'edited' | 'locked' | 'skipped'

export interface BlockRecord extends BaseRecord {
  projectId: string
  pageId: string
  order: number
  kind: BlockKind
  sourceText: string
  translatedText: string
  /** Geometry in PDF points relative to the page. */
  x: number
  y: number
  width: number
  height: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  color: string
  bold: boolean
  italic: boolean
  status: BlockStatus
  characterCount: number
}

export type TranslationStatus = 'pending' | 'running' | 'done' | 'failed'

export interface TranslationRecord extends BaseRecord {
  projectId: string
  blockId: string
  sourceText: string
  translatedText: string
  sourceHash: string
  sourceLang: string
  targetLang: string
  provider: string
  model: string
  characters: number
  tokens: number
  status: TranslationStatus
  reasonCode: ReasonCode | null
}

export interface GlossaryRecord extends BaseRecord {
  projectId: string | null
  sourceTerm: string
  targetTerm: string
  sourceLang: string
  targetLang: string
  notes: string
  caseSensitive: boolean
}

export interface TranslationMemoryRecord extends BaseRecord {
  sourceHash: string
  sourceText: string
  targetText: string
  sourceLang: string
  targetLang: string
  provider: string
  model: string
  characters: number
  hits: number
  lastUsedAt: number
}

export type CacheKind = 'translation' | 'pageRender' | 'ocr' | 'font'

export const CACHE_KINDS: readonly CacheKind[] = ['translation', 'pageRender', 'ocr', 'font']

export interface CacheRecord extends BaseRecord {
  kind: CacheKind
  key: string
  value: unknown
  size: number
  expiresAt: number
  lastAccessAt: number
  hits: number
}

export type JobType = 'preflight' | 'parse' | 'ocr' | 'translate' | 'layout' | 'export' | 'sync'

export interface JobRecord extends BaseRecord {
  projectId: string | null
  type: JobType
  state: FsmState
  progress: number
  pageIndex: number | null
  lineIndex: number | null
  reasonCode: ReasonCode | null
  messageMy: string
  messageEn: string
  startedAt: number
  finishedAt: number | null
}

export type EventSeverity = Severity
export type EventStateValue = EventState

export interface EventRecord extends BaseRecord {
  timestamp: number
  state: EventState
  pageIndex: number | null
  lineIndex: number | null
  reasonCode: ReasonCode | null
  severity: Severity
  messageMy: string
  messageEn: string
  technicalDetail: string
  fixActions: AppEvent['fixActions']
  projectId: string | null
  jobId: string | null
  action: string | null
  deviceId: string
}

export type OutboxOp = 'upsert' | 'delete'
export type OutboxEntity =
  | 'project'
  | 'page'
  | 'block'
  | 'translation'
  | 'glossary'
  | 'translationMemory'
  | 'event'
  | 'settings'

export interface OutboxRecord extends BaseRecord {
  entity: OutboxEntity
  entityId: string
  op: OutboxOp
  payload: unknown
  attempts: number
  lastError: string | null
  nextAttemptAt: number
  sentAt: number | null
}

export interface SettingRecord {
  id: string
  group: string
  value: unknown
  updatedAt: number
  deviceId: string
  version: number
  createdAt: number
}

export type ApiKeyStatus = 'unknown' | 'valid' | 'invalid' | 'cooling' | 'quota'

export interface ApiKeyRecord extends BaseRecord {
  provider: string
  label: string
  /** AES-GCM payload (base64): {iv, salt, data} — plaintext never persisted. */
  cipher: string
  lastFour: string
  status: ApiKeyStatus
  statusDetail: string
  lastCheckedAt: number | null
  models: string[]
}

export interface UsageStatsRecord extends BaseRecord {
  provider: string
  model: string
  /** YYYY-MM-DD in local time. */
  day: string
  requests: number
  failedRequests: number
  characters: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}
