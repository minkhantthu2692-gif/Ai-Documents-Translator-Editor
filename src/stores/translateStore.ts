/**
 * Translate-page state (Phase 3).
 *
 * The queue writes here after every batch and on every provider round trip;
 * the page reads it and renders the live progress panel. Deliberately
 * data-only: the FSM, the queue and the coverage report live elsewhere, so
 * this store stays a plain, synchronously-readable mirror.
 */

import { create } from 'zustand'
import type { QueuePhase } from '@/core/jobQueue'
import type { ReasonCode } from '@/core/reasonCodes'
import type { PersistedKeyState } from '@/translate/keyPool'
import { EMPTY_PROGRESS, type TranslateProgress } from '@/translate/types'

export interface TranslateFailure {
  reasonCode: ReasonCode
  message: string
}

interface TranslateState {
  /** Project the current progress belongs to (null = no run started here). */
  projectId: string | null
  /** Queue phase (idle / running / paused / done / failed / cancelled). */
  phase: QueuePhase | null
  progress: TranslateProgress
  /** Masked key pool state, updated after every batch. */
  keyStates: PersistedKeyState[]
  /** Non-null while a terminal reason blocks the run ("Fix & Resume"). */
  failure: TranslateFailure | null
  /** Lines counted before the run started (resume after refresh). */
  restored: boolean

  begin: (projectId: string, total: number, alreadyDone: number) => void
  setPhase: (phase: QueuePhase) => void
  setProgress: (progress: TranslateProgress) => void
  patchProgress: (patch: Partial<TranslateProgress>) => void
  setKeyStates: (states: PersistedKeyState[]) => void
  setFailure: (failure: TranslateFailure) => void
  clearFailure: () => void
  reset: () => void
}

export const useTranslateStore = create<TranslateState>()((set) => ({
  projectId: null,
  phase: null,
  progress: EMPTY_PROGRESS,
  keyStates: [],
  failure: null,
  restored: false,

  begin: (projectId, total, alreadyDone) =>
    set({
      projectId,
      phase: null,
      restored: alreadyDone > 0,
      failure: null,
      keyStates: [],
      progress: {
        ...EMPTY_PROGRESS,
        total,
        alreadyDone,
        startedAt: Date.now(),
        phase: 'idle',
      },
    }),

  setPhase: (phase) => set({ phase }),

  setProgress: (progress) => set({ progress }),

  patchProgress: (patch) => set((state) => ({ progress: { ...state.progress, ...patch } })),

  setKeyStates: (states) => set({ keyStates: states }),

  setFailure: (failure) =>
    set((state) => ({ failure, progress: { ...state.progress, phase: 'failed' } })),

  clearFailure: () => set({ failure: null }),

  reset: () =>
    set({
      projectId: null,
      phase: null,
      progress: EMPTY_PROGRESS,
      keyStates: [],
      failure: null,
      restored: false,
    }),
}))

/** Selector helpers (stable references keep re-renders sane). */
export function selectProgress(state: TranslateState): TranslateProgress {
  return state.progress
}

export function selectPhase(state: TranslateState): QueuePhase | null {
  return state.phase
}
