/**
 * FSM glue for the translate page.
 *
 * The pipeline machine (see `core/fsm.ts`) is pure and synchronous; the queue
 * is asynchronous. This module maps queue signals onto FSM events so the
 * Status Panel always shows a state the machine can actually reach:
 *
 *   run starts       → TRANSLATING (initial state)
 *   rate limited     → RATE_LIMIT → WAITING_RATE_LIMIT (countdown)
 *   wait elapsed     → RETRY → TRANSLATING (auto-resume)
 *   all lines done   → TRANSLATE_OK → REVIEWING
 *   terminal failure → TRANSLATE_FAIL → FAILED (reason code)
 *   pause / resume / cancel → PAUSE / RESUME / CANCEL
 *
 * Exported as a tiny function so the wiring itself is unit-testable without a
 * DOM, a worker or IndexedDB.
 */

import { PipelineMachine, type FsmEvent, type FsmState } from '@/core/fsm'
import type { ReasonCode } from '@/core/reasonCodes'
import type { TranslatePhase } from './types'

export type TranslateSignal =
  | { type: 'waiting'; until: number; reason: 'QUOTA_EXHAUSTED' | 'ALL_KEYS_COOLING_DOWN' }
  | { type: 'resumed'; until?: number }
  | { type: 'paused' }
  | { type: 'resumedFromPause' }
  | { type: 'done' }
  | { type: 'failed'; reasonCode: ReasonCode }
  | { type: 'cancelled' }

/** Fresh machine parked in TRANSLATING (the state a translate run lives in). */
export function createTranslateMachine(initial: FsmState = 'TRANSLATING'): PipelineMachine {
  return new PipelineMachine(initial)
}

/**
 * Applies one signal. Returns the resulting state, or the current state when
 * the machine refused the event (never throws — a rejected transition must not
 * break a running translation).
 */
export function applySignal(
  machine: PipelineMachine,
  signal: TranslateSignal,
  now = Date.now(),
): FsmState {
  switch (signal.type) {
    case 'waiting':
      return send(machine, 'RATE_LIMIT', { rateLimitUntil: signal.until }, now)
    case 'resumed': {
      // The engine can wake a few ms before the recorded deadline; nudge `now`
      // so the elapsed guard passes instead of parking the machine forever.
      const at = Math.max(now, signal.until ?? 0)
      return send(machine, 'RETRY', {}, at)
    }
    case 'paused':
      return send(machine, 'PAUSE', {}, now)
    case 'resumedFromPause':
      return send(machine, 'RESUME', {}, now)
    case 'done':
      return send(machine, 'TRANSLATE_OK', {}, now)
    case 'failed':
      return send(machine, 'TRANSLATE_FAIL', { failureCode: signal.reasonCode }, now)
    case 'cancelled':
      return send(machine, 'CANCEL', {}, now)
    default:
      return machine.getState()
  }
}

function send(
  machine: PipelineMachine,
  event: FsmEvent,
  payload: { rateLimitUntil?: number; failureCode?: ReasonCode },
  now: number,
): FsmState {
  const result = machine.send(event, payload, now)
  return result.ok ? result.to : machine.getState()
}

/**
 * Store phase → signal. The page calls this on every phase change so the
 * Status Panel follows the queue without polling it.
 *
 * `waiting` (and the wake-up that follows it) carries a deadline, so the page
 * builds those two signals itself and hands everything else to this helper.
 */
export function signalForPhase(
  phase: TranslatePhase,
  previous: TranslatePhase | null,
  reasonCode: ReasonCode = 'ALL_KEYS_COOLING_DOWN',
): TranslateSignal | null {
  if (phase === previous) return null
  switch (phase) {
    case 'paused':
      return { type: 'paused' }
    case 'cancelled':
      return { type: 'cancelled' }
    case 'done':
      return { type: 'done' }
    case 'failed':
      return { type: 'failed', reasonCode }
    case 'running':
      return previous === 'paused' ? { type: 'resumedFromPause' } : null
    default:
      return null
  }
}
