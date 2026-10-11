import { afterEach, describe, expect, it } from 'vitest'
import { REASON_CODES } from '@/core/reasonCodes'
import { ProviderError } from '@/providers/types'
import { deviceOffline, reasonFor } from './reasons'

/** `onLine` is inherited in jsdom, so shadow it on the instance and remove it. */
function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).onLine
})

const networkFailure = () => new ProviderError('network', 'Network request failed: Failed to fetch')

describe('offline diagnosis', () => {
  it('does not accuse the device of being offline while it is online', () => {
    setOnline(true)

    const { reasonCode, message } = reasonFor(networkFailure())

    expect(deviceOffline()).toBe(false)
    expect(reasonCode).toBe('PROVIDER_UNREACHABLE')
    expect(message).toContain('Network request failed')
  })

  it('reports a timeout as unreachable rather than offline when online', () => {
    setOnline(true)

    expect(
      reasonFor(new ProviderError('timeout', 'Request timed out after 30000ms')).reasonCode,
    ).toBe('PROVIDER_UNREACHABLE')
  })

  it('only claims the device is offline when the browser says so', () => {
    setOnline(false)

    expect(deviceOffline()).toBe(true)
    expect(reasonFor(networkFailure()).reasonCode).toBe('NETWORK_OFFLINE')
  })

  it('keeps the specific codes that already name the real cause', () => {
    setOnline(true)

    expect(reasonFor(new ProviderError('quota', 'HTTP 429: rate limit exceeded')).reasonCode).toBe(
      'QUOTA_EXHAUSTED',
    )
    expect(reasonFor(new ProviderError('unauthorized', 'HTTP 401')).reasonCode).toBe('INVALID_KEY')
    expect(
      reasonFor(new ProviderError('model_missing', 'HTTP 404: model_not_found')).reasonCode,
    ).toBe('MODEL_UNAVAILABLE')
  })

  it('routes an unclassified failure away from NETWORK_OFFLINE while online', () => {
    setOnline(true)

    expect(reasonFor(new Error('Dexie: table is full')).reasonCode).toBe('PROVIDER_UNREACHABLE')
  })

  it('never promises "you are offline" in the unreachable copy', () => {
    expect(REASON_CODES.NETWORK_OFFLINE.messageEn).toContain('offline')
    expect(REASON_CODES.PROVIDER_UNREACHABLE.messageEn).not.toMatch(/you are offline/i)
    expect(REASON_CODES.PROVIDER_UNREACHABLE.messageMy.length).toBeGreaterThan(5)
  })
})
