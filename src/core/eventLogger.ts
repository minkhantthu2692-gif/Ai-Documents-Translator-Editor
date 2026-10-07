/**
 * Event logger.
 *
 * Every state/transition produces an AppEvent that is (a) emitted to live
 * subscribers and (b) persisted to IndexedDB off the critical path — writes are
 * chained on a queue so callers never block the main thread.
 */

import type { AppEvent, CreateEventInput } from './events'
import { createEvent } from './events'
import type { MachineEvent } from './fsm'
import type { ReasonCode, Severity } from './reasonCodes'
import { REASON_CODES } from './reasonCodes'
import { eventRepo } from '@/db/repo-events'

type Listener = (event: AppEvent) => void

const listeners = new Set<Listener>()
let persistQueue: Promise<void> = Promise.resolve()
let lastError: string | null = null

export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getLoggerError(): string | null {
  return lastError
}

/** Builds the event, notifies subscribers, queues the IndexedDB write. */
export function logEvent(input: CreateEventInput): AppEvent {
  const event = createEvent(input)
  persistQueue = persistQueue
    .then(async () => {
      await eventRepo.append(event)
    })
    .catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error)
      console.error('[events] persist failed', error)
    })

  for (const listener of Array.from(listeners)) {
    try {
      listener(event)
    } catch (error) {
      console.error('[events] listener failed', error)
    }
  }
  return event
}

/** Convenience for reason-code driven failures. */
export function logReason(code: ReasonCode | null, overrides: CreateEventInput): AppEvent {
  return logEvent({ ...overrides, reasonCode: code })
}

/** Resolves once every queued event write has settled (used by tests/shutdown). */
export function flushEvents(): Promise<void> {
  return persistQueue
}

function machineSeverity(event: MachineEvent): Severity {
  if (event.kind === 'rejected') return REASON_CODES[event.reasonCode].severity
  if (event.to === 'EXPORT_READY') return 'success'
  if (event.to === 'FAILED') return 'error'
  if (event.to === 'CANCELLED') return 'warning'
  return 'info'
}

/**
 * Maps a raw FSM event onto the app event envelope. Both languages are written
 * to the record so the Logs page can render without re-running translations.
 */
export function logMachineEvent(
  event: MachineEvent,
  context: { projectId?: string | null; jobId?: string | null } = {},
): AppEvent {
  const projectId = context.projectId ?? null
  const jobId = context.jobId ?? null

  if (event.kind === 'rejected') {
    const definition = REASON_CODES[event.reasonCode]
    return logEvent({
      state: event.from,
      action: `fsm.${event.event}.rejected`,
      reasonCode: event.reasonCode,
      severity: definition.severity,
      messageMy: definition.messageMy,
      messageEn: definition.messageEn,
      technicalDetail: event.detail,
      projectId,
      jobId,
      timestamp: event.timestamp,
    })
  }

  const action = `fsm.${event.event}`
  const messageEn = `State ${event.from} → ${event.to} (${event.event})`
  const messageMy = `အခြေအနေ ${event.from} မှ ${event.to} သို့ ပြောင်းလဲသည် (${event.event})`
  return logEvent({
    state: event.to,
    action,
    severity: machineSeverity(event),
    messageMy,
    messageEn,
    technicalDetail: `from=${event.from} to=${event.to} event=${event.event}`,
    projectId,
    jobId,
    timestamp: event.timestamp,
  })
}
