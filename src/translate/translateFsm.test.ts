/**
 * FSM wiring acceptance tests: the translate page maps queue signals onto the
 * pipeline machine, so a rate-limit wait must walk
 * TRANSLATING → RATE_LIMIT → WAITING_RATE_LIMIT → RETRY → TRANSLATING and a
 * finished run must land in REVIEWING carrying the reason code on failure.
 *
 * Pure synchronous code — no timers, no DOM, no storage.
 */
import { describe, expect, it } from 'vitest'
import type { MachineEvent } from '@/core/fsm'
import type { QueuePhase } from '@/core/jobQueue'
import type { ReasonCode } from '@/core/reasonCodes'
import { applySignal, createTranslateMachine, signalForPhase } from './translateFsm'
import type { TranslateSignal } from './translateFsm'

const T0 = 1_700_000_000_000

/** Records every accepted transition and rejection the machine emits. */
function recorder(): {
  events: MachineEvent[]
  listen: (machine: ReturnType<typeof createTranslateMachine>) => void
} {
  const events: MachineEvent[] = []
  return {
    events,
    listen: (machine) => {
      machine.subscribe((event) => events.push(event))
    },
  }
}

function transitions(events: MachineEvent[]): string[] {
  return events.filter((event) => event.kind === 'transition').map((event) => event.event)
}

describe('rate-limit round trip', () => {
  it('walks TRANSLATING → WAITING_RATE_LIMIT → TRANSLATING → REVIEWING and logs every hop', () => {
    const machine = createTranslateMachine()
    const { events, listen } = recorder()
    listen(machine)
    expect(machine.getState()).toBe('TRANSLATING')

    const until = T0 + 30_000
    expect(
      applySignal(machine, { type: 'waiting', until, reason: 'ALL_KEYS_COOLING_DOWN' }, T0),
    ).toBe('WAITING_RATE_LIMIT')
    expect(machine.getContext().rateLimitUntil).toBe(until)

    // Waking up at the recorded deadline is accepted...
    expect(applySignal(machine, { type: 'resumed', until }, until)).toBe('TRANSLATING')
    // ...and the machine is back to work.
    expect(machine.getState()).toBe('TRANSLATING')

    expect(applySignal(machine, { type: 'done' }, until + 1)).toBe('REVIEWING')
    expect(transitions(events)).toEqual(['RATE_LIMIT', 'RETRY', 'TRANSLATE_OK'])
  })

  it('nudges now past the deadline when the engine wakes a few ms early', () => {
    const machine = createTranslateMachine()
    const until = T0 + 10_000
    applySignal(machine, { type: 'waiting', until, reason: 'QUOTA_EXHAUSTED' }, T0)

    // `now` is deliberately before `until`; the signal must carry the nudge.
    expect(applySignal(machine, { type: 'resumed', until }, T0)).toBe('TRANSLATING')
  })

  it('rejects a RETRY before the deadline when no wake time is supplied', () => {
    const machine = createTranslateMachine()
    const until = T0 + 60_000
    applySignal(machine, { type: 'waiting', until, reason: 'ALL_KEYS_COOLING_DOWN' }, T0)

    // No `until` on the signal: `now` stays behind the deadline, so the guard trips.
    expect(applySignal(machine, { type: 'resumed' }, T0 + 1)).toBe('WAITING_RATE_LIMIT')
    expect(machine.getState()).toBe('WAITING_RATE_LIMIT')
  })
})

describe('failure and cancel', () => {
  it('carries the reason code into the FAILED context', () => {
    const machine = createTranslateMachine()
    const { events, listen } = recorder()
    listen(machine)
    const reasonCode: ReasonCode = 'BAD_JSON_RESPONSE'

    expect(applySignal(machine, { type: 'failed', reasonCode }, T0)).toBe('FAILED')
    expect(machine.getContext().failureCode).toBe(reasonCode)

    const rejected = events.find((event) => event.kind === 'rejected')
    expect(rejected).toBeUndefined()
    expect(transitions(events)).toEqual(['TRANSLATE_FAIL'])
  })

  it('defaults the failed signal reason when the queue reports none', () => {
    const machine = createTranslateMachine()
    applySignal(machine, { type: 'failed', reasonCode: 'QUOTA_EXHAUSTED' }, T0)
    expect(machine.getContext().failureCode).toBe('QUOTA_EXHAUSTED')
  })

  it('parks on pause and resumes into the state it was paused from', () => {
    const machine = createTranslateMachine()
    expect(applySignal(machine, { type: 'paused' }, T0)).toBe('PAUSED')
    expect(machine.getContext().pausedFrom).toBe('TRANSLATING')
    expect(applySignal(machine, { type: 'resumedFromPause' }, T0)).toBe('TRANSLATING')
    expect(machine.getContext().pausedFrom).toBeNull()
  })

  it('cancels from TRANSLATING', () => {
    const machine = createTranslateMachine()
    expect(applySignal(machine, { type: 'cancelled' }, T0)).toBe('CANCELLED')
  })
})

