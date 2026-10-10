/**
 * Sidecar client acceptance tests.
 *
 * This module's real contract is that it can fail *silently*: a user who never
 * starts `sidecar/server.py` must get the browser path and nothing else. So
 * almost every case here asserts `null`/`false` and never an exception.
 *
 * The one happy path is worth pinning precisely — the geometry conversion.
 * The sidecar answers in page points, the structure pass divides by the render
 * scale; getting that wrong puts every OCR block in the top-left quarter of
 * the page and looks like a bug in `structure.ts` rather than here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupItemsIntoLines } from '@/pdf/lineGrouping'
import {
  DEFAULT_SIDECAR_URL,
  pageRanges,
  probeSidecar,
  probeSidecarExtract,
  resetSidecarProbe,
  sidecarExtract,
  sidecarHealth,
  sidecarOcr,
  sidecarUrl,
} from './sidecarClient'

const HEALTH = {
  ok: true,
  version: '0.1.0',
  python: '3.12.0',
  libs: { fitz: true, pdfplumber: true, pytesseract: true },
  tesseract: { available: true, langs: ['eng', 'mya'] },
}

const OCR_PAYLOAD = {
  ok: true,
  page: 3,
  text: 'Hello world\nsecond line',
  confidence: 88.4,
  lines: [
    { text: 'Hello world', bbox: { x: 10, y: 20, w: 30, h: 12 }, confidence: 91 },
    { text: 'second line', bbox: { x: 10, y: 36, w: 34, h: 12 } },
  ],
  words: [{ text: 'Hello', bbox: { x: 10, y: 20, w: 12, h: 12 } }],
  ms: 400,
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return vi.mocked(fetch)
}

describe('sidecarUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to the local sidecar', () => {
    expect(sidecarUrl()).toBe(DEFAULT_SIDECAR_URL)
    expect(DEFAULT_SIDECAR_URL).toBe('http://localhost:8790')
  })

  it('honours an override and strips a trailing slash', () => {
    vi.stubEnv('VITE_PDF_SIDECAR_URL', 'http://127.0.0.1:9001/')
    expect(sidecarUrl()).toBe('http://127.0.0.1:9001')
  })

  it('a blanked URL disables the sidecar entirely', () => {
    vi.stubEnv('VITE_PDF_SIDECAR_URL', '   ')
    expect(sidecarUrl()).toBe('')
  })
})

describe('probeSidecar', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetSidecarProbe()
  })

  it('never touches the network when disabled', async () => {
    vi.stubEnv('VITE_PDF_SIDECAR_URL', '')
    await expect(probeSidecar(['eng'])).resolves.toBe(false)
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('answers true for a healthy sidecar with the language installed', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await expect(probeSidecar(['mya'])).resolves.toBe(true)
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it('caches a negative answer so a window of scans probes once', async () => {
    fetchMock().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(probeSidecar(['eng'])).resolves.toBe(false)
    await expect(probeSidecar(['eng'])).resolves.toBe(false)
    await expect(probeSidecar(['eng'])).resolves.toBe(false)
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it('refuses when the sidecar is up but tesseract is not', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ ...HEALTH, tesseract: { available: false, langs: [] } }),
    )
    await expect(probeSidecar(['eng'])).resolves.toBe(false)
  })

  it('refuses a language the sidecar does not have installed', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await expect(probeSidecar(['tha'])).resolves.toBe(false)
  })

  it('trusts the server when it reports no language list at all', async () => {
    // Mirrors the sidecar's own `validate_langs`: no list means it could not
    // answer, and asking is cheaper than refusing a page that would work.
    fetchMock().mockResolvedValue(
      jsonResponse({ ...HEALTH, tesseract: { available: true, langs: [] } }),
    )
    await expect(probeSidecar(['tha'])).resolves.toBe(true)
  })

  it('treats an unparseable answer as "not available"', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ nope: true }))
    await expect(probeSidecar(['eng'])).resolves.toBe(false)
  })
})

describe('sidecarHealth', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetSidecarProbe()
  })

  it('parses the capability payload', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    const health = await sidecarHealth()
    expect(health?.version).toBe('0.1.0')
    expect(health?.tesseract).toEqual({ available: true, langs: ['eng', 'mya'] })
  })

  it('drops its cache after a transport failure, so a late sidecar is found', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await sidecarHealth()
    expect(fetchMock()).toHaveBeenCalledTimes(1)

    // Still cached — no second call.
    await sidecarHealth()
    expect(fetchMock()).toHaveBeenCalledTimes(1)

    // A failed OCR call invalidates it: the sidecar may have just started.
    fetchMock().mockRejectedValue(new TypeError('Failed to fetch'))
    await sidecarOcr(new Blob(['x']), { pageIndex: 0, langs: ['eng'], scale: 4 })
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    // No `force` — this only fetches again if the failure really cleared it.
    await sidecarHealth()
    expect(fetchMock()).toHaveBeenCalledTimes(3)
  })
})

describe('sidecarOcr', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetSidecarProbe()
  })

  const pdf = (): Blob => new Blob(['%PDF-1.4'], { type: 'application/pdf' })

  it('POSTs the raw bytes with the page, language and password', async () => {
    fetchMock().mockResolvedValue(jsonResponse(OCR_PAYLOAD))
    await sidecarOcr(pdf(), {
      pageIndex: 7,
      langs: ['mya'],
      scale: 4,
      password: 'hunter2',
    })

    const [url, init] = fetchMock().mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/ocr?')
    expect(url).toContain('page=7')
    expect(url).toContain('lang=mya')
    expect(url).toContain('password=hunter2')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/pdf' })
  })

  it('converts page points into pixel boxes the structure pass can divide back', async () => {
    fetchMock().mockResolvedValue(jsonResponse(OCR_PAYLOAD))
    const result = await sidecarOcr(pdf(), { pageIndex: 3, langs: ['eng'], scale: 4 })

    expect(result).not.toBeNull()
    expect(result?.confidence).toBe(88)
    expect(result?.ms).toBe(400)
    expect(result?.langs).toEqual(['eng'])

    const line = result!.blocks!.blocks![0].paragraphs[0].lines[0]
    expect(line.text).toBe('Hello world')
    expect(line.bbox).toEqual({ x0: 40, y0: 80, x1: 160, y1: 128 })
    // The invariant: dividing by the render scale gives the sidecar's points
    // back exactly, so `ocrItems` lands every block where it belongs.
    const { x0, y0, x1, y1 } = line.bbox
    expect([x0 / 4, y0 / 4, (x1 - x0) / 4, (y1 - y0) / 4]).toEqual([10, 20, 30, 12])
  })

  it('inherits the page confidence for a line that reports none', async () => {
    fetchMock().mockResolvedValue(jsonResponse(OCR_PAYLOAD))
    const result = await sidecarOcr(pdf(), { pageIndex: 3, langs: ['eng'], scale: 4 })

    const lines = result!.blocks!.blocks![0].paragraphs[0].lines
    // It must be filtered *by* the page's measurement, not exempted from the
    // floor (would keep noise) nor dropped by it (would lose real text).
    expect(lines[1].confidence).toBe(88)
  })

  it('drops malformed lines instead of placing them at the origin', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        ...OCR_PAYLOAD,
        lines: [
          OCR_PAYLOAD.lines[0],
          { text: 'bad', bbox: { x: 1, y: 1, w: 0, h: 4 } },
          { text: 'bad', bbox: 'oops' },
          { text: '   ', bbox: { x: 1, y: 1, w: 4, h: 4 } },
        ],
      }),
    )
    const result = await sidecarOcr(pdf(), { pageIndex: 3, langs: ['eng'], scale: 4 })

    const lines = result!.blocks!.blocks![0].paragraphs[0].lines
    expect(lines.map((entry) => entry.text)).toEqual(['Hello world'])
  })

  it('returns null (not a throw) for an HTTP error', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ ok: false, code: 'NOT_AVAILABLE', message: 'no tesseract' }, 500),
    )
    await expect(sidecarOcr(pdf(), { pageIndex: 0, langs: ['eng'], scale: 4 })).resolves.toBeNull()
  })

  it('returns null for a protocol error body even on HTTP 200', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ ok: false, code: 'PASSWORD_REQUIRED', message: 'needs a password' }),
    )
    await expect(sidecarOcr(pdf(), { pageIndex: 0, langs: ['eng'], scale: 4 })).resolves.toBeNull()
  })

  it('returns null on a transport failure and forgets the cached probe', async () => {
    fetchMock().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(sidecarOcr(pdf(), { pageIndex: 0, langs: ['eng'], scale: 4 })).resolves.toBeNull()
  })

  it('refuses text it could not turn into lines rather than caching a blank page', async () => {
    // Accepting this would write a result whose `text` is non-empty (so it is
    // cached) but whose `blocks` are empty — the page would silently lose its
    // content on every re-parse.
    fetchMock().mockResolvedValue(jsonResponse({ ...OCR_PAYLOAD, lines: [] }))
    await expect(sidecarOcr(pdf(), { pageIndex: 3, langs: ['eng'], scale: 4 })).resolves.toBeNull()
  })

  it('accepts a genuinely empty page without falling back to a re-render', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ ok: true, page: 0, text: '', confidence: 0, lines: [], words: [], ms: 5 }),
    )
    const result = await sidecarOcr(pdf(), { pageIndex: 0, langs: ['eng'], scale: 4 })
    expect(result).not.toBeNull()
    expect(result?.text).toBe('')
    expect(result?.blocks).toBeNull()
  })

  it('gives up without a network call when the sidecar is disabled', async () => {
    vi.stubEnv('VITE_PDF_SIDECAR_URL', '')
    await expect(sidecarOcr(pdf(), { pageIndex: 0, langs: ['eng'], scale: 4 })).resolves.toBeNull()
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/* /extract                                                            */
/* ------------------------------------------------------------------ */

