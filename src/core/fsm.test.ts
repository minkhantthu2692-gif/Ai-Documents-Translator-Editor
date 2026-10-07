import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_STATES,
  FSM_EVENTS,
  FSM_STATES,
  PipelineMachine,
  TRANSITION_TABLE,
  availableEvents,
  canTransition,
  createFsmContext,
  transition,
  type FsmEvent,
  type FsmState,
} from './fsm'

describe('transition table', () => {
  it('defines a rule for every state', () => {
    for (const state of FSM_STATES) {
      expect(TRANSITION_TABLE[state]).toBeDefined()
      expect(Object.keys(TRANSITION_TABLE[state]).length).toBeGreaterThan(0)
    }
  })

  it('only references known states and events', () => {
    for (const state of FSM_STATES) {
      for (const [event, rule] of Object.entries(TRANSITION_TABLE[state])) {
        expect(FSM_EVENTS).toContain(event as FsmEvent)
        const targets = typeof rule.to === 'function' ? [rule.to(createFsmContext())] : [rule.to]
        for (const target of targets) {
          expect(FSM_STATES).toContain(target)
        }
      }
    }
  })

  it('exposes available events per state', () => {
    expect(availableEvents('IDLE')).toEqual(['START'])
    expect(availableEvents('PREFLIGHT')).toContain('PRECHECK_OK')
    expect(canTransition('IDLE', 'PARSE')).toBe(false)
    expect(canTransition('READY', 'PARSE')).toBe(true)
  })
})

describe('happy path', () => {
  it('walks from IDLE to EXPORT_READY without OCR', () => {
    const ctx = createFsmContext({ hasTextLayer: true, needsOcr: false })
    let state: FsmState = 'IDLE'
    const path: FsmEvent[] = [
      'START',
      'PRECHECK_OK',
      'PARSE',
      'PARSE_OK',
      'TRANSLATE_OK',
      'APPROVE',
      'LAYOUT_OK',
    ]

    for (const event of path) {
      const result = transition(state, event, ctx)
      expect(result.ok, `${state} + ${event}`).toBe(true)
      if (result.ok) state = result.to
    }

    expect(state).toBe('EXPORT_READY')
  })

  it('walks through OCR when the page has no text layer', () => {
    const ctx = createFsmContext({ hasTextLayer: false, needsOcr: true })
    let state: FsmState = 'IDLE'
    const path: FsmEvent[] = [
      'START',
      'PRECHECK_OK',
      'PARSE',
      'NEED_OCR',
      'OCR_DONE',
      'TRANSLATE_OK',
      'APPROVE',
      'LAYOUT_OK',
    ]

    for (const event of path) {
      const result = transition(state, event, ctx)
      expect(result.ok, `${state} + ${event}`).toBe(true)
      if (result.ok) state = result.to
    }

    expect(state).toBe('EXPORT_READY')
    expect(ctx.needsOcr).toBe(false)
  })
})

describe('guards', () => {
  it('rejects PARSE_OK when the page has no text layer', () => {
    const ctx = createFsmContext({ hasTextLayer: false })
    const result = transition('PARSING', 'PARSE_OK', ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('NO_TEXT_LAYER')
    }
    expect(ctx.failureCode).toBeNull()
  })

  it('rejects PARSE_OK while OCR is still required', () => {
    const ctx = createFsmContext({ hasTextLayer: true, needsOcr: true })
    const result = transition('PARSING', 'PARSE_OK', ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasonCode).toBe('NO_TEXT_LAYER')
  })

  it('rejects RETRY while the rate limit is still active', () => {
    const now = 1_000_000
    const ctx = createFsmContext({ rateLimitUntil: now + 60_000 })
    const blocked = transition('WAITING_RATE_LIMIT', 'RETRY', ctx, {}, now)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reasonCode).toBe('QUOTA_EXHAUSTED')

    const allowed = transition('WAITING_RATE_LIMIT', 'RETRY', ctx, {}, now + 60_001)
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.to).toBe('TRANSLATING')
  })

  it('rejects RETRY from FAILED when the retry budget is exhausted', () => {
    const exhausted = createFsmContext({ retryBudget: 0 })
    const blocked = transition('FAILED', 'RETRY', exhausted)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reasonCode).toBe('INVALID_STATE_TRANSITION')

    const fresh = createFsmContext({ retryBudget: 2 })
    const allowed = transition('FAILED', 'RETRY', fresh)
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.to).toBe('PREFLIGHT')
    expect(fresh.retryBudget).toBe(1)
    expect(fresh.failureCode).toBeNull()
  })

  it('rejects transitions that the table does not define', () => {
    const ctx = createFsmContext()
    const result = transition('IDLE', 'LAYOUT_OK', ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('INVALID_STATE_TRANSITION')
      expect(result.detail).toContain('IDLE')
    }
  })

  it('rejects RESUME when no state was recorded for resuming', () => {
    const ctx = createFsmContext({ pausedFrom: null })
    const result = transition('PAUSED', 'RESUME', ctx)
    expect(result.ok).toBe(false)
  })
})

