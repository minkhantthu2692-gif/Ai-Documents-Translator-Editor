/**
 * WebCrypto AES-GCM sealing for API keys.
 *
 * Rules enforced here:
 *  - Keys are never stored, logged or exported in plaintext.
 *  - The encryption key is derived with PBKDF2-SHA256 from a per-device secret
 *    that only lives in this browser profile (or from a caller password).
 *  - Each seal uses a fresh random salt and 96-bit IV.
 */

import { readRaw, removeRaw, writeRaw } from '@/lib/storage'

const SECRET_KEY = 'aidt.keySecret'
const KDF_ITERATIONS = 150_000
const VERSION = 1

export interface SealedPayload {
  v: number
  kdf: 'PBKDF2-SHA256'
  iterations: number
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  /** base64 ciphertext */
  data: string
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function getDeviceSecret(): string {
  const existing = readRaw(SECRET_KEY)
  if (existing && existing.length >= 32) return existing
  const generated = toBase64(randomBytes(32)) + toBase64(randomBytes(16))
  writeRaw(SECRET_KEY, generated)
  return generated
}

/** Destroys the device key material (used by "delete all local data"). */
export function destroyDeviceSecret(): void {
  removeRaw(SECRET_KEY)
}

/**
 * Read-only view of this profile's device secret — never creates one.
 *
 * The main thread hands it to the translation worker over postMessage when a
 * run opens, because the Storage API is Window-only: a worker cannot read
 * `localStorage` and would otherwise derive keys from a freshly generated
 * (wrong) secret, silently failing to open every device-bound row.
 */
export function readDeviceSecret(): string | null {
  return readRaw(SECRET_KEY)
}

function subtle(): SubtleCrypto {
  const value = crypto?.subtle
  if (!value) throw new Error('WebCrypto SubtleCrypto is unavailable in this context')
  return value
}

async function deriveKey(
  material: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const source = await subtle().importKey(
    'raw',
    new TextEncoder().encode(material),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    source,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypts UTF-8 text. `password` overrides the per-device secret. */
export async function sealText(plaintext: string, password?: string): Promise<SealedPayload> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(password ?? getDeviceSecret(), salt, KDF_ITERATIONS)
  const cipher = await subtle().encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return {
    v: VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
  }
}

/** Decrypts a payload produced by sealText. Throws on tampering or wrong password. */
export async function openText(payload: SealedPayload, password?: string): Promise<string> {
  if (payload.v !== VERSION) throw new Error(`Unsupported seal version: ${payload.v}`)
  const key = await deriveKey(
    password ?? getDeviceSecret(),
    fromBase64(payload.salt),
    payload.iterations,
  )
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.data),
  )
  return new TextDecoder().decode(plain)
}

/** Serialises a sealed payload to the single string stored in Dexie. */
export function encodeSealed(payload: SealedPayload): string {
  return JSON.stringify(payload)
}

export function decodeSealed(value: string): SealedPayload {
  const parsed = JSON.parse(value) as SealedPayload
  if (!parsed || typeof parsed.data !== 'string' || typeof parsed.iv !== 'string') {
    throw new Error('Malformed sealed payload')
  }
  return parsed
}
