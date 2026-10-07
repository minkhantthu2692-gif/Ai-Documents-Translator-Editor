import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearRenderCache,
  getCachedUrl,
  putCachedUrl,
  renderCacheKey,
  renderCacheSize,
} from './renderCache'

const revoked: string[] = []
let counter = 0

// jsdom has no object URLs; the cache only needs an opaque string per Blob.
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => `blob:mock-${++counter}`,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => {
      revoked.push(url)
    },
  })
})

afterAll(() => {
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
  else delete (URL as { createObjectURL?: unknown }).createObjectURL
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
})

const blob = () => new Blob(['x'], { type: 'image/png' })

describe('renderCacheKey', () => {
  it('separates files, pages, modes and scales', () => {
    const keys = new Set([
      renderCacheKey('a', 3, 'thumbnail', 0.28),
      renderCacheKey('a', 4, 'thumbnail', 0.28),
      renderCacheKey('b', 3, 'thumbnail', 0.28),
      renderCacheKey('a', 3, 'background', 0.28),
      renderCacheKey('a', 3, 'thumbnail', 1),
    ])
    expect(keys.size).toBe(5)
  })

  it('quantises scale so 0.28 and 0.2800001 share a cache slot', () => {
    expect(renderCacheKey('a', 1, 'thumbnail', 0.28)).toBe(
      renderCacheKey('a', 1, 'thumbnail', 0.28 + 1e-9),
    )
    expect(renderCacheKey('a', 1, 'thumbnail', 0.28)).not.toBe(
      renderCacheKey('a', 1, 'thumbnail', 0.281),
    )
  })
})

describe('renderCache', () => {
  beforeEach(() => {
    revoked.length = 0
    clearRenderCache()
    revoked.length = 0
  })

  it('round-trips a URL and reports its size', () => {
    const key = renderCacheKey('file', 0, 'thumbnail', 0.28)
    expect(getCachedUrl(key)).toBeNull()

    const url = putCachedUrl(key, blob())
    expect(getCachedUrl(key)).toBe(url)
    expect(renderCacheSize()).toBe(1)
  })

  it('keeps at most 48 entries and revokes what it drops', () => {
    for (let i = 0; i < 200; i++) putCachedUrl(renderCacheKey('file', i, 'thumbnail', 0.28), blob())

    expect(renderCacheSize()).toBe(48)
    expect(revoked.length).toBeGreaterThan(140)
    // The oldest pages are gone, the newest survive.
    expect(getCachedUrl(renderCacheKey('file', 0, 'thumbnail', 0.28))).toBeNull()
    expect(getCachedUrl(renderCacheKey('file', 199, 'thumbnail', 0.28))).not.toBeNull()
  })

  it('promotes an entry that is read, so scrolling back does not evict it', () => {
    for (let i = 0; i < 48; i++) putCachedUrl(renderCacheKey('file', i, 'thumbnail', 0.28), blob())

    // Touch the oldest, then push the cache over its limit.
    expect(getCachedUrl(renderCacheKey('file', 0, 'thumbnail', 0.28))).not.toBeNull()
    putCachedUrl(renderCacheKey('file', 48, 'thumbnail', 0.28), blob())

    expect(renderCacheSize()).toBe(48)
    expect(getCachedUrl(renderCacheKey('file', 0, 'thumbnail', 0.28))).not.toBeNull()
    expect(getCachedUrl(renderCacheKey('file', 1, 'thumbnail', 0.28))).toBeNull()
  })

  it('replacing a key revokes the previous URL', () => {
    const key = renderCacheKey('file', 5, 'thumbnail', 0.28)
    const first = putCachedUrl(key, blob())
    revoked.length = 0
    const second = putCachedUrl(key, blob())

    expect(second).not.toBe(first)
    expect(revoked).toEqual([first])
    expect(renderCacheSize()).toBe(1)
  })

  it('clearRenderCache empties the map and revokes every URL', () => {
    putCachedUrl(renderCacheKey('file', 1, 'thumbnail', 0.28), blob())
    putCachedUrl(renderCacheKey('file', 2, 'background', 1), blob())
    expect(renderCacheSize()).toBe(2)

    clearRenderCache()
    expect(renderCacheSize()).toBe(0)
    expect(revoked).toHaveLength(2)
  })
})
