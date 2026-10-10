// @vitest-environment node
/**
 * The sidecar fallback must rebuild the page pdf.js already read.
 *
 * The adapter's whole claim is that a page recovered from `POST /extract` is
 * indistinguishable from one the browser produced: same blocks, same kinds,
 * same text, same cells, same links. If that ever stops being true, a
 * document would change shape depending on which engine happened to read it —
 * and the user would have no way to know why their paragraphs moved.
 *
 * The sidecar side of each comparison is a *recording* of a real server
 * (`fixtures/sidecar/*.json`, regenerate with
 * `node scripts/record-sidecar-extract.mjs`), so this runs without one: the
 * suite stays deterministic and still fails if `sidecar/server.py` changes
 * the payload shape.
 *
 * Deliberately not compared: `fontFamily` (PyMuPDF reports the real typeface,
 * pdf.js an internal id — `canMerge` only ever compares families *within* a
 * page, so both paths split identically anyway) and `id` (a pure hash of the
 * quantised box, which the engine's own rounding feeds).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import {
  assemblePage,
  extractPage,
  type AnnotationLike,
  type ExtractPageOptions,
  type ExtractedPage,
} from '@/pdf/pdfExtract'
import type { PageBlock } from '@/pdf/structure'
import { traceImagePlacements } from '@/pdf/imageOps'
import type { OpList } from '@/pdf/pdfOps'
import { normaliseExtract, type SidecarExtractPage } from './sidecarClient'

const recorded = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/sidecar/${name}.json`, import.meta.url)),
      'utf8',
    ),
  )

function optionsFor(pageIndex: number): ExtractPageOptions {
  return {
    pageIndex,
    ctx: { sourceLang: 'en', targetLang: 'my' },
    headerTexts: [],
    footerTexts: [],
  }
}

/**
 * What a block *says* and what it owns, as opposed to where it happened to be
 * measured.
 *
 * `figures` belongs here because the pairing — which paragraph carries which
 * picture — is a decision `assemblePage` makes, and it is exactly the one a
 * sidecar page would lose if the runtime did not hand it the pdf.js
 * placements. The rectangles inside are identical on both sides only because
 * `recovered` traces them from the same operator list the browser read; that
 * is the property under test, not a convenience.
 */
function shape(blocks: readonly PageBlock[]) {
  return blocks.map((block) => ({
    kind: block.kind,
    region: block.region,
    order: block.order,
    text: block.text,
    tableCells: block.tableCells,
    headingLevel: block.headingLevel,
    listMarker: block.listMarker,
    skipRule: block.skipRule,
    links: block.links,
    figures: block.figures,
    alignment: block.alignment,
    lineCount: block.lines.length,
  }))
}

function pagesOf(recording: unknown): SidecarExtractPage[] {
  const pages = normaliseExtract(recording)
  expect(pages).not.toBeNull()
  return pages!
}

const tasks: ReturnType<typeof getDocument>[] = []

async function open(name: string): Promise<PDFDocumentProxy> {
  const task = getDocument({
    data: new Uint8Array(
      readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url))),
    ),
    useSystemFonts: true,
    verbosity: 0,
  })
  tasks.push(task)
  return task.promise
}

/**
 * The fallback as the worker drives it: sidecar runs, pdf.js annotations and
 * operator list, then the one shared `assemblePage`.
 *
 * The operator list is what `recoverWithSidecar` reads for placements — text
 * came from PyMuPDF, but the rectangles a picture occupies are geometry the
 * browser can still recover even when the text stream was what failed.
 */
async function recovered(
  doc: PDFDocumentProxy,
  recording: unknown,
  pageIndex: number,
): Promise<ExtractedPage> {
  const entry = pagesOf(recording).find((page) => page.index === pageIndex)
  expect(entry?.decline).toBeNull()
  const page = await doc.getPage(pageIndex + 1)
  const annotations = (await page.getAnnotations().catch(() => [])) as AnnotationLike[]
  const ops = (await page.getOperatorList().catch(() => null)) as unknown as OpList | null
  const placements = ops ? traceImagePlacements(ops, page.view) : []
  return assemblePage(
    pageIndex,
    { ...entry!.source, annotations, placements },
    optionsFor(pageIndex),
  )
}

/**
 * Compares the two paths, block by block.
 *
 * Boxes are checked with a tolerance rather than for equality: the engines
 * round at different points (PyMuPDF to 2dp, pdf.js from a corner walk), so
 * an exact match would be a coincidence, while a missing y-flip or a page
 * origin that drifted would show up as a gap of tens of points.
 */
function expectSamePage(fromSidecar: ExtractedPage, fromBrowser: ExtractedPage) {
  expect(shape(fromSidecar.blocks)).toEqual(shape(fromBrowser.blocks))
  expect(fromSidecar.lineCount).toBe(fromBrowser.lineCount)
  expect(fromSidecar.charCount).toBe(fromBrowser.charCount)
  expect(fromSidecar.width).toBe(fromBrowser.width)
  expect(fromSidecar.height).toBe(fromBrowser.height)

  fromSidecar.blocks.forEach((block, index) => {
    const other = fromBrowser.blocks[index]
    expect(Math.abs(block.bbox.x - other.bbox.x)).toBeLessThanOrEqual(3)
    expect(Math.abs(block.bbox.y - other.bbox.y)).toBeLessThanOrEqual(3)
    expect(Math.abs(block.bbox.w - other.bbox.w)).toBeLessThanOrEqual(3)
    expect(Math.abs(block.bbox.h - other.bbox.h)).toBeLessThanOrEqual(3)
  })
}

