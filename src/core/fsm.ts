/**
 * Pipeline finite state machine.
 *
 * Pure TypeScript — no DOM, no storage, no timers — so it is fully unit-testable.
 * Every accepted transition returns the next state, every rejected one returns a
 * reason code that the event logger can persist and the UI can explain.
 *
 * States
 *   IDLE → PREFLIGHT → READY → PARSING → (OCR) → TRANSLATING → REVIEWING →
 *   LAYOUTING → EXPORT_READY
 *   plus PAUSED, WAITING_RATE_LIMIT, FAILED, CANCELLED.
 */

import type { ReasonCode } from './reasonCodes'

export const FSM_STATES = [
  'IDLE',
  'PREFLIGHT',
  'READY',
  'PARSING',
  'OCR',
  'TRANSLATING',
  'REVIEWING',
  'LAYOUTING',
  'EXPORT_READY',
  'PAUSED',
  'WAITING_RATE_LIMIT',
  'FAILED',
  'CANCELLED',
] as const

export type FsmState = (typeof FSM_STATES)[number]

export const FSM_EVENTS = [
  'START',
  'PRECHECK_OK',
  'PRECHECK_FAIL',
  'PARSE',
  'PARSE_OK',
  'PARSE_FAIL',
  'NEED_OCR',
  'OCR_DONE',
  'OCR_FAIL',
  'TRANSLATE_OK',
  'TRANSLATE_FAIL',
  'RATE_LIMIT',
  'RETRY',
  'APPROVE',
  'REVISE',
  'LAYOUT_OK',
  'LAYOUT_FAIL',
  'PAUSE',
  'RESUME',
  'CANCEL',
  'RESET',
] as const

export type FsmEvent = (typeof FSM_EVENTS)[number]

/** Terminal states cannot be left except through an explicit RESET. */
export const TERMINAL_STATES: readonly FsmState[] = ['EXPORT_READY', 'CANCELLED', 'FAILED']

/** States in which the pipeline is actively doing work (drives progress UI). */
export const ACTIVE_STATES: readonly FsmState[] = [
  'PREFLIGHT',
  'PARSING',
  'OCR',
  'TRANSLATING',
  'WAITING_RATE_LIMIT',
  'LAYOUTING',
]

export interface FsmContext {
  /** Page carries a machine readable text layer. */
  hasTextLayer: boolean
  /** OCR must run (forced by user or implied by a missing text layer). */
  needsOcr: boolean
  /** How many automatic retries remain after a failure. */
  retryBudget: number
  /** Epoch ms until which rate-limited calls must wait. */
  rateLimitUntil: number
  /** Number of times the reviewer sent the work back for re-translation. */
  revisionCount: number
  /** State to restore when resuming from PAUSED. */
  pausedFrom: FsmState | null
  /** Reason code captured when entering FAILED. */
  failureCode: ReasonCode | null
}

export interface FsmSendPayload {
  hasTextLayer?: boolean
  needsOcr?: boolean
  retryBudget?: number
  rateLimitUntil?: number
  failureCode?: ReasonCode
}

export type GuardResult = { ok: true } | { ok: false; reasonCode: ReasonCode; detail: string }

export type GuardFn = (ctx: FsmContext, now: number) => GuardResult

interface TransitionRule {
  to: FsmState | ((ctx: FsmContext) => FsmState)
  guard?: GuardFn
  /** Applies payload/context side effects once the guard passes. */
  apply?: (ctx: FsmContext, payload: FsmSendPayload, now: number) => void
}

export type TransitionTable = Record<FsmState, Partial<Record<FsmEvent, TransitionRule>>>

const ok = (): GuardResult => ({ ok: true })

const fail = (reasonCode: ReasonCode, detail: string): GuardResult => ({
  ok: false,
  reasonCode,
  detail,
})

const guardHasTextLayer: GuardFn = (ctx) =>
  ctx.hasTextLayer
    ? ok()
    : fail('NO_TEXT_LAYER', 'PARSE_OK requires a text layer; send NEED_OCR instead.')

