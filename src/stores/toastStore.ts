/** Toast notifications rendered in an aria-live region. */

import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastItem {
  id: string
  tone: ToastTone
  title: string
  description?: string
  durationMs: number
  action?: { label: string; onClick: () => void }
}

interface ToastState {
  toasts: ToastItem[]
  push: (toast: Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number }) => string
  dismiss: (id: string) => void
  clear: () => void
}

let toastCounter = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    toastCounter += 1
    const id = `toast_${toastCounter}`
    const item: ToastItem = {
      durationMs: toast.durationMs ?? 4500,
      ...toast,
      id,
    }
    set((state) => ({ toasts: [...state.toasts, item].slice(-5) }))
    if (item.durationMs > 0 && typeof window !== 'undefined') {
      window.setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) }))
      }, item.durationMs)
    }
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

/** Convenience helper for pages/components. */
export function toast(
  tone: ToastTone,
  title: string,
  description?: string,
  action?: ToastItem['action'],
): string {
  return useToastStore.getState().push({ tone, title, description, action })
}
