/**
 * Shared translation-pipeline types (Phase 3).
 *
 * Everything the queue, the worker, the UI and the tests agree on lives here so
 * a batch looks the same on all four sides.
 */

import type { ProviderId, QualityTier } from '@/config/models.config'
import type { Placeholder } from '@/pdf/placeholders'
import type { BlockKind, TranslationFlag } from '@/db/types'

export type { TranslationFlag }

/** Prompt/verification budget. */
export type QualityLevel = 'basic' | 'medium' | 'high'

export const QUALITY_LEVELS: QualityLevel[] = ['basic', 'medium', 'high']

/**
 * How often `TranslatedTerm(OriginalTerm)` annotations are written:
 *  - `first`   first occurrence on each page (default)
 *  - `document`first occurrence in the whole document
 *  - `every`   every occurrence
 */
export type TerminologyScope = 'first' | 'document' | 'every'

export type RotationStrategy = 'round-robin' | 'least-used'

export interface GlossaryEntry {
  sourceTerm: string
  targetTerm: string
  caseSensitive: boolean
  /** `global` for the shared glossary, otherwise the project id. */
  scope: string
}

/** Everything a run needs to be reproducible after a reload. */
export interface TranslateRunConfig {
  projectId: string
  provider: ProviderId
  model: string
  quality: QualityLevel
  sourceLang: string
  targetLang: string
  /** Translate OCR-extracted image text (overlay pass). */
  translateImages: boolean
  terminologyScope: TerminologyScope
  /** Ordered model fallback chain (runtime availability decides what runs). */
  fallbackModels: string[]
  strategy: RotationStrategy
  /** Custom base URL for the OpenAI-compatible provider. */
  baseUrl?: string
}

/** One translatable line handed to the engine. */
export interface BatchLine {
  /** Stable block id (`BlockRecord.id`). */
  id: string
  /** Source text with `{{n}}` placeholders already applied. */
  text: string
  /** Page the line belongs to (progress + per-page terminology scope). */
  pageIndex: number
  /** Reading order inside the page (used to rebuild result order). */
  order: number
  /** Bullet / numbering marker kept out of the prompt. */
  listMarker: string | null
  /**
   * Structure of the block this came from. The packer reads it so a batch
   * respects the document instead of cutting it at an arbitrary line: a
   * heading stays with the body it introduces, a caption stays with the figure
   * above it, and a run of table rows or list items travels together.
   */
  kind: BlockKind
  /** `{{n}}` → original substring, restored after translation. */
  placeholders: Placeholder[]
}

export interface TranslationBatch {
  /** Idempotency key: `project#epoch#page#batch` — reused across retries. */
  id: string
  pageIndex: number
  lines: BatchLine[]
  /** Rough token estimate of the source lines. */
  tokens: number
  /** Zero-based index of this batch inside its page. */
  index: number
}

export interface BatchResultLine {
  id: string
  text: string
  /** 0..1 heuristic confidence after validation + post-processing. */
  confidence: number
  /** Non-fatal problem worth surfacing in the coverage report. */
  flag: TranslationFlag | null
}

export interface BatchRunResult {
  batchId: string
  lines: BatchResultLine[]
  /** Number of provider round trips the batch needed (1 = no retries). */
  requests: number
  tokensIn: number
  tokensOut: number
  /** Key that served the batch (masked by the caller before display). */
  keyId: string | null
  model: string
  latencyMs: number
}

