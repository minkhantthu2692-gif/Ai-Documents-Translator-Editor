/**
 * Application event envelope.
 *
 * Every meaningful state/transition in the app emits one of these:
 * {timestamp, state, pageIndex, lineIndex, reasonCode, messageMy, messageEn,
 *  technicalDetail, fixActions[]} plus provenance fields for sync/backup.
 */

import type { FixAction, ReasonCode, Severity } from './reasonCodes'
import { REASON_CODES } from './reasonCodes'
import type { FsmState } from './fsm'
import { createId, getDeviceId } from './id'

/** `state` is the pipeline state, or a lifecycle pseudo-state for app-level events. */
export type EventState = FsmState | 'APP' | 'SETTINGS' | 'PROJECT' | 'SYNC' | 'BACKUP'

export const EVENT_SCHEMA_VERSION = 1

export interface AppEvent {
  id: string
  schemaVersion: number
  /** Epoch ms when the event happened. */
  timestamp: number
  state: EventState
  pageIndex: number | null
  lineIndex: number | null
  reasonCode: ReasonCode | null
  severity: Severity
  /** Burmese message (always present, even for info events). */
  messageMy: string
  /** English message (always present). */
  messageEn: string
  technicalDetail: string
  fixActions: FixAction[]
  projectId: string | null
  jobId: string | null
  /** Free-form grouping key, e.g. "theme.changed". */
  action: string | null
  createdAt: number
  updatedAt: number
  deviceId: string
  version: number
}

export interface CreateEventInput {
  state: EventState
  action?: string
  reasonCode?: ReasonCode | null
  severity?: Severity
  messageMy?: string
  messageEn?: string
  technicalDetail?: string
  pageIndex?: number | null
  lineIndex?: number | null
  projectId?: string | null
  jobId?: string | null
  fixActions?: FixAction[]
  timestamp?: number
}

/**
 * Builds an event. When a reasonCode is supplied and no explicit messages are
 * given, the bilingual messages come straight from the catalogue.
 */
export function createEvent(input: CreateEventInput): AppEvent {
  const now = input.timestamp ?? Date.now()
  const code = input.reasonCode ?? null
  const definition = code ? REASON_CODES[code] : null

  const severity = input.severity ?? definition?.severity ?? 'info'
  const messageMy = input.messageMy ?? definition?.messageMy ?? ''
  const messageEn = input.messageEn ?? definition?.messageEn ?? ''
  const fixActions = input.fixActions ?? definition?.fixActions ?? []

  return {
    id: createId('evt'),
    schemaVersion: EVENT_SCHEMA_VERSION,
    timestamp: now,
    state: input.state,
    pageIndex: input.pageIndex ?? null,
    lineIndex: input.lineIndex ?? null,
    reasonCode: code,
    severity,
    messageMy,
    messageEn,
    technicalDetail: input.technicalDetail ?? definition?.technicalHint ?? '',
    fixActions,
    projectId: input.projectId ?? null,
    jobId: input.jobId ?? null,
    action: input.action ?? null,
    createdAt: now,
    updatedAt: now,
    deviceId: getDeviceId(),
    version: 1,
  }
}
