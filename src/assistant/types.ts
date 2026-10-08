/**
 * Troubleshooting-assistant contracts.
 *
 * The assistant runs in one of two modes:
 *   'proxy'  — the question (plus a redacted context) is forwarded to the
 *              Node/Express or Cloudflare Worker proxy in `proxy/`, which holds
 *              the OpenRouter key server-side. The key never reaches this
 *              bundle.
 *   'offline'— a local rule-based engine answers from the reason-code
 *              catalogue, the sync error-code table and keyword rules. This is
 *              also the fallback whenever the proxy is unreachable, rate
 *              limited or misconfigured.
 */

import type { ReasonCode } from '@/core/reasonCodes'

export type AssistantLang = 'en' | 'my'
export type AssistantMode = 'proxy' | 'offline'

/**
 * One-click remediation the dialog is allowed to execute. These are the only
 * action ids the offline rules and the assistant dialog understand — the
 * proxy is instructed to use the same vocabulary.
 */
export type SafeActionId =
  | 'rotate-key'
  | 'reduce-batch'
  | 'clear-cache'
  | 'retry'
  | 'open-providers'
  | 'open-data'
  | 'open-logs'

/** One clickable remediation button rendered under the answer. */
export interface AssistantAction {
  /** Machine id, also used as `data-testid="assistant-action-<id>"`. */
  id: string
  /** Localized label (already in the requested language). */
  label: string
  kind: 'retry' | 'config' | 'data' | 'navigation' | 'external'
}

/** A plain-language explanation + ordered fix steps + safe actions. */
export interface AssistantAnswer {
  title: string
  explanation: string
  steps: string[]
  actions: AssistantAction[]
}

/**
 * Structured problem context attached to every ask. All string fields are
 * passed through `redact()` before leaving the device — API keys, tokens,
 * JWTs, long opaque blobs are replaced with `[REDACTED]`.
 */
export interface AssistantContext {
  /** Last error code seen (sync code, HTTP status or reason code). */
  errorCode: string | null
  /** App reason code from the logs when one is known. */
  reasonCode: ReasonCode | null
  /** Redacted stack / technical detail of the last failure. */
  stack: string | null
  /** State of the most recent job (queued/running/paused/failed/…). */
  jobState: string | null
  /** Selected provider and model (never the key itself). */
  provider: string | null
  model: string | null
  /** Recent warning/error log lines, oldest first, redacted and truncated. */
  recentLogs: string[]
  /** Browser one-liner: UA, language, online state, viewport. */
  browser: string
}

export interface AskInput {
  question: string
  context: AssistantContext
  lang: AssistantLang
}

export interface AskResult {
  answer: AssistantAnswer
  mode: AssistantMode
  /** Model reported by the proxy; null in offline mode. */
  model: string | null
  /** Why the proxy was not used (null when it answered). */
  fallbackReason: string | null
}

/** Client-side view of the proxy's error envelope. */
export class AssistantError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AssistantError'
    this.code = code
  }
}
