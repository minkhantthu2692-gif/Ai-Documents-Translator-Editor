/**
 * Shared record shapes. Every persisted record carries:
 *   id, createdAt, updatedAt, deviceId, version
 * so backups and future cloud sync can merge without ambiguity.
 */

import type { AppEvent, EventState } from '@/core/events'
import type { FsmState } from '@/core/fsm'
import type { ReasonCode, Severity } from '@/core/reasonCodes'
import type { BBox } from '@/pdf/stableId'
import type { LineStyle } from '@/pdf/lineGrouping'
import type { SkipRule } from '@/pdf/skipRules'
import type { FigureRef, LinkRef } from '@/pdf/structure'
import type { Placeholder } from '@/pdf/placeholders'

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
  /** Coarse content class derived from the per-page text coverage. */
  contentClass: PageContentClass
  /** Share of the page covered by extractable text, 0..1. */
  textCoverage: number
  /** ISO code detected for this page's text (null when unknown). */
  detectedLanguage: string | null
  /** Number of visual lines extracted from the text layer. */
  lineCount: number
  analysisState: PageAnalysisState
  /** Confidence (0..100) of the last OCR run, null when not OCR'd. */
  ocrConfidence: number | null
}

/** `text` — normal text layer, `scanned` — image only, `mixed` — both, `empty` — nothing. */
export type PageContentClass = 'text' | 'scanned' | 'mixed' | 'complex' | 'empty'
export type PageAnalysisState = 'idle' | 'queued' | 'running' | 'done' | 'failed'

/**
 * True when a page's content lives (partly) in images and OCR has not
 * finished yet — the parse queue uses it to keep such pages "unparsed"
 * until recognition succeeds, so a reload mid-OCR resumes exactly there.
 */
export function pageNeedsOcr(page: Pick<PageRecord, 'contentClass' | 'ocrStatus'>): boolean {
  return (
    (page.contentClass === 'scanned' || page.contentClass === 'mixed') && page.ocrStatus !== 'done'
  )
}

export type BlockKind =
  'heading' | 'paragraph' | 'list' | 'table' | 'caption' | 'footnote' | 'shape' | 'code'
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
  /**
   * Family extracted from the PDF — `fontFamily` is what renders today, this is
   * what "Font Family → Original" restores after a manual override.
   */
  originalFontFamily: string
  fontSize: number
  /**
   * The size extracted from the PDF. `fontSizeMode: 'original'` restores this
   * after an auto-fit or a manual override — without it, "Original / Auto-fit"
   * could never go back (Phase 4, schema v6).
   */
  originalFontSize: number
  lineHeight: number
  color: string
  bold: boolean
  italic: boolean
  status: BlockStatus
  characterCount: number
  /** Header / footer band versus real body content. */
  region: BlockRegion
  alignment: BlockAlignment
  /** Visual lines backing this block, in reading order. */
  lines: StoredLine[]
  /** Skip-rule name when the block must not be translated, else null. */
  skipRule: SkipRule | null
  /** `{{n}}` placeholders captured before translation. */
  placeholders: Placeholder[]
  /** Bullet / numbering marker (`•`, `1.`) captured from the first line. */
  listMarker: string | null
  /**
   * 1..6 for `kind === 'heading'`, else null — the depth inside the document's
   * own heading ladder. Written by extraction; a row from before heading
   * levels existed simply has no value and every reader must default it.
   */
  headingLevel?: number | null
  /**
   * External `/Link` annotations that landed on this block, in reading order.
   * Optional for the same reason `headingLevel` is: a row parsed before links
   * were captured simply has none, and every reader must default it.
   */
  links?: LinkRef[]
  /**
   * The cells of `kind === 'table'` — one array of cell strings per row, every
   * row the same length, `null` for every other kind. Optional for the same
   * reason `headingLevel` and `links` are: a row parsed before cells were
   * captured as data simply has none, and every reader must default it. The
   * block's `sourceText` still carries the cells as ` \t `-separated text, so
   * an old row renders — just through the text fallback rather than the grid.
   */
  tableCells?: string[][] | null
  /**
   * Figures anchored to this block — where the page painted a picture this
   * paragraph illustrates. Optional for the same reason `headingLevel`,
   * `links` and `tableCells` are: a row parsed before figures were traced has
   * none, and every reader must default it. Boxes only, never pixels — that
   * keeps a block row small enough to round-trip through the sync sheet.
   */
  figures?: FigureRef[]
  /** 0..1 heuristic quality of the last successful translation (null = none). */
  translationConfidence: number | null
  /** Flag from the last translation pass (null = clean). */
  translationFlag: TranslationFlag | null
  /** Epoch ms of the last successful translation, null when never translated. */
  translatedAt: number | null
  /**
   * Phase 4 — a pending AI suggestion (re-translate / alternative model) the
   * reviewer has not accepted or rejected yet. Kept beside the text so a reload
   * still offers the choice.
   */
  suggestedText: string | null
  suggestedModel: string | null
  suggestedAt: number | null
  /**
   * How `fontSize` was chosen: the value extracted from the PDF (`original`),
   * a computed auto-fit inside the original bbox (`auto`), or a size the user
   * typed/picked (`custom`). Drives the Font Size dropdown.
   */
  fontSizeMode: FontSizeMode
  /** True when the rendered text measured taller/wider than the original bbox. */
  overflow: boolean
}