/** A page worth the round trip: two visual lines, the first made of two runs. */
const EXTRACT_PAYLOAD = {
  ok: true,
  ms: 12,
  pages: [
    {
      index: 0,
      width: 612,
      height: 792,
      rotation: 0,
      extractionMethod: 'text',
      contentClass: 'text',
      blocks: [
        {
          order: 0,
          kind: 'paragraph',
          region: 'body',
          text: 'Region Q1\nNorth',
          bbox: { x: 72, y: 100, w: 148, h: 29.4 },
          fontSize: 11,
          fontFamily: 'Helvetica',
          alignment: 'left',
          skipRule: null,
          listMarker: null,
          table: null,
          lines: [
            { text: 'Region', x: 72, w: 40, y: 100 },
            { text: 'Q1', x: 200, w: 20, y: 100 },
            { text: 'North', x: 72, w: 44, y: 118 },
          ].map(({ text, x, w, y }) => ({
            text,
            bbox: { x, y, w, h: 14.4 },
            fontFamily: 'Helvetica',
            fontSize: 11,
            bold: false,
            italic: false,
            color: '#000000',
            rotation: 0,
          })),
        },
      ],
    },
  ],
}

/** Deep copy of the payload with one field changed, for the decline cases. */
function payloadWhere(mutate: (page: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(EXTRACT_PAYLOAD)) as {
    pages: Array<Record<string, unknown>>
  }
  mutate(copy.pages[0])
  return copy
}

