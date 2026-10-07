import { useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { settingsRepo } from '@/db/repo-settings'

/**
 * Reads a persisted setting live from Dexie and returns a memoised writer.
 * The whole settings table is a single store, so writes are cheap.
 */
export function useSetting<T>(key: string, fallback: T): [T, (value: T) => Promise<void>, boolean] {
  const value = useLiveQuery(() => settingsRepo.get<T>(key, fallback), [key, fallback])
  const write = useCallback(
    async (next: T) => {
      const group = key.includes('.') ? key.split('.')[0] : 'general'
      await settingsRepo.set(key, next, group)
    },
    [key],
  )
  return [value ?? fallback, write, value === undefined]
}