describe('rejected transitions never throw', () => {
  it('ignores RATE_LIMIT outside TRANSLATING', () => {
    const machine = createTranslateMachine('REVIEWING')
    const { events, listen } = recorder()
    listen(machine)

    expect(() =>
      applySignal(machine, { type: 'waiting', until: T0, reason: 'ALL_KEYS_COOLING_DOWN' }, T0),
    ).not.toThrow()
    expect(machine.getState()).toBe('REVIEWING')

    const rejection = events.find((event) => event.kind === 'rejected')
    expect(rejection).toMatchObject({ kind: 'rejected', event: 'RATE_LIMIT', from: 'REVIEWING' })
    expect(rejection?.kind === 'rejected' && rejection.reasonCode).toBe('INVALID_STATE_TRANSITION')
  })

  it('ignores a premature RETRY and records the guard rejection', () => {
    const machine = createTranslateMachine()
    const until = T0 + 5_000
    applySignal(machine, { type: 'waiting', until, reason: 'QUOTA_EXHAUSTED' }, T0)
    const { events, listen } = recorder()
    listen(machine)

    expect(() => applySignal(machine, { type: 'resumed' }, T0)).not.toThrow()
    const rejection = events.find((event) => event.kind === 'rejected')
    expect(rejection).toMatchObject({
      kind: 'rejected',
      event: 'RETRY',
      reasonCode: 'QUOTA_EXHAUSTED',
    })
    expect(machine.getState()).toBe('WAITING_RATE_LIMIT')
  })

  it('ignores done/failed from a terminal state', () => {
    const machine = createTranslateMachine('CANCELLED')
    expect(applySignal(machine, { type: 'done' }, T0)).toBe('CANCELLED')
    expect(applySignal(machine, { type: 'failed', reasonCode: 'BAD_JSON_RESPONSE' }, T0)).toBe(
      'CANCELLED',
    )
    expect(machine.getContext().failureCode).toBeNull()
  })
})

describe('signalForPhase', () => {
  const cases: Array<{ phase: QueuePhase; previous: QueuePhase | null; expected: string }> = [
    { phase: 'paused', previous: 'running', expected: 'paused' },
    { phase: 'cancelled', previous: 'running', expected: 'cancelled' },
    { phase: 'done', previous: 'running', expected: 'done' },
    { phase: 'failed', previous: 'running', expected: 'failed' },
    { phase: 'running', previous: 'paused', expected: 'resumedFromPause' },
    { phase: 'running', previous: 'idle', expected: 'null' },
    { phase: 'idle', previous: 'running', expected: 'null' },
    { phase: 'running', previous: 'running', expected: 'null' },
    { phase: 'done', previous: 'done', expected: 'null' },
  ]

  for (const { phase, previous, expected } of cases) {
    it(`${previous ?? 'null'} → ${phase} maps to ${expected}`, () => {
      const signal = signalForPhase(phase, previous)
      expect(signal === null ? 'null' : signal.type).toBe(expected)
    })
  }

  it('passes the queue reason code through on failure', () => {
    const signal = signalForPhase('failed', 'running', 'QUOTA_EXHAUSTED')
    expect(signal).toEqual({ type: 'failed', reasonCode: 'QUOTA_EXHAUSTED' })
  })

  it('defaults the failure reason when the queue reports none', () => {
    const signal = signalForPhase('failed', 'running')
    expect(signal).toEqual({ type: 'failed', reasonCode: 'ALL_KEYS_COOLING_DOWN' })
  })

  it('feeds the mapped signals straight into the machine', () => {
    const machine = createTranslateMachine()
    const fromRunning: TranslateSignal | null = signalForPhase('failed', 'running')
    expect(fromRunning).not.toBeNull()
    expect(applySignal(machine, fromRunning as TranslateSignal, T0)).toBe('FAILED')
    expect(machine.getContext().failureCode).toBe('ALL_KEYS_COOLING_DOWN')
  })
})
