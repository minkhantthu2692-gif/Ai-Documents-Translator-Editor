/**
 * Translation worker protocol.
 *
 * The main thread owns Dexie, the queue and the UI; the worker owns the key
 * pool, the provider HTTP calls, prompt building, validation and terminology.
 * Only structured-cloneable data crosses the boundary, and the API keys travel
 * **sealed** (the worker opens them with WebCrypto) so a secret never exists in
 * main-thread memory or in a console message.
 *
 * One `run` message → one terminal message (`result` / `failed` / `cancelled`),
 * correlated by `id`. `tick` and `waiting` messages arrive in between.
 */

import type { ReasonCode } from '@/core/reasonCodes'
import type { ApiKeyRecord } from '@/db/types'
import type { PersistedKeyState } from './keyPool'
import type {
  BatchRunResult,
  GlossarySpec,
  PromptContext,
  TranslationBatch,
  TranslateRunConfig,
} from './types'

export type WaitingReason = 'ALL_KEYS_COOLING_DOWN' | 'QUOTA_EXHAUSTED'

export interface KeyLimits {
  rpm: number
  tpm: number
  rpd: number
}

/** Everything a session needs to translate one batch. */
export interface RunMessage {
  kind: 'run'
  id: string
  sessionId: string
  config: TranslateRunConfig
  /** Ordered model chain: selected model first, then the fallback list. */
  models: string[]
  limits: KeyLimits
  batch: TranslationBatch
  glossary: GlossarySpec[]
  context: PromptContext | null
  /** Terms already annotated on this page (terminology scope `first`). */
  seenPage: string[]
  /** Only sent when the scope is `document` (it can be large). */
  seenDocument: string[]
}

export interface OpenMessage {
  kind: 'open'
  id: string
  sessionId: string
  config: TranslateRunConfig
  models: string[]
  limits: KeyLimits
  /** Sealed key rows — plaintext is derived inside the worker only. */
  keys: ApiKeyRecord[]
  /** Session passphrase for vault-protected keys (memory only, never stored). */
  passphrase?: string | null
  /**
   * Device secret for device-bound rows (memory only, never stored). Workers
   * cannot read localStorage, so the main thread ships it with the sealed rows.
   */
  deviceSecret?: string | null
}

export interface CancelMessage {
  kind: 'cancel'
  id: string
}

export interface CloseMessage {
  kind: 'close'
}

export type MainToWorker = OpenMessage | RunMessage | CancelMessage | CloseMessage

export interface OpenedMessage {
  kind: 'opened'
  id: string
  keyCount: number
}

/** One completed provider round trip (drives req/min, tokens, active key). */
export interface TickMessage {
  kind: 'tick'
  id: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  model: string
  keyId: string
  maskedKey: string
  requests: number
}

export interface WaitingMessage {
  kind: 'waiting'
  id: string
  until: number
  reason: WaitingReason
}

export interface ResumedMessage {
  kind: 'resumed'
  id: string
  /** Epoch ms of the request that just left after waiting. */
  at: number
}

export interface ResultMessage {
  kind: 'result'
  id: string
  result: BatchRunResult
  /** Pool state to write back to IndexedDB (cooldowns, counters, buckets). */
  states: PersistedKeyState[]
  /**
   * Terminology sets *after* the batch (they are mutated while it runs).
   * The queue merges them back so the next batch of the page knows which
   * terms were already annotated — that is what makes "first occurrence per
   * page" hold across batches.
   */
  seenPage: string[]
  seenDocument: string[]
}

export interface FailedMessage {
  kind: 'failed'
  id: string
  reasonCode: ReasonCode
  message: string
  states: PersistedKeyState[]
}

export interface CancelledMessage {
  kind: 'cancelled'
  id: string
  states: PersistedKeyState[]
}

export type WorkerToMain =
  | OpenedMessage
  | TickMessage
  | WaitingMessage
  | ResumedMessage
  | ResultMessage
  | FailedMessage
  | CancelledMessage

/** Reason codes the worker can surface (kept here so both sides agree). */
export const RUNNER_REASON_CODES = [
  'NO_API_KEY',
  'INVALID_KEY',
  'ALL_KEYS_COOLING_DOWN',
  'QUOTA_EXHAUSTED',
  'NETWORK_OFFLINE',
  'MODEL_UNAVAILABLE',
  'BAD_JSON_RESPONSE',
  'PROVIDER_NOT_CONFIGURED',
] as const

export type RunnerReasonCode = (typeof RUNNER_REASON_CODES)[number]

export interface RunnerTick {
  tokensIn: number
  tokensOut: number
  latencyMs: number
  model: string
  keyId: string
  maskedKey: string
  requests: number
}

export interface RunnerWait {
  until: number
  reason: WaitingReason
}

export interface RunnerHooks {
  onTick?: (tick: RunnerTick) => void
  onWaiting?: (wait: RunnerWait) => void
  onResumed?: () => void
  /** Pool state after a terminal message — persist it (cooldowns, buckets). */
  onStates?: (states: PersistedKeyState[]) => void
}

export interface RunnerSession {
  sessionId: string
  config: TranslateRunConfig
  models: string[]
  limits: KeyLimits
  keys: ApiKeyRecord[]
  /** Vault passphrase (memory only) — needed to open sealed rows. */
  passphrase?: string | null
  /** Device secret (memory only) — opens device-bound rows in the worker. */
  deviceSecret?: string | null
}

export interface RunnerRequest extends RunnerSession {
  id: string
  batch: TranslationBatch
  glossary: GlossarySpec[]
  context: PromptContext | null
  seenPage: string[]
  seenDocument: string[]
}

export interface RunnerOutcome {
  result: BatchRunResult
  states: PersistedKeyState[]
  /** Terminology sets after the run (mutated by the engine). */
  seenPage: string[]
  seenDocument: string[]
}

/** Test seam: the queue talks to this, not to `Worker` directly. */
export interface TranslateRunner {
  open(session: RunnerSession): Promise<void>
  run(request: RunnerRequest, hooks?: RunnerHooks): Promise<RunnerOutcome>
  cancel(id: string): void
  cancelAll(): void
  close(): void
}
