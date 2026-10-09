/**
 * `phaseFor` decides which phase the translate page renders — and therefore
 * which of Pause / Resume / Cancel it offers.
 *
 * The regression this file exists to stop: a run that was paused *during* a
 * rate-limit cooldown kept reporting `waiting`, because the cooldown check ran
 * before the queue phase. The panel then showed a Pause button that silently
 * did nothing (`JobQueue.pause()` refuses to pause twice) and never showed
 * Resume — the user's report was "I have to press them repeatedly".
 */

import { describe, expect, it } from 'vitest'
import { phaseFor } from './translateQueue'

const NOW = 1_700_000_000_000
const COOLING = NOW + 60_000

describe('phaseFor', () => {
  it('reports a live cooldown as waiting while the queue is running', () => {
    expect(phaseFor({ queuePhase: 'running', waitingUntil: COOLING, now: NOW })).toBe('waiting')
  })

  it('reports running once the cooldown has passed', () => {
    expect(phaseFor({ queuePhase: 'running', waitingUntil: NOW - 1, now: NOW })).toBe('running')
    expect(phaseFor({ queuePhase: 'running', waitingUntil: null, now: NOW })).toBe('running')
  })

  it('lets a paused queue outrank a cooldown that is still ticking', () => {
    // The clock does not stop when the run is paused, so the cooldown survives
    // the pause. Reporting `waiting` here is what dead-ends the controls.
    expect(phaseFor({ queuePhase: 'paused', waitingUntil: COOLING, now: NOW })).toBe('paused')
    expect(phaseFor({ queuePhase: 'paused', waitingUntil: null, now: NOW })).toBe('paused')
  })

  it('lets a cancelled queue outrank a cooldown that is still ticking', () => {
    expect(phaseFor({ queuePhase: 'cancelled', waitingUntil: COOLING, now: NOW })).toBe('cancelled')
  })

  it('lets a finished queue outrank a leftover cooldown', () => {
    expect(phaseFor({ queuePhase: 'done', waitingUntil: COOLING, now: NOW })).toBe('done')
  })

  it('lets a failed queue outrank a cooldown', () => {
    expect(phaseFor({ queuePhase: 'failed', waitingUntil: COOLING, now: NOW })).toBe('failed')
  })

  it('always reports a run-level failure as failed', () => {
    for (const queuePhase of ['running', 'paused', 'done', 'cancelled'] as const) {
      expect(phaseFor({ queuePhase, failure: true, waitingUntil: COOLING, now: NOW })).toBe(
        'failed',
      )
    }
  })

  it('falls back to the forced phase when there is no queue at all', () => {
    expect(phaseFor({ queuePhase: null, forcedPhase: 'cancelled', now: NOW })).toBe('cancelled')
    expect(phaseFor({ queuePhase: null, now: NOW })).toBe('idle')
  })

  it('treats an idle queue as idle once nothing is pending', () => {
    expect(phaseFor({ queuePhase: 'idle', waitingUntil: COOLING, now: NOW })).toBe('waiting')
    expect(phaseFor({ queuePhase: 'idle', now: NOW })).toBe('idle')
  })
})
