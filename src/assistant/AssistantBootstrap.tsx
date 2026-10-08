/**
 * Headless assistant controller mounted once in the AppShell.
 *
 * Captures uncaught errors and rejected promises into `errorMemory` so the
 * assistant can explain "what just happened" even when it is opened later,
 * from a different page. Nothing is persisted here — the durable copy of
 * every failure is the Logs table.
 */

import { useEffect } from 'react'
import { errorMemory } from './errorMemory'

export function AssistantBootstrap() {
  useEffect(() => {
    function onError(event: ErrorEvent): void {
      const message = event.message || String(event.error ?? 'unknown error')
      const name = event.error instanceof Error ? event.error.name : null
      errorMemory.remember(name, message)
    }
    function onRejection(event: PromiseRejectionEvent): void {
      const reason = event.reason
      if (reason instanceof Error) errorMemory.remember(reason.name, reason.message)
      else errorMemory.remember('unhandledrejection', String(reason))
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}
