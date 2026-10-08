/**
 * `recognizeCached` — the seam where the local sidecar and tesseract.js meet.
 *
 * Three guarantees are worth pinning, because breaking any of them is silent:
 *
 *  1. a cached page is never re-recognised, whatever engine produced it;
 *  2. an accelerator that answers means the browser never rasterises the page
 *     (the image source is a thunk precisely so a sidecar run does no render
 *     nobody will look at);
 *  3. an accelerator that *misbehaves* — returning `null`, or throwing — hands
 *     the page to the ordinary path instead of failing it.
 *
 * `tesseract.js` is mocked: the real worker would fetch a WASM core and a
 * traineddata pack over the network.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase, setDb } from '@/db/db'
import { cacheRepo } from '@/db/repo-cache'
import { recognizeCached, terminateOcr, type OcrResult } from './ocrClient'

const recognizeMock = vi.hoisted(() => vi.fn())

vi.mock('tesseract.js', () => ({
  // Plain functions, not spies: `restoreMocks` in vite.config.ts would strip a
  // `vi.fn()`'s implementation between tests and leave `createWorker` blank.
  createWorker: async () => ({
    reinitialize: async () => undefined,
    recognize: recognizeMock,
    terminate: async () => undefined,
  }),
}))

const KEY = 'project#0#eng'

function browserResult(text: string): OcrResult {
  return { text, confidence: 88, blocks: null, langs: ['eng'], ms: 12 }
}

function sidecarResult(text: string): OcrResult {
  return { text, confidence: 95, blocks: null, langs: ['eng'], ms: 3 }
}

describe('recognizeCached with an alternative recogniser', () => {
  let db: AppDatabase
  let image: ReturnType<typeof vi.fn>
  let primary: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = new AppDatabase(`aidt-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    image = vi.fn(async () => 'rendered-image')
    primary = vi.fn(async () => sidecarResult('from the sidecar'))
    recognizeMock.mockReset()
    recognizeMock.mockResolvedValue({
      data: { text: 'from the browser', confidence: 70, blocks: null },
    })
  })

  afterEach(async () => {
    await terminateOcr()
    await flushCache()
    db.close()
    vi.clearAllMocks()
  })

  async function flushCache(): Promise<void> {
    await cacheRepo.clearAll().catch(() => undefined)
  }

  it('a cache hit short-circuits both engines', async () => {
    await cacheRepo.put('ocr', KEY, sidecarResult('already done'))

    const result = await recognizeCached(KEY, image, { langs: ['en'] }, primary)

    expect(result.text).toBe('already done')
    expect(primary).not.toHaveBeenCalled()
    expect(image).not.toHaveBeenCalled()
    expect(recognizeMock).not.toHaveBeenCalled()
  })

  it('an answered primary means the browser never renders the page', async () => {
    const result = await recognizeCached(KEY, image, { langs: ['en'] }, primary)

    expect(result.text).toBe('from the sidecar')
    expect(primary).toHaveBeenCalledTimes(1)
    // The whole point of the thunk: no rasterisation happened.
    expect(image).not.toHaveBeenCalled()
    expect(recognizeMock).not.toHaveBeenCalled()
  })

  it('caches the primary answer, so a re-parse costs nothing', async () => {
    await recognizeCached(KEY, image, { langs: ['en'] }, primary)

    const again = await recognizeCached(KEY, image, { langs: ['en'] }, primary)

    expect(again.text).toBe('from the sidecar')
    expect(primary).toHaveBeenCalledTimes(1)
  })

  it('falls back to the browser when the primary declines', async () => {
    primary.mockResolvedValue(null)

    const result = await recognizeCached(KEY, image, { langs: ['en'] }, primary)

    expect(result.text).toBe('from the browser')
    expect(image).toHaveBeenCalledTimes(1)
    expect(image).toHaveBeenCalledWith()
    expect(recognizeMock).toHaveBeenCalledTimes(1)
  })

  it('a primary that throws never fails the page', async () => {
    primary.mockRejectedValue(new Error('sidecar exploded'))

    const result = await recognizeCached(KEY, image, { langs: ['en'] }, primary)

    expect(result.text).toBe('from the browser')
    expect(image).toHaveBeenCalledTimes(1)
  })

  it('a primary that throws still lands the fallback in the cache', async () => {
    primary.mockRejectedValue(new Error('sidecar exploded'))
    await recognizeCached(KEY, image, { langs: ['en'] }, primary)

    const cached = await cacheRepo.get<OcrResult>('ocr', KEY)
    expect(cached?.text).toBe('from the browser')

    // …and the next call finds it without retrying the broken accelerator.
    const again = await recognizeCached(KEY, image, { langs: ['en'] }, primary)
    expect(again.text).toBe('from the browser')
    expect(primary).toHaveBeenCalledTimes(1)
  })

  it('an empty result is not cached, so a blank page is retried', async () => {
    primary.mockResolvedValue(browserResult(''))
    const first = await recognizeCached(KEY, image, { langs: ['en'] }, primary)
    expect(first.text).toBe('')
    expect(await cacheRepo.get<OcrResult>('ocr', KEY)).toBeNull()

    // A later run may go through a working engine instead.
    const second = await recognizeCached(KEY, image, { langs: ['en'] }, primary)
    expect(second.text).toBe('')
    expect(primary).toHaveBeenCalledTimes(2)
  })

  it('still accepts an eager image when no primary is offered', async () => {
    // Not a thunk: a `Blob`/`string` is passed through untouched, so callers
    // that already have the render keep working.
    const result = await recognizeCached(KEY, 'already-rendered', { langs: ['en'] })

    expect(result.text).toBe('from the browser')
    expect(recognizeMock).toHaveBeenCalledTimes(1)
    expect(recognizeMock.mock.calls[0]?.[0]).toBe('already-rendered')
  })
})
