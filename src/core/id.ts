/**
 * Stable identifier and device helpers.
 * Every record carries id / deviceId / updatedAt / version so that local edits,
 * backups and (later) cloud sync can be reconciled without ambiguity.
 */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
    return bytes
  }
  // Deterministic-enough fallback for environments without WebCrypto (tests only).
  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

/** Monotonic, sortable, collision-resistant id: <time base36>-<random>. */
export function createId(prefix = ''): string {
  const time = Date.now().toString(36).padStart(9, '0')
  let random = ''
  const bytes = randomBytes(10)
  for (let i = 0; i < bytes.length; i += 1) {
    random += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  }
  return prefix ? `${prefix}_${time}${random}` : `${time}${random}`
}

const DEVICE_ID_KEY = 'aidt.deviceId'

function readLocalStorage(key: string): string | null {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — device id simply lives for the session */
  }
}

let cachedDeviceId: string | null = null

/**
 * Returns the stable id of this browser profile, creating it on first use.
 * Used for sync reconciliation and event provenance.
 */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  const existing = readLocalStorage(DEVICE_ID_KEY)
  if (existing && existing.length > 8) {
    cachedDeviceId = existing
    return cachedDeviceId
  }
  const generated = `dev_${createId()}`
  writeLocalStorage(DEVICE_ID_KEY, generated)
  cachedDeviceId = generated
  return generated
}

/** Test seam: forget the memoised device id (used by unit tests). */
export function resetDeviceIdCache(): void {
  cachedDeviceId = null
}
