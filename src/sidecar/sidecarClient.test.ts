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
import {
  DEFAULT_SIDECAR_URL,
  probeSidecar,
  resetSidecarProbe,
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