export type FontSizeMode = 'original' | 'auto' | 'custom'

/** What a revision row records (drives the history list in the inspector). */
export type RevisionAction =
  | 'edit-text'
  | 'edit-style'
  | 'find-replace'
  | 'retranslate'
  | 'suggest'
  | 'accept-suggestion'
  | 'reject-suggestion'
  | 'lock'
  | 'unlock'
  | 'autofit'
  | 'restore'
  | 'template'

/**
 * One undoable per-block change. `before`/`after` hold only the fields the
 * action touched (a partial BlockRecord patch), so history stays small and a
 * "restore" can be replayed exactly.
 */
export interface RevisionRecord extends BaseRecord {
  projectId: string
  blockId: string
  pageIndex: number
  action: RevisionAction
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** `user` or the model id that produced the change. */
  actor: string
  note: string
  timestamp: number
}

export type BlockRegion = 'body' | 'header' | 'footer'
export type BlockAlignment = 'left' | 'center' | 'right' | 'justified'

/** One visual line as persisted (geometry + portable style). */
export interface StoredLine {
  id: string
  text: string
  bbox: BBox
  style: LineStyle
}

export type TranslationStatus = 'pending' | 'running' | 'done' | 'failed'

/** Non-fatal problem worth surfacing in the coverage report. */
export type TranslationFlag =
  'low-confidence' | 'kept-original' | 'glossary-miss' | 'placeholder-miss' | 'retried'

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
  /** Phase 5 — usageStats rows travel under this singular queue name. */
  | 'usage'
  /** Phase 3 — key rows, pushed only when the user opts in. */
  | 'apiKey'

/**
 * Phase 5 — entities that travel to the Google Sheet (wire names, identical to
 * `SHEET_DEFS_[].entity` in apps-script/Code.gs). Everything else —
 * translations, events, revisions, cache, jobs, sourceFiles — stays local.
 * `settings` sync also drops secret-looking ids client-side before the
 * server's own SECRET_NOT_ALLOWED check.
 *
 * Phase 3 added `apiKeys`, and it deliberately does *not* ride that secret-id
 * filter: it is a separate, off-by-default opt-in that writes the secret in
 * the clear, because the sheet is the user's own database and re-entering
 * every key per device was the pain this was built to remove. The UI says
 * what will happen before the toggle is switched on.
 */
export type SyncableEntity =
  'projects' | 'pages' | 'blocks' | 'glossary' | 'settings' | 'usageStats' | 'apiKeys'

export const SYNCABLE_ENTITIES: readonly SyncableEntity[] = [
  'projects',
  'pages',
  'blocks',
  'glossary',
  'settings',
  'usageStats',
  'apiKeys',
]

/**
 * A selective-sync switch as the UI exposes it. Not all of them are wire
 * entities: `providerSettings` filters the shared `settings` sheet down to
 * the `ai.` id prefix so provider config travels without the rest of the
 * preferences.
 *
 * Lives here rather than in `sync/` because `SyncMetaRecord.syncedEntities`
 * persists it, and `db/` must not import upward.
 */
