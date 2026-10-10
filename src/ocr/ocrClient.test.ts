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
import { recognizeCached, recognizeOcr, terminateOcr, type OcrResult } from './ocrClient'

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

/**
 * `osd` — orientation by trial through the real `recognizeOcr` seam. jsdom
 * ships no `OffscreenCanvas`, so the canvas is a stand-in: enough for
 * `rotateImage` to produce the swapped-dimension raster whose shape tells the
 * mocked worker which frame it is being handed. The trial policy itself and
 * the box maths live in `orientation.test.ts`; what is pinned here is the
 * wiring — deskew flag on, trials off when they cannot run, boxes landing back
 * in the caller's frame.
 */
describe('osd orientation through recognizeOcr', () => {
  class FakeOffscreenCanvas {
    width: number
    height: number
    constructor(width: number, height: number) {
      this.width = width
      this.height = height
    }
    getContext() {
      return {
        imageSmoothingEnabled: false,
        setTransform: () => undefined,
        drawImage: () => undefined,
      }
    }
  }

  /** A line box in the 90°-turned frame of a 400×100 raster — the raw shape
   * tesseract hands back: an array of blocks, not a page wrapper. */
  function turnedBlocks() {
    return [
      {
        paragraphs: [
          { lines: [{ text: 'line', confidence: 80, bbox: { x0: 10, y0: 20, x1: 60, y1: 30 } }] },
        ],
      },
    ]
  }

  afterEach(async () => {
    vi.unstubAllGlobals()
    await terminateOcr()
    vi.clearAllMocks()
  })

  it('a poor first pass runs a quarter-turn trial and maps boxes back', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    recognizeMock.mockImplementation(async (image: FakeOffscreenCanvas) =>
      image.width < image.height
        ? {
            data: {
              text: 'upright after trial',
              confidence: 81,
              blocks: turnedBlocks(),
              rotateRadians: 0,
            },
          }
        : { data: { text: 'garbled', confidence: 15, blocks: null, rotateRadians: 0 } },
    )

    const result = await recognizeOcr(
      new FakeOffscreenCanvas(400, 100) as unknown as OffscreenCanvas,
      {
        langs: ['en'],
        osd: true,
        imageSize: { width: 400, height: 100 },
      },
    )

    expect(result.text).toBe('upright after trial')
    expect(result.orientation).toBe(90)
    // First pass poor → trial at 90° reads well → the search stops there.
    expect(recognizeMock).toHaveBeenCalledTimes(2)
    expect(recognizeMock.mock.calls[0]?.[1]).toEqual({ rotateAuto: true })
    expect(recognizeMock.mock.calls[1]?.[0]).toMatchObject({ width: 100, height: 400 })
    // The trial frame's box, inverted back into the 400×100 input frame
    // (quarter-turns carry a hair of sin π/2 drift, so to 6 decimals).
    const mappedLine = result.blocks?.blocks?.[0]?.paragraphs[0].lines[0]
    expect(mappedLine?.bbox?.x0).toBeCloseTo(20, 6)
    expect(mappedLine?.bbox?.y0).toBeCloseTo(40, 6)
    expect(mappedLine?.bbox?.x1).toBeCloseTo(30, 6)
    expect(mappedLine?.bbox?.y1).toBeCloseTo(90, 6)
  })

  it('without an OffscreenCanvas it still deskews once and never fails', async () => {
    // jsdom default: `OffscreenCanvas` does not exist, so `rotateImage`
    // resolves null before touching anything.
    recognizeMock.mockResolvedValue({ data: { text: 'skewed but upright', confidence: 41 } })

    const result = await recognizeOcr('render', { langs: ['en'], osd: true })

    expect(result.text).toBe('skewed but upright')
    expect(result.orientation).toBeUndefined()
    expect(recognizeMock).toHaveBeenCalledTimes(1)
    expect(recognizeMock.mock.calls[0]?.[1]).toEqual({ rotateAuto: true })
  })

  it('a rectangle region opts out of trials and deskew entirely', async () => {
    recognizeMock.mockResolvedValue({ data: { text: 'region', confidence: 15 } })

    await recognizeOcr('render', {
      langs: ['en'],
      osd: true,
      rectangle: { left: 0, top: 0, width: 100, height: 50 },
      imageSize: { width: 400, height: 100 },
    })

    expect(recognizeMock).toHaveBeenCalledTimes(1)
    expect(recognizeMock.mock.calls[0]?.[1]).toEqual({
      rectangle: { left: 0, top: 0, width: 100, height: 50 },
    })
  })
})