/** Live counters published to the translate page while a run is active. */
export interface TranslateProgress {
  phase: TranslatePhase
  /** Lines that were already translated before this run started. */
  alreadyDone: number
  /** Lines translated during this run. */
  done: number
  /** Translatable lines in the whole project. */
  total: number
  /** Failed lines (never dropped — they stay `pending` for Retry). */
  failed: number
  /** Page currently being worked on (0-based), null between pages. */
  pageIndex: number | null
  /** Lines completed on the current page. */
  pageDone: number
  /** Translatable lines on the current page. */
  pageTotal: number
  requests: number
  retries: number
  tokensIn: number
  tokensOut: number
  /** Requests per minute observed over the last minute. */
  requestsPerMinute: number
  /** Masked id of the key currently serving traffic (never the secret). */
  activeKey: string | null
  /** Model actually used after fallback. */
  model: string | null
  /** Epoch ms until which every key is cooling down, null = none. */
  waitingUntil: number | null
  /** Reason code while waiting (`QUOTA_EXHAUSTED` / `ALL_KEYS_COOLING_DOWN`). */
  waitingReason: 'QUOTA_EXHAUSTED' | 'ALL_KEYS_COOLING_DOWN' | null
  /** Estimated ms remaining for the whole run, null when unknown. */
  etaMs: number | null
  startedAt: number
}

export type TranslatePhase =
  'idle' | 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'cancelled'

export const EMPTY_PROGRESS: TranslateProgress = {
  phase: 'idle',
  alreadyDone: 0,
  done: 0,
  total: 0,
  failed: 0,
  pageIndex: null,
  pageDone: 0,
  pageTotal: 0,
  requests: 0,
  retries: 0,
  tokensIn: 0,
  tokensOut: 0,
  requestsPerMinute: 0,
  activeKey: null,
  model: null,
  waitingUntil: null,
  waitingReason: null,
  etaMs: null,
  startedAt: 0,
}

/** Coverage report shown when a run finishes (or is inspected mid-run). */
export interface CoverageReport {
  projectId: string
  translated: number
  total: number
  flagged: number
  failed: number
  /** 0..100 average confidence over the translated lines. */
  qualityScore: number
  perPage: PageCoverage[]
  /**
   * Merge integrity for the same scope (Layer 7).
   *
   * "No missing or duplicated content" is *verified* here rather than assumed —
   * recomputed from Dexie with the very rules that decided what to translate.
   */
  integrity: IntegrityReport
}

/**
 * Layer 7 — what the merge actually produced, checked after the queue settles.
 *
 * Both lists are empty exactly when the document is whole. Any `missing` id is
 * already `pending` in Dexie, so the next run re-plans and re-translates it
 * automatically — this makes the gap *visible* instead of silent.
 */
export interface IntegrityReport {
  ok: boolean
  /** In-scope blocks counted in the plan (translated or not). */
  checked: number
  /** In-scope blocks that never received a translation. */
  missing: string[]
  /** Block ids that appeared in more than one batch (would cost the quota twice). */
  duplicated: string[]
}

export interface PageCoverage {
  pageIndex: number
  translated: number
  total: number
  flagged: number
  /** 0..100, null when the page has nothing translated yet. */
  score: number | null
}

export interface GlossarySpec {
  sourceTerm: string
  targetTerm: string
  caseSensitive: boolean
}

export interface PromptContext {
  /** Previous translated/source line of the same page (Medium and up). */
  before: string
  /** Next source line of the same page. */
  after: string
  /**
   * Nearest heading *above* this batch — the section its lines belong to.
   *
   * A batch is only ~25 lines, so without this the model has no idea which part
   * of the document it is in; a heading that led the previous batch is a whole
   * request away. Costs ~10 tokens and buys most of the consistency a much
   * larger neighbour window would.
   */
  section?: string
  /** That heading's translation, when it is already known (a resumed run). */
  sectionTranslation?: string
}

export interface QualitySpec {
  level: QualityLevel
  temperature: number
  /** Extra verification pass (High). */
  review: boolean
  /** Neighbouring lines are included as context (Medium and up). */
  context: boolean
  glossary: boolean
  tier: QualityTier
}

export interface EngineEvent {
  type: 'request' | 'retry' | 'rate-limit' | 'model-fallback' | 'waiting' | 'validated'
  batchId: string
  detail: string
  at: number
}