describe('pause, cancel and failure handling', () => {
  it('records the origin state and resumes into it', () => {
    const ctx = createFsmContext()
    const paused = transition('TRANSLATING', 'PAUSE', ctx)
    expect(paused.ok).toBe(true)
    expect(ctx.pausedFrom).toBe('TRANSLATING')

    const resumed = transition('PAUSED', 'RESUME', ctx)
    expect(resumed.ok).toBe(true)
    if (resumed.ok) expect(resumed.to).toBe('TRANSLATING')
    expect(ctx.pausedFrom).toBeNull()
  })

  it('captures a reason code when a step fails', () => {
    const ctx = createFsmContext()
    const result = transition('TRANSLATING', 'TRANSLATE_FAIL', ctx, {
      failureCode: 'NO_API_KEY',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('FAILED')
    expect(ctx.failureCode).toBe('NO_API_KEY')
  })

  it('supports cancel and reset back to IDLE', () => {
    const ctx = createFsmContext()
    const cancelled = transition('LAYOUTING', 'CANCEL', ctx)
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.to).toBe('CANCELLED')

    const reset = transition('CANCELLED', 'RESET', ctx)
    expect(reset.ok).toBe(true)
    if (reset.ok) expect(reset.to).toBe('IDLE')
  })

  it('cannot cancel from IDLE or restart from EXPORT_READY without reset', () => {
    const ctx = createFsmContext()
    expect(transition('IDLE', 'CANCEL', ctx).ok).toBe(false)
    expect(transition('EXPORT_READY', 'PARSE', ctx).ok).toBe(false)
    expect(transition('EXPORT_READY', 'RESET', ctx).ok).toBe(true)
  })

  it('knows which states are actively working', () => {
    expect(ACTIVE_STATES).toContain('TRANSLATING')
    expect(ACTIVE_STATES).not.toContain('IDLE')
    expect(ACTIVE_STATES).not.toContain('EXPORT_READY')
  })
})

describe('PipelineMachine', () => {
  it('emits an event for accepted and rejected transitions', () => {
    const machine = new PipelineMachine()
    const listener = vi.fn()
    const unsubscribe = machine.subscribe(listener)

    machine.send('START')
    machine.send('PARSE') // illegal from PREFLIGHT

    expect(machine.getState()).toBe('PREFLIGHT')
    expect(listener).toHaveBeenCalledTimes(2)

    const [first, second] = listener.mock.calls.map((call) => call[0])
    expect(first.kind).toBe('transition')
    expect(first.from).toBe('IDLE')
    expect(first.to).toBe('PREFLIGHT')
    expect(second.kind).toBe('rejected')
    expect(second.reasonCode).toBe('INVALID_STATE_TRANSITION')

    unsubscribe()
    machine.send('PRECHECK_OK')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps context and state consistent across a full run', () => {
    const machine = new PipelineMachine('IDLE', createFsmContext({ retryBudget: 1 }))
    const events: FsmEvent[] = [
      'START',
      'PRECHECK_OK',
      'PARSE',
      'PARSE_OK',
      'TRANSLATE_OK',
      'APPROVE',
      'LAYOUT_OK',
    ]
    for (const event of events) {
      expect(machine.send(event).ok, event).toBe(true)
    }
    expect(machine.getState()).toBe('EXPORT_READY')
    expect(machine.available()).toEqual(['RESET'])
    expect(machine.getContext().failureCode).toBeNull()
  })

  it('lists the currently accepted events', () => {
    const machine = new PipelineMachine()
    expect(machine.available()).toEqual(['START'])
    machine.send('START')
    expect(machine.available()).toEqual(
      expect.arrayContaining(['PRECHECK_OK', 'PRECHECK_FAIL', 'PAUSE', 'CANCEL']),
    )
  })
})