const guardNeedsOcr: GuardFn = (ctx) =>
  ctx.needsOcr ? fail('NO_TEXT_LAYER', 'OCR is required; send NEED_OCR instead of PARSE_OK.') : ok()

const guardRateLimitElapsed: GuardFn = (ctx, now) =>
  now >= ctx.rateLimitUntil
    ? ok()
    : fail(
        'QUOTA_EXHAUSTED',
        `Rate limit active until ${new Date(ctx.rateLimitUntil).toISOString()}.`,
      )

const guardRetryBudget: GuardFn = (ctx) =>
  ctx.retryBudget > 0
    ? ok()
    : fail('INVALID_STATE_TRANSITION', 'Retry budget exhausted; a manual reset is required.')

/**
 * Guarded transition table. Missing entries are rejected as illegal transitions.
 */
export const TRANSITION_TABLE: TransitionTable = {
  IDLE: {
    START: {
      to: 'PREFLIGHT',
      apply: (ctx, payload) => {
        ctx.failureCode = null
        ctx.pausedFrom = null
        if (payload.hasTextLayer !== undefined) ctx.hasTextLayer = payload.hasTextLayer
        if (payload.needsOcr !== undefined) ctx.needsOcr = payload.needsOcr
        if (payload.retryBudget !== undefined) ctx.retryBudget = payload.retryBudget
      },
    },
  },
  PREFLIGHT: {
    PRECHECK_OK: { to: 'READY' },
    PRECHECK_FAIL: {
      to: 'FAILED',
      apply: (ctx, payload) => {
        ctx.failureCode = payload.failureCode ?? 'PDF_CORRUPTED'
      },
    },
    PAUSE: { to: 'PAUSED', apply: (ctx) => void (ctx.pausedFrom = 'PREFLIGHT') },
    CANCEL: { to: 'CANCELLED' },
  },
  READY: {
    PARSE: { to: 'PARSING' },
    PAUSE: { to: 'PAUSED', apply: (ctx) => void (ctx.pausedFrom = 'READY') },
    CANCEL: { to: 'CANCELLED' },
    RESET: { to: 'IDLE', apply: resetContext },
  },
  PARSING: {
    NEED_OCR: {
      to: 'OCR',
      apply: (ctx, payload) => {
        ctx.needsOcr = true
        if (payload.needsOcr !== undefined) ctx.needsOcr = payload.needsOcr
      },
    },
    PARSE_OK: { to: 'TRANSLATING', guard: combineGuards(guardHasTextLayer, guardNeedsOcr) },
    PARSE_FAIL: {
      to: 'FAILED',
      apply: (ctx, payload) => {
        ctx.failureCode = payload.failureCode ?? 'PDF_CORRUPTED'
      },
    },
    PAUSE: { to: 'PAUSED', apply: (ctx) => void (ctx.pausedFrom = 'PARSING') },
    CANCEL: { to: 'CANCELLED' },
  },
  OCR: {
    OCR_DONE: { to: 'TRANSLATING', apply: (ctx) => void (ctx.needsOcr = false) },
    OCR_FAIL: {
      to: 'FAILED',
      apply: (ctx, payload) => {
        ctx.failureCode = payload.failureCode ?? 'OCR_FAILED'
      },
    },
    PAUSE: { to: 'PAUSED', apply: (ctx) => void (ctx.pausedFrom = 'OCR') },
    CANCEL: { to: 'CANCELLED' },
  },
  TRANSLATING: {
    TRANSLATE_OK: { to: 'REVIEWING' },
    TRANSLATE_FAIL: {
      to: 'FAILED',
      apply: (ctx, payload) => {
        ctx.failureCode = payload.failureCode ?? 'BAD_JSON_RESPONSE'
      },
    },
    RATE_LIMIT: {
      to: 'WAITING_RATE_LIMIT',
      apply: (ctx, payload) => {
        ctx.rateLimitUntil = payload.rateLimitUntil ?? Date.now() + 30_000
      },
    },
    PAUSE: { to: 'PAUSED', apply: (ctx) => void (ctx.pausedFrom = 'TRANSLATING') },
    CANCEL: { to: 'CANCELLED' },
  },
  WAITING_RATE_LIMIT: {
    RETRY: { to: 'TRANSLATING', guard: guardRateLimitElapsed },
    TRANSLATE_OK: { to: 'REVIEWING' },
    TRANSLATE_FAIL: {
      to: 'FAILED',
      apply: (ctx, payload) => {
        ctx.failureCode = payload.failureCode ?? 'QUOTA_EXHAUSTED'
      },
    },
    PAUSE: {
      to: 'PAUSED',
      apply: (ctx) => void (ctx.pausedFrom = 'WAITING_RATE_LIMIT'),
    },
    CANCEL: { to: 'CANCELLED' },
  },
  REVIEWING: {
    APPROVE: { to: 'LAYOUTING', apply: (ctx) => void ctx.revisionCount },
    REVISE: {
      to: 'TRANSLATING',
      apply: (ctx) => {
        ctx.revisionCount += 1
      },
    },
    PAUSE: { to: 'PAUSED', apply: (ctx) => void (ctx.pausedFrom = 'REVIEWING') },
    CANCEL: { to: 'CANCELLED' },
  },
  LAYOUTING: {
    LAYOUT_OK: { to: 'EXPORT_READY' },
    LAYOUT_FAIL: {
      to: 'FAILED',
      apply: (ctx, payload) => {
        ctx.failureCode = payload.failureCode ?? 'EXPORT_FONT_MISSING'
      },
    },
    PAUSE: { to: 'PAUSED', apply: (ctx) => void (ctx.pausedFrom = 'LAYOUTING') },
    CANCEL: { to: 'CANCELLED' },
  },
  EXPORT_READY: {
    RESET: { to: 'IDLE', apply: resetContext },
  },
  PAUSED: {
    RESUME: {
      to: (ctx) => ctx.pausedFrom ?? 'READY',
      guard: (ctx) =>
        ctx.pausedFrom && ctx.pausedFrom !== 'PAUSED'
          ? ok()
          : fail('INVALID_STATE_TRANSITION', 'No paused state recorded to resume into.'),
      apply: (ctx) => {
        ctx.rateLimitUntil = 0
        ctx.pausedFrom = null
      },
    },
    CANCEL: { to: 'CANCELLED', apply: (ctx) => void (ctx.pausedFrom = null) },
    RESET: { to: 'IDLE', apply: resetContext },
  },
  FAILED: {
    RETRY: {
      to: 'PREFLIGHT',
      guard: guardRetryBudget,
      apply: (ctx) => {
        ctx.retryBudget -= 1
        ctx.failureCode = null
      },
    },
    CANCEL: { to: 'CANCELLED' },
    RESET: { to: 'IDLE', apply: resetContext },
  },
  CANCELLED: {
    RESET: { to: 'IDLE', apply: resetContext },
  },
}

