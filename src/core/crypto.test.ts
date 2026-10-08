import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeSealed, encodeSealed, openText, readDeviceSecret, sealText } from './crypto'

const SECRET_STORAGE_KEY = 'aidt.keySecret'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(SECRET_STORAGE_KEY)
})

describe('readDeviceSecret', () => {
  it('returns null before anything was sealed and does not create one', () => {
    expect(localStorage.getItem(SECRET_STORAGE_KEY)).toBeNull()
    expect(readDeviceSecret()).toBeNull()
    expect(localStorage.getItem(SECRET_STORAGE_KEY)).toBeNull()
  })

  it('returns the secret that sealing just created', async () => {
    await sealText('gsk_example', undefined)
    const secret = readDeviceSecret()
    expect(secret).toBeTruthy()
    expect(secret!.length).toBeGreaterThanOrEqual(32)
  })
})

describe('worker-style unsealing (no localStorage, like the translation worker)', () => {
  it('fails without an explicit device secret and succeeds with one', async () => {
    const payload = await sealText('gsk_example', undefined)
    const rowCipher = encodeSealed(payload)
    const deviceSecret = readDeviceSecret()
    expect(deviceSecret).toBeTruthy()

    // Storage is Window-only: stub it away to reproduce the worker context.
    vi.stubGlobal('localStorage', undefined)
    expect(readDeviceSecret()).toBeNull()

    // Without the secret shipped over postMessage the worker derives a fresh
    // random secret and the AES-GCM decrypt fails (the NO_API_KEY bug).
    await expect(openText(decodeSealed(rowCipher), undefined)).rejects.toThrow()

    // With the secret the main thread passes along, the row opens.
    await expect(openText(decodeSealed(rowCipher), deviceSecret ?? undefined)).resolves.toBe(
      'gsk_example',
    )
  })

  it('prefers the vault passphrase over the device secret', async () => {
    const payload = await sealText('gsk_example', 'vault-pass')
    vi.stubGlobal('localStorage', undefined)
    await expect(openText(payload, 'vault-pass')).resolves.toBe('gsk_example')
    await expect(openText(payload, 'wrong-pass')).rejects.toThrow()
  })
})
