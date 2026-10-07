/**
 * Safe localStorage wrappers.
 * The raw `localStorage` global is restricted by ESLint so that every access
 * goes through these guards (private-mode Safari, quota errors, SSR, tests).
 */

export function readRaw(key: string): string | null {
  try {
    const storage = globalThis.localStorage
    return storage ? storage.getItem(key) : null
  } catch {
    return null
  }
}

export function writeRaw(key: string, value: string): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) return false
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function removeRaw(key: string): void {
  try {
    const storage = globalThis.localStorage
    storage?.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readRaw(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    return writeRaw(key, JSON.stringify(value))
  } catch {
    return false
  }
}