describe('pageRanges', () => {
  it('compresses consecutive pages and leaves gaps alone', () => {
    expect(pageRanges([0, 1, 2, 7, 9])).toBe('0-2,7,9')
    expect(pageRanges([3])).toBe('3')
    expect(pageRanges([])).toBe('')
  })

  it('sorts and de-duplicates, so the same window is always the same request', () => {
    expect(pageRanges([9, 7, 2, 1, 0, 2])).toBe('0-2,7,9')
  })
})

describe('probeSidecarExtract', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetSidecarProbe()
  })

  it('never touches the network when disabled', async () => {
    vi.stubEnv('VITE_PDF_SIDECAR_URL', '')
    await expect(probeSidecarExtract()).resolves.toBe(false)
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('answers true for a sidecar that can open documents', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await expect(probeSidecarExtract()).resolves.toBe(true)
  })

  it('shares the OCR probe rather than buying a second one', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await expect(probeSidecar(['eng'])).resolves.toBe(true)
    await expect(probeSidecarExtract()).resolves.toBe(true)
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it('wants pymupdf, not tesseract — the two questions are different', async () => {
    // Extraction needs PyMuPDF; OCR needs the tesseract binary. A sidecar
    // installed on a machine with no OCR language data can still read a PDF,
    // and gating on the OCR answer would silently disable it.
    fetchMock().mockResolvedValue(
      jsonResponse({ ...HEALTH, tesseract: { available: false, langs: [] } }),
    )
    await expect(probeSidecar(['eng'])).resolves.toBe(false)
    await expect(probeSidecarExtract()).resolves.toBe(true)
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it('refuses when pymupdf is missing', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ ...HEALTH, libs: { fitz: false } }))
    await expect(probeSidecarExtract()).resolves.toBe(false)
  })

  it('refuses a health payload with no library list at all', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ ok: true, libs: {} }))
    await expect(probeSidecarExtract()).resolves.toBe(false)
  })

  it('is false when the sidecar is not running', async () => {
    fetchMock().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(probeSidecarExtract()).resolves.toBe(false)
  })
})