function resetContext(ctx: FsmContext): void {
  ctx.pausedFrom = null
  ctx.failureCode = null
  ctx.rateLimitUntil = 0
  ctx.needsOcr = false
  ctx.revisionCount = 0
}

function combineGuards(...guards: GuardFn[]): GuardFn {
  return (ctx, now) => {
    for (const guard of guards) {
      const result = guard(ctx, now)
      if (!result.ok) return result
    }
    return { ok: true }
  }
}

export function createFsmContext(partial: Partial<FsmContext> = {}): FsmContext {
  return {
    hasTextLayer: true,
    needsOcr: false,
    retryBudget: 3,
    rateLimitUntil: 0,
    revisionCount: 0,
    pausedFrom: null,
    failureCode: null,
    ...partial,
  }
}

export type FsmResult =
  | { ok: true; from: FsmState; event: FsmEvent; to: FsmState; changed: boolean }
  | {
      ok: false
      from: FsmState
      event: FsmEvent
      reasonCode: ReasonCode
      detail: string
    }

/** True when the table defines a rule for this (state, event) pair. */
export function canTransition(from: FsmState, event: FsmEvent): boolean {
  const rules = TRANSITION_TABLE[from]
  return Boolean(rules && rules[event])
}

/** Events currently accepted from `from` (guards are not evaluated). */
export function availableEvents(from: FsmState): FsmEvent[] {
  const rules = TRANSITION_TABLE[from] ?? {}
  return FSM_EVENTS.filter((event) => Boolean(rules[event]))
}

