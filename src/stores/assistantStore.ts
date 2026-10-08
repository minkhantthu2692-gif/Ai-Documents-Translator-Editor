/**
 * Zustand store backing the Troubleshooting Assistant dialog.
 *
 * `ask()` builds the redacted context, then goes through the proxy client,
 * which itself falls back to the offline rules — so the store only ever sees
 * a successful answer or a hard local error.
 */

import { create } from 'zustand'
import { askAssistant } from '@/assistant/client'
import { buildContext } from '@/assistant/context'
import type {
  AssistantAnswer,
  AssistantContext,
  AssistantLang,
  AssistantMode,
} from '@/assistant/types'
import { useUiStore } from './uiStore'

interface AssistantStoreState {
  open: boolean
  question: string
  answer: AssistantAnswer | null
  mode: AssistantMode | null
  model: string | null
  /** Set when mode is 'offline' (proxy missing/failed). */
  fallbackReason: string | null
  busy: boolean
  error: string | null
  /** Context overrides for the next ask (Logs page passes the event's code). */
  seed: Partial<AssistantContext> | null

  openDialog: (seed?: Partial<AssistantContext>) => void
  closeDialog: () => void
  reset: () => void
  setQuestion: (value: string) => void
  ask: () => Promise<void>
}

function currentLang(): AssistantLang {
  const language = useUiStore.getState().language
  return language === 'my' ? 'my' : 'en'
}

export const useAssistantStore = create<AssistantStoreState>((set, get) => ({
  open: false,
  question: '',
  answer: null,
  mode: null,
  model: null,
  fallbackReason: null,
  busy: false,
  error: null,
  seed: null,

  openDialog: (seed) => {
    set({ open: true, seed: seed ?? null })
  },

  closeDialog: () => set({ open: false }),

  reset: () =>
    set({ answer: null, mode: null, model: null, fallbackReason: null, error: null, seed: null }),

  setQuestion: (value) => set({ question: value }),

  ask: async () => {
    const state = get()
    if (state.busy) return
    set({ busy: true, error: null })
    try {
      const context = await buildContext(state.seed ?? {})
      const result = await askAssistant({
        question: state.question,
        context,
        lang: currentLang(),
      })
      set({
        answer: result.answer,
        mode: result.mode,
        model: result.model,
        fallbackReason: result.fallbackReason,
        busy: false,
      })
    } catch (err) {
      set({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}))
