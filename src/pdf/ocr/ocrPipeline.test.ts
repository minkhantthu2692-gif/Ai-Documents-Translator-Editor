/**
 * `runWindowOcr` — where the local sidecar and the browser actually meet.
 *
 * The sidecar is an *accelerator*, never a dependency, so the interesting
 * cases are the seams:
 *
 *   - it answers → the page is recognised **without the browser ever
 *     rasterising it** (the render is a thunk precisely so this holds);
 *   - it is absent, or present but unable to serve this request → the ordinary
 *     path runs and the page still lands;
 *   - it is present but cannot do *this* language → we do not even POST the
 *     PDF, because a full upload per page just to read back an error is the
 *     cost the feature exists to remove.
 *
 * fake-indexeddb + a mocked `tesseract.js` + a mocked fetch: no worker, no
 * network, no sidecar process.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushEvents } from '@/core/eventLogger'
import { AppDatabase, setDb } from '@/db/db'
import { pageRepo } from '@/db/repo-content'
import { sourceFileRepo } from '@/db/repo-sourceFiles'
import { analysisClient } from '@/pdf/analysisClient'
import { resetSidecarProbe } from '@/sidecar/sidecarClient'
import { runWindowOcr } from './ocrPipeline'

const recognizeMock = vi.hoisted(() => vi.fn())

vi.mock('tesseract.js', () => ({
  // Plain functions: `restoreMocks` would strip a `vi.fn()`'s implementation.
  createWorker: async () => ({
    reinitialize: async () => undefined,
    recognize: recognizeMock,
    terminate: async () => undefined,
  }),
}))

const PROJECT_ID = 'prj_ocr_pipeline'
const HEALTH = {
  ok: true,
  version: '0.1.0',
  python: '3.12.0',
  libs: { fitz: true, pdfplumber: true, pytesseract: true },
  tesseract: { available: true, langs: ['eng', 'mya'] },
}
/** One line across the middle of the page, comfortably clear of the margins. */
const OCR_PAYLOAD = {
  ok: true,
  page: 0,
  text: 'A recognised line of body text',
  confidence: 93,
  lines: [
    {
      text: 'A recognised line of body text',
      bbox: { x: 100, y: 380, w: 240, h: 20 },
      confidence: 96,
    },
  ],
  words: [],
  ms: 700,
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

async function seedScannedPage(): Promise<void> {
  await pageRepo.upsert({
    projectId: PROJECT_ID,
    index: 0,
    hasTextLayer: false,
    contentClass: 'scanned',
    width: 612,
    height: 792,
    rotation: 0,
  })
  await sourceFileRepo.put({
    projectId: PROJECT_ID,
    file: new Blob(['%PDF-1.4 stand-in'], { type: 'application/pdf' }),
    name: 'scan.pdf',
    pageCount: 1,
    // Supplied so `checksumOf` never runs: jsdom's `Blob.slice()` has no
    // `arrayBuffer()`, and the fingerprint is irrelevant to what is under test.
    checksum: 'test-checksum',
  })
}

async function pageState() {
  const page = await pageRepo.getByIndex(PROJECT_ID, 0)
  return { ocrStatus: page?.ocrStatus, ocrConfidence: page?.ocrConfidence }
}

describe('runWindowOcr', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-ocrpipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    resetSidecarProbe()
    vi.stubGlobal('fetch', vi.fn())
    recognizeMock.mockReset()
    recognizeMock.mockResolvedValue({
      data: { text: 'from the browser', confidence: 60, blocks: null },
    })
    await seedScannedPage()
  })

  afterEach(async () => {
    await flushEvents()
    await cacheReset()
    db.close()
    vi.unstubAllGlobals()
    resetSidecarProbe()
    vi.restoreAllMocks()
  })

  async function cacheReset(): Promise<void> {
    const { cacheRepo } = await import('@/db/repo-cache')
    await cacheRepo.clearAll().catch(() => undefined)
  }

  function sidecarOnline(): void {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/health')) return jsonResponse(HEALTH)
      if (url.includes('/ocr')) return jsonResponse(OCR_PAYLOAD)
      throw new TypeError(`unexpected request: ${url}`)
    })
  }

  it('recognises through the sidecar without the browser ever rendering', async () => {
    sidecarOnline()
    const render = vi.spyOn(analysisClient, 'render')

    const results = await runWindowOcr({
      projectId: PROJECT_ID,
      fileId: 'file_ocr',
      pageIndexes: [0],
      sourceLang: 'en',
    })

    const entry = results.get(0)
    expect(entry).toBeDefined()
    expect(entry?.confidence).toBe(93)
    expect(entry?.content.blocks.length).toBeGreaterThan(0)
    expect(entry?.content.charCount).toBeGreaterThan(0)

    // The guarantee: no rasterisation happened, because the sidecar reads the
    // PDF itself. Also proves no analysis worker was spawned for this run.
    expect(render).not.toHaveBeenCalled()
    expect(recognizeMock).not.toHaveBeenCalled()

    // …and the geometry survived the points → pixels round trip: the line sits
    // at y=380pt on a 792pt page, nowhere near a margin.
    const block = entry!.content.blocks[0]
    expect(block.bbox.y).toBeGreaterThan(300)
    expect(block.bbox.y).toBeLessThan(450)

    expect(await pageState()).toEqual({ ocrStatus: 'done', ocrConfidence: 93 })
  })

  it('falls back to the browser when the sidecar is not running', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    const render = vi.spyOn(analysisClient, 'render').mockResolvedValue(new Blob(['png']))

    const results = await runWindowOcr({
      projectId: PROJECT_ID,
      fileId: 'file_ocr',
      pageIndexes: [0],
      sourceLang: 'en',
    })

    expect(results.get(0)?.confidence).toBe(60)
    expect(render).toHaveBeenCalledTimes(1)
    expect(recognizeMock).toHaveBeenCalledTimes(1)
    expect(await pageState()).toEqual({ ocrStatus: 'done', ocrConfidence: 60 })
  })

  it('does not upload the PDF when the sidecar lacks the language', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ...HEALTH, tesseract: { available: true, langs: ['mya'] } }),
    )
    const render = vi.spyOn(analysisClient, 'render').mockResolvedValue(new Blob(['png']))

    const results = await runWindowOcr({
      projectId: PROJECT_ID,
      fileId: 'file_ocr',
      pageIndexes: [0],
      sourceLang: 'en',
    })

    // One health probe, and no `/ocr` — an 8 MB POST per page just to read
    // back a 400 is exactly the waste this gate exists to prevent.
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(1)
    expect(results.get(0)?.confidence).toBe(60)
  })

  it('does not upload the PDF when the sidecar has no tesseract at all', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ...HEALTH, tesseract: { available: false, langs: [] } }),
    )
    const render = vi.spyOn(analysisClient, 'render').mockResolvedValue(new Blob(['png']))

    await runWindowOcr({
      projectId: PROJECT_ID,
      fileId: 'file_ocr',
      pageIndexes: [0],
      sourceLang: 'en',
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('never touches the network for a page that does not need OCR', async () => {
    await pageRepo.update((await pageRepo.getByIndex(PROJECT_ID, 0))!.id, {
      contentClass: 'text',
    })

    const results = await runWindowOcr({
      projectId: PROJECT_ID,
      fileId: 'file_ocr',
      pageIndexes: [0],
      sourceLang: 'en',
    })

    expect(results.size).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
})