describe('sidecar fallback parity', () => {
  const recordings = {
    'table.pdf': recorded('table'),
    'text-300p.pdf': recorded('text-300p'),
    'links.pdf': recorded('links'),
    'mixed.pdf': recorded('mixed'),
  }
  const pageCounts: Record<string, number> = {
    'table.pdf': 2,
    'text-300p.pdf': 3,
    'links.pdf': 1,
    'mixed.pdf': 1,
  }

  beforeAll(() => {
    // Fail loudly here rather than deep inside a comparison: a recording that
    // no longer parses means the server changed shape, not that parity broke.
    for (const [name, recording] of Object.entries(recordings)) {
      expect(normaliseExtract(recording), `${name} recording did not normalise`).not.toBeNull()
    }
  })

  for (const [name, recording] of Object.entries(recordings)) {
    it(`reads ${name} the way pdf.js does`, async () => {
      const doc = await open(name)
      for (let pageIndex = 0; pageIndex < pageCounts[name]; pageIndex += 1) {
        const fromSidecar = await recovered(doc, recording, pageIndex)
        const fromBrowser = await extractPage(
          await doc.getPage(pageIndex + 1),
          optionsFor(pageIndex),
        )
        expectSamePage(fromSidecar, fromBrowser)
      }
    }, 60_000)
  }

  it('keeps the table as real cells on both paths', async () => {
    const doc = await open('table.pdf')
    const sidecar = await recovered(doc, recordings['table.pdf'], 0)
    const browser = await extractPage(await doc.getPage(1), optionsFor(0))

    const cells = (page: ExtractedPage) =>
      page.blocks.find((block) => block.kind === 'table')?.tableCells
    expect(cells(sidecar)).toEqual([
      ['Region', 'Q1', 'Q2'],
      ['North', '120', '150'],
      ['South', '90', '110'],
      ['East', '75', '80'],
    ])
    expect(cells(sidecar)).toEqual(cells(browser))
  })

  it('keeps the figure a recovered page carries, on both paths', async () => {
    const doc = await open('mixed.pdf')
    const sidecar = await recovered(doc, recordings['mixed.pdf'], 0)
    const browser = await extractPage(await doc.getPage(1), optionsFor(0))

    const owner = (page: ExtractedPage) => page.blocks.find((block) => block.figures.length > 0)
    // Without the placements the runtime hands over, the sidecar page comes
    // back with a caption naming a picture nothing is attached to — and every
    // `figures` comparison in `shape` would pass for having no opinion at all.
    expect(owner(sidecar)?.figures).toEqual([
      { bbox: { x: 280, y: 432, w: 300, h: 300 }, pixelWidth: 90, pixelHeight: 110 },
    ])
    expect(owner(sidecar)?.text).toBe(owner(browser)?.text)
  })

  it('anchors a link on the words it covers, on both paths', async () => {
    const doc = await open('links.pdf')
    const sidecar = await recovered(doc, recordings['links.pdf'], 0)
    const browser = await extractPage(await doc.getPage(1), optionsFor(0))

    expect(sidecar.blocks.filter((block) => block.links.length > 0).length).toBeGreaterThan(0)
    expect(shape(sidecar.blocks).map((block) => block.links)).toEqual(
      shape(browser.blocks).map((block) => block.links),
    )
    for (const block of sidecar.blocks) {
      for (const link of block.links) expect(block.text).toContain(link.text)
    }
  })
})

describe('pages the sidecar declines', () => {
  // A declined page is not a failure — the browser keeps it. What matters is
  // that the reason is specific enough to test, because "declined somehow"
  // would hide a normaliser that quietly refuses everything.
  it('refuses a rotated watermark, whose box cannot carry the tilt', () => {
    const pages = pagesOf(recorded('complex'))
    expect(pages).toHaveLength(1)
    expect(pages[0].index).toBe(0)
    expect(pages[0].decline).toBe('line-rotation')
    expect(pages[0].source.items).toHaveLength(0)
  })

  it("refuses a scan, which the app's own OCR pipeline owns", () => {
    const pages = pagesOf(recorded('scanned'))
    expect(pages[0].decline).toBe('extraction-method')
  })

  it('refuses every page of a payload that is not the expected protocol', () => {
    expect(normaliseExtract({ ok: false, error: 'boom' })).toBeNull()
    expect(normaliseExtract({ ok: true })).toBeNull()
    expect(normaliseExtract({ ok: true, pages: [null] })).toBeNull()
    expect(normaliseExtract({ ok: true, pages: [{ width: 612 }] })).toBeNull()
    expect(normaliseExtract(null)).toBeNull()
    expect(normaliseExtract('ok')).toBeNull()
  })
})