describe('sidecarExtract', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetSidecarProbe()
  })

  const pdf = (): Blob => new Blob(['%PDF-1.4'], { type: 'application/pdf' })

  it('POSTs the raw bytes with the mode, the page ranges and the password', async () => {
    fetchMock().mockResolvedValue(jsonResponse(EXTRACT_PAYLOAD))
    await sidecarExtract(pdf(), { pageIndexes: [0, 1, 2, 7], password: 'hunter2' })

    const [url, init] = fetchMock().mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/extract?')
    // OCR belongs to the app's own pipeline: `mode=text` keeps the sidecar's
    // OCR from racing the confidence floor and the cache that own it.
    expect(url).toContain('mode=text')
    expect(decodeURIComponent(url)).toContain('pages=0-2,7')
    expect(url).toContain('password=hunter2')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/pdf' })
  })

  it('rebuilds each line as a run that regroups to the same rectangle', async () => {
    // The whole adapter in one assertion: a synthesised run must survive
    // `groupItemsIntoLines` — the pass the browser path also goes through —
    // landing where PyMuPDF measured it, one em tall, at the right size.
    fetchMock().mockResolvedValue(jsonResponse(EXTRACT_PAYLOAD))
    const [page] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!

    expect(page.decline).toBeNull()
    expect(page.source.items.map((item) => item.str)).toEqual(['Region', 'Q1', 'North'])

    const lines = groupItemsIntoLines(page.source.items, {
      pageIndex: 0,
      pageHeight: page.source.height,
      styles: page.source.styles,
    })
    expect(lines).toHaveLength(2)

    // Two runs on one baseline become one line; the gap between the cells is
    // layout, so the grouper reads it as a word space, exactly as it would
    // have read pdf.js's two show-text operators.
    expect(lines[0].text).toBe('Region Q1')
    expect(lines[0].bbox).toEqual({ x: 72, y: 100, w: 148, h: 11 })
    expect(lines[0].runs).toHaveLength(2)
    expect(lines[1].text).toBe('North')
    expect(lines[1].bbox).toEqual({ x: 72, y: 118, w: 44, h: 11 })
    expect(lines[0].style).toMatchObject({
      fontFamily: 'Helvetica',
      fontSize: 11,
      color: '#000000',
    })
    // pdf.js reports a colour it read off the operator list; a sidecar line
    // reports the one PyMuPDF measured. Same normalisation, same value.
    expect(lines[1].itemIndexes).toEqual([2])
  })

  it('declines a rotated page, whose boxes are in a different space', async () => {
    fetchMock().mockResolvedValue(jsonResponse(payloadWhere((page) => void (page.rotation = 90))))
    const [entry] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!
    expect(entry.decline).toBe('page-rotation')
    expect(entry.source.items).toHaveLength(0)
  })

  it('declines a scan, which the app’s own OCR pipeline owns', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(payloadWhere((page) => void (page.extractionMethod = 'ocr'))),
    )
    const [entry] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!
    expect(entry.decline).toBe('extraction-method')
  })

  it('declines a pdfplumber table, whose cells lost their rectangles', async () => {
    // `_table_block` removes the text blocks that sat inside the table, so
    // the page is no longer a drop-in for what pdf.js would have read. pdf.js
    // reads ruled tables correctly — better, in fact — so they stay with it.
    fetchMock().mockResolvedValue(
      jsonResponse(
        payloadWhere((page) => {
          ;(page.blocks as Array<Record<string, unknown>>)[0].table = {
            rows: [
              ['Region', 'Q1'],
              ['North', '120'],
            ],
          }
        }),
      ),
    )
    const [entry] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!
    expect(entry.decline).toBe('pdfplumber-table')
  })

  it('declines a tilted line, whose box cannot carry the rotation', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(
        payloadWhere((page) => {
          const blocks = page.blocks as Array<{ lines: Array<Record<string, unknown>> }>
          blocks[0].lines[2].rotation = -45
        }),
      ),
    )
    const [entry] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!
    expect(entry.decline).toBe('line-rotation')
  })

  it('declines unusable geometry instead of placing the text at the origin', async () => {
    for (const [broken, reason] of [
      [
        (lines: Array<Record<string, unknown>>) =>
          void (lines[0].bbox = { x: 1, y: 2, w: 0, h: 4 }),
        'line-geometry',
      ],
      [(lines: Array<Record<string, unknown>>) => void (lines[0].bbox = 'oops'), 'line-geometry'],
      [(lines: Array<Record<string, unknown>>) => void (lines[0].fontSize = 0), 'line-font-size'],
      [(lines: Array<Record<string, unknown>>) => void delete lines[0].text, 'line-text'],
    ] as const) {
      fetchMock().mockResolvedValue(
        jsonResponse(
          payloadWhere((page) => {
            const blocks = page.blocks as Array<{ lines: Array<Record<string, unknown>> }>
            broken(blocks[0].lines)
          }),
        ),
      )
      const [entry] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!
      expect(entry.decline).toBe(reason)
    }
  })

  it('declines a page with no text at all rather than an empty one', async () => {
    fetchMock().mockResolvedValue(jsonResponse(payloadWhere((page) => void (page.blocks = []))))
    const [entry] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!
    expect(entry.decline).toBe('no-lines')
  })

  it('drops a line kept only for its spacing, keeping the rest of the page', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(
        payloadWhere((page) => {
          const blocks = page.blocks as Array<{ lines: Array<Record<string, unknown>> }>
          blocks[0].lines.splice(1, 0, {
            text: '   ',
            bbox: { x: 72, y: 100, w: 40, h: 14.4 },
            fontFamily: 'Helvetica',
            fontSize: 11,
            bold: false,
            italic: false,
            color: '#000000',
            rotation: 0,
          })
        }),
      ),
    )
    const [entry] = (await sidecarExtract(pdf(), { pageIndexes: [0] }))!
    expect(entry.decline).toBeNull()
    expect(entry.source.items.map((item) => item.str)).toEqual(['Region', 'Q1', 'North'])
  })

  it('returns null (not a throw) for an HTTP error', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ ok: false, code: 'PAGE_RANGE', message: 'bad range' }, 400),
    )
    await expect(sidecarExtract(pdf(), { pageIndexes: [0] })).resolves.toBeNull()
  })

  it('returns null for a protocol error body even on HTTP 200', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ ok: false, code: 'NOT_AVAILABLE' }))
    await expect(sidecarExtract(pdf(), { pageIndexes: [0] })).resolves.toBeNull()
  })

  it('returns null when a page entry is not the shape this adapter reads', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ ok: true, pages: [{ width: 612 }] }))
    await expect(sidecarExtract(pdf(), { pageIndexes: [0] })).resolves.toBeNull()
  })

  it('returns null on a transport failure and forgets the cached probe', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await sidecarHealth()
    expect(fetchMock()).toHaveBeenCalledTimes(1)

    fetchMock().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(sidecarExtract(pdf(), { pageIndexes: [0] })).resolves.toBeNull()

    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await sidecarHealth()
    expect(fetchMock()).toHaveBeenCalledTimes(3)
  })

  it('leaves the probe alone when the call was cancelled', async () => {
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await sidecarHealth()
    expect(fetchMock()).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    controller.abort()
    fetchMock().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(
      sidecarExtract(pdf(), { pageIndexes: [0], signal: controller.signal }),
    ).resolves.toBeNull()

    // A cancellation says nothing about the sidecar's health, so the probe
    // cached a moment ago survives — no third round trip, because the next
    // window still trusts it.
    fetchMock().mockResolvedValue(jsonResponse(HEALTH))
    await sidecarHealth()
    expect(fetchMock()).toHaveBeenCalledTimes(2)
  })

  it('gives up without a network call when the sidecar is disabled', async () => {
    vi.stubEnv('VITE_PDF_SIDECAR_URL', '')
    await expect(sidecarExtract(pdf(), { pageIndexes: [0] })).resolves.toBeNull()
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('asks nothing when there is nothing to recover', async () => {
    await expect(sidecarExtract(pdf(), { pageIndexes: [] })).resolves.toBeNull()
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})