export type SyncToggle = SyncableEntity | 'providerSettings'

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

/**
 * Phase 5 — one entry in the cloud-sync conflict log (LWW resolution).
 * Whenever a pulled remote change overwrites a local record that had local
 * edits (or the local change loses on push), the losing side is captured here
 * so Settings → Data can show what was replaced and offer a restore.
 */
export interface SyncConflictRecord extends BaseRecord {
  entity: SyncableEntity
  entityId: string
  projectId: string | null
  /** Which side survived the merge. */
  winner: 'local' | 'remote'
  /** The policy in force when the conflict was resolved. */
  policy: 'local' | 'remote' | 'newest'
  localUpdatedAt: number
  remoteUpdatedAt: number
  localVersion: number
  remoteVersion: number
  /** Snapshot of the losing record (the side that did not survive). */
  loser: Record<string, unknown>
  detectedAt: number
  resolvedAt: number
}

/**
 * Phase 5 — single-row sync state (`id: 'meta'`). Device-local only: never
 * synced, never backed up. `vector` maps deviceId → highest `updatedAt` this
 * device has seen from it (the version vector that makes delta pull possible
 * after an offline period).
 */
export interface SyncMetaRecord {
  id: 'meta'
  /** `updatedAt` cursor for push collection (local rows newer than this). */
  pushCursor: number
  /** Server `since` cursor for pullChanges. */
  pullCursor: number
  deviceId: string
  /** deviceId → max updatedAt observed from that device. */
  vector: Record<string, number>
  /** Wire entities included in the previous run (detects toggle-on rescans). */
  syncedEntities?: SyncToggle[]
  lastPushAt: number | null
  lastPullAt: number | null
  lastSyncAt: number | null
  lastError: string | null
  lastErrorCode: string | null
  createdAt: number
  updatedAt: number
}

export type ApiKeyStatus = 'unknown' | 'valid' | 'invalid' | 'cooling' | 'quota'

/** Why a key is in cooldown (drives the reason code shown in the Status Panel). */
export type CooldownReason = 'rate_limit' | 'quota' | 'server' | 'network'

/** One fixed-window token bucket (RPM / TPM / RPD / TPD). */
export interface BucketState {
  /** Requests (or tokens, for the TPM/TPD bucket) allowed per window. */
  limit: number
  used: number
  /** Epoch ms when the window resets. */
  resetAt: number
}

/**
 * The durable daily/monthly ledger for one quota unit.
 *
 * `tpd` was added after `rpm`/`tpm`/`rpd`; a record written before it simply
 * has no `tpd` and the pool treats that as "daily token allowance unknown"
 * (`limit === 0`), never as zero.
 */
export interface KeyBuckets {
  rpm: BucketState
  tpm: BucketState
  rpd: BucketState
  /** Tokens per day. `limit === 0` = unknown, so nothing is blocked on it. */
  tpd: BucketState
}

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
  /** Disabled keys stay sealed but never receive traffic. */
  enabled: boolean
  /** Epoch ms until which the key must not be used (0 = no cooldown). */
  cooldownUntil: number
  cooldownReason: CooldownReason | null
  /** Lifetime counters (least-used rotation + the settings card). */
  requests: number
  tokensIn: number
  tokensOut: number
  lastUsedAt: number | null
  /** Token-bucket position, persisted so a refresh keeps its windows. */
  buckets: KeyBuckets | null
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

/**
 * The original PDF bytes, kept locally so thumbnails, background renders and
 * "re-parse" work after a reload without asking the user for the file again.
 */
export interface SourceFileRecord extends BaseRecord {
  projectId: string
  name: string
  size: number
  mime: string
  blob: Blob
  pageCount: number
  /** Cheap content fingerprint used to prove a re-parse uses the same bytes. */
  checksum: string
  /**
   * Password of an encrypted source, kept only so a reload can re-open the
   * document without prompting again (parsing and thumbnails run on every
   * session, not just the one that unlocked it). It lives in this device's
   * IndexedDB beside the PDF itself; `sourceFiles` is excluded from backups
   * and never leaves the browser.
   */
  password?: string | null
}