/**
 * Evaluates the guarded table. Mutates `ctx` only when the transition is accepted.
 * `changed` is false for self-transitions that still count as an accepted event
 * (e.g. REVISE while REVIEWING), so callers can decide whether to persist.
 */
export function transition(
  state: FsmState,
  event: FsmEvent,
  ctx: FsmContext,
  payload: FsmSendPayload = {},
  now: number = Date.now(),
): FsmResult {
  const rule = TRANSITION_TABLE[state]?.[event]
  if (!rule) {
    return {
      ok: false,
      from: state,
      event,
      reasonCode: 'INVALID_STATE_TRANSITION',
      detail: `Event "${event}" is not defined for state "${state}".`,
    }
  }

  if (rule.guard) {
    const verdict = rule.guard(ctx, now)
    if (!verdict.ok) {
      return {
        ok: false,
        from: state,
        event,
        reasonCode: verdict.reasonCode,
        detail: verdict.detail,
      }
    }
  }

  // The destination is resolved before side effects so resume() can read the
  // state that was recorded when the machine was paused.
  const target = typeof rule.to === 'function' ? rule.to(ctx) : rule.to

  if (rule.apply) rule.apply(ctx, payload, now)
  // Payload values applied after the guard so guards see the previous context.
  if (payload.hasTextLayer !== undefined) ctx.hasTextLayer = payload.hasTextLayer
  if (payload.needsOcr !== undefined) ctx.needsOcr = payload.needsOcr
  if (payload.retryBudget !== undefined) ctx.retryBudget = payload.retryBudget

  if (event === 'PAUSE' && state !== 'PAUSED') ctx.pausedFrom = state

  return { ok: true, from: state, event, to: target, changed: target !== state }
}

export interface MachineTransitionEvent {
  kind: 'transition'
  timestamp: number
  from: FsmState
  to: FsmState
  event: FsmEvent
}

export interface MachineRejectionEvent {
  kind: 'rejected'
  timestamp: number
  from: FsmState
  event: FsmEvent
  reasonCode: ReasonCode
  detail: string
}

export type MachineEvent = MachineTransitionEvent | MachineRejectionEvent
export type MachineListener = (event: MachineEvent) => void

/**
 * Thin stateful wrapper around the pure table. Subscribers receive an event for
 * every accepted and rejected transition so the logger can persist all of them.
 */
export class PipelineMachine {
  private state: FsmState
  private readonly ctx: FsmContext
  private readonly listeners = new Set<MachineListener>()

  constructor(initial: FsmState = 'IDLE', context: FsmContext = createFsmContext()) {
    this.state = initial
    this.ctx = context
  }

  getState(): FsmState {
    return this.state
  }

  getContext(): Readonly<FsmContext> {
    return this.ctx
  }

  subscribe(listener: MachineListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  available(): FsmEvent[] {
    return availableEvents(this.state)
  }

  send(event: FsmEvent, payload: FsmSendPayload = {}, now: number = Date.now()): FsmResult {
    const result = transition(this.state, event, this.ctx, payload, now)
    const timestamp = now

    if (result.ok) {
      const from = this.state
      this.state = result.to
      this.emit({ kind: 'transition', timestamp, from, to: result.to, event })
    } else {
      this.emit({
        kind: 'rejected',
        timestamp,
        from: this.state,
        event,
        reasonCode: result.reasonCode,
        detail: result.detail,
      })
    }
    return result
  }

  private emit(event: MachineEvent): void {
    for (const listener of Array.from(this.listeners)) {
      listener(event)
    }
  }
}
