// @vitest-environment node
/**
 * End-to-end extraction pipeline against the generated PDF fixtures.
 *
 * Runs in the Node environment so pdf.js parses real files (no canvas, no
 * worker): metadata → probe → block extraction, exactly the code path the
 * analysis worker drives in the browser.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  getDocument,
  PasswordException,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import { extractPage, parsePdfDate, probeDocument, readDocumentInfo } from './pdfExtract'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url))))

const tasks: PDFDocumentLoadingTask[] = []

async function open(name: string, password?: string): Promise<PDFDocumentProxy> {
  const task = getDocument({
    data: fixture(name),
    password,
    useSystemFonts: true,
    verbosity: 0,
  })
  tasks.push(task)
  return task.promise
}

afterAll(async () => {
  await Promise.all(tasks.map((task) => task.destroy().catch(() => undefined)))
})

describe('parsePdfDate', () => {
  it('parses a full PDF date with a zone', () => {
    expect(parsePdfDate("D:20260115093000+06'30'")).toBe('2026-01-15T03:00:00.000Z')
  })

  it('parses a partial date and rejects garbage', () => {
    expect(parsePdfDate('D:20260115')).toBe('2026-01-15T00:00:00.000Z')
    expect(parsePdfDate('not a date')).toBeNull()
    expect(parsePdfDate(null)).toBeNull()
    expect(parsePdfDate('D:20260115Z')).toBe('2026-01-15T00:00:00.000Z')
  })
})

describe('text-300p.pdf', () => {
  let doc: PDFDocumentProxy
  let summary: Awaited<ReturnType<typeof probeDocument>>['summary']
  let probes: Awaited<ReturnType<typeof probeDocument>>['probes']
  let fonts: Awaited<ReturnType<typeof probeDocument>>['info']['fonts']
  let progress: number[]

  beforeAll(async () => {
    doc = await open('text-300p.pdf')
    progress = []
    const result = await probeDocument(doc, { onProgress: (done) => progress.push(done) })
    summary = result.summary
    probes = result.probes
    fonts = result.info.fonts
  }, 120_000)

  it('reads document metadata', async () => {
    const info = await readDocumentInfo(doc)
    expect(info.pageCount).toBe(300)
    expect(info.pdfVersion).toBe('1.4')
    expect(info.title).toBe('Annual Report 2026')
    expect(info.author).toBe('Finance Department')
    expect(info.producer).toBe('make-fixtures.mjs')
    expect(info.creationDate).toBe('2026-01-15T03:00:00.000Z')
    expect(info.encrypted).toBe(false)
    expect(info.tagged).toBeNull()
    expect(info.permissionsRestricted).toBe(false)
    expect(info.formFieldCount).toBe(0)
  })

  it('probed every page and reported progress', () => {
    expect(probes).toHaveLength(300)
    expect(progress).toHaveLength(300)
    expect(progress[progress.length - 1]).toBe(300)

    expect(summary.tally).toEqual({ text: 300, scanned: 0, mixed: 0, complex: 0, empty: 0 })
    expect(summary.textLayerPages).toBe(300)
    expect(summary.ocrNeededPages).toBe(0)
    expect(summary.totalChars).toBeGreaterThan(50_000)
    expect(summary.documentLanguage).toBe('en')
    expect(summary.convertZawgyi).toBe(false)
    expect(summary.annotations).toBe(0)
    // The heading ladder rides along with the running heads: a level means
    // nothing unless a page can see the document's *other* headings, and the
    // probe is the only place that has them all in hand at once.
    expect(summary.headingSizes?.length).toBeGreaterThan(0)
    expect(summary.headingSizes![0]).toBeGreaterThan(0)
    expect([...summary.headingSizes!].sort((a, b) => b - a)).toEqual(summary.headingSizes)
    // Helvetica and Helvetica-Bold, both referenced rather than embedded.
    expect(fonts.distinct).toBeGreaterThanOrEqual(2)
    expect(fonts.standard).toBeGreaterThanOrEqual(1)
    expect(fonts.embedded).toBe(0)

    const first = probes[0]
    expect(first.contentClass).toBe('text')
    expect(first.width).toBe(612)
    expect(first.height).toBe(792)
    expect(first.textCoverage).toBeGreaterThan(0.02)
    expect(first.imageCount).toBe(0)
    expect(first.lineCount).toBeGreaterThan(5)
    expect(first.detectedLanguage).toBe('en')
  })

  it('detects the running head and foot', () => {
    expect(summary.headerTexts).toContain('annual report # - chapter #')
    expect(summary.footerTexts).toContain('page # of #')
  })

  it('extracts ordered blocks for a page, stably across re-parses', async () => {
    const page = await doc.getPage(1)

    const first = await extractPage(page, {
      pageIndex: 0,
      ctx: { sourceLang: 'en', targetLang: 'my' },
      headerTexts: summary.headerTexts,
      footerTexts: summary.footerTexts,
    })
    const second = await extractPage(page, {
      pageIndex: 0,
      ctx: { sourceLang: 'en', targetLang: 'my' },
      headerTexts: summary.headerTexts,
      footerTexts: summary.footerTexts,
    })

    expect(second.blocks).toEqual(first.blocks)
    expect(first.blocks.length).toBeGreaterThan(3)
    expect(first.blocks.map((block) => block.order)).toEqual(first.blocks.map((_, index) => index))

    const regions = first.blocks.map((block) => block.region)
    expect(regions).toContain('header')
    expect(regions).toContain('footer')
    expect(regions).toContain('body')

    const header = first.blocks.find((block) => block.region === 'header')
    expect(header?.text).toBe('Annual Report 2026 - Chapter 1')

    const footer = first.blocks.find((block) => block.region === 'footer')
    expect(footer?.text).toBe('Page 1 of 300')

    // Bullet list captured with its marker.
    const list = first.blocks.filter((block) => block.listMarker)
    expect(list.length).toBeGreaterThanOrEqual(3)
    expect(list[0].listMarker).toBe('•')
    expect(list[0].kind).toBe('list')

    // Skip rules: the URL and the formula are not translated.
    const skipped = first.blocks.filter((block) => block.skipRule)
    expect(skipped.map((block) => block.skipRule)).toEqual(
      expect.arrayContaining(['url', 'formula']),
    )

    // Every block keeps the font style it was found with.
    const body = first.blocks.find((block) => block.region === 'body' && block.kind === 'heading')
    expect(body?.text).toBe('Introduction')
    // A heading knows its depth in the document ladder; nothing else does.
    expect(typeof body?.headingLevel).toBe('number')
    expect(body!.headingLevel!).toBeGreaterThanOrEqual(1)
    expect(first.blocks.filter((block) => block.kind !== 'heading')).toHaveLength(
      first.blocks.filter((block) => block.headingLevel === null).length,
    )
  })

  it('treats a re-opened document as producing identical block ids', async () => {
    const second = await open('text-300p.pdf')
    const options = {
      pageIndex: 0,
      ctx: { sourceLang: 'en', targetLang: 'my' },
      headerTexts: summary.headerTexts,
      footerTexts: summary.footerTexts,
    }
    const a = await extractPage(await doc.getPage(1), options)
    const b = await extractPage(await second.getPage(1), options)
    expect(b.blocks.map((block) => block.id)).toEqual(a.blocks.map((block) => block.id))
  })
})

describe('scanned.pdf', () => {
  it('flags every page as scanned and reports an OCR workload', async () => {
    const doc = await open('scanned.pdf')
    const result = await probeDocument(doc)

    expect(result.probes).toHaveLength(3)
    expect(result.summary.tally).toEqual({ text: 0, scanned: 3, mixed: 0, complex: 0, empty: 0 })
    expect(result.summary.ocrNeededPages).toBe(3)
    expect(result.summary.textLayerPages).toBe(0)
    expect(result.summary.totalChars).toBe(0)
    expect(result.summary.totalImages).toBe(3)
    expect(result.probes[0].imageCount).toBe(1)
    expect(result.summary.documentLanguage).toBeNull()

    const page = await doc.getPage(1)
    const extracted = await extractPage(page, { pageIndex: 0 })
    expect(extracted.blocks).toHaveLength(0)
  })
})

describe('mixed.pdf', () => {
  it('separates the half-scanned page from the plain text page', async () => {
    const doc = await open('mixed.pdf')
    const result = await probeDocument(doc)

    expect(result.probes.map((probe) => probe.contentClass)).toEqual(['mixed', 'text'])
    expect(result.summary.tally).toEqual({ text: 1, scanned: 0, mixed: 1, complex: 0, empty: 0 })
    expect(result.summary.textLayerPages).toBe(2)
    expect(result.summary.ocrNeededPages).toBe(0)
    expect(result.summary.totalImages).toBe(1)

    const page = await doc.getPage(1)
    const extracted = await extractPage(page, { pageIndex: 0 })
    expect(extracted.blocks.length).toBeGreaterThan(1)
    expect(extracted.blocks.some((block) => block.text.includes('deployment pipeline'))).toBe(true)
  })
})

describe('links.pdf', () => {
  // Five `/Link` annotations over five three-line paragraphs, written in
  // Courier so every rectangle is exact: a URL mid-line, a word mid-line, an
  // internal destination, a `data:` URI and a URI with no scheme at all.
  let blocks: Awaited<ReturnType<typeof extractPage>>['blocks']

  beforeAll(async () => {
    const doc = await open('links.pdf')
    const page = await doc.getPage(1)
    blocks = (await extractPage(page, { pageIndex: 0 })).blocks
  })

  const linksOf = (needle: string) => blocks.find((block) => block.text.includes(needle))?.links

  it('attaches a mid-line URL to exactly the characters it covers', () => {
    expect(linksOf('Read more at')).toEqual([
      { text: 'https://example.com/api', url: 'https://example.com/api' },
    ])
  })

  it('attaches an ordinary word without swallowing the rest of the line', () => {
    expect(linksOf('pricing page')).toEqual([
      { text: 'pricing page', url: 'https://example.com/pricing' },
    ])
  })

  it('skips an internal destination, which is not a URL', () => {
    expect(linksOf('Section 7')).toEqual([])
  })

  it('rejects a scheme a browser would execute rather than navigate', () => {
    expect(linksOf('data:payload')).toEqual([])
  })

  it('keeps a URI pdf.js could only reach by giving it a scheme', () => {
    // pdf.js canonicalises `www.example.org/spec` to `http://…` itself; what
    // matters is that a scheme-less URI still ends up somewhere navigable and
    // anchored on the words that were underlined in the source.
    expect(linksOf('index lives')).toEqual([
      { text: 'www.example.org/spec', url: 'http://www.example.org/spec' },
    ])
  })

  it('splits the page into one block per paragraph, so links stay where they were read', () => {
    // Three-line paragraphs: the leading is tight inside one and twice as
    // wide between two, which is the only signal `structurePage` has. Each
    // linked line therefore owns its anchor instead of sharing a block with
    // four other annotations.
    const paragraphs = blocks.filter((block) => block.lines.length === 3)
    expect(paragraphs).toHaveLength(5)
    // Paragraph 1 (the URL) and paragraph 2 (the word) hold their own link;
    // paragraphs 3 and 4 (internal, `data:`) hold nothing at all.
    expect(paragraphs.map((block) => block.links.length)).toEqual([1, 1, 0, 0, 1])
  })

  it('never offers an anchor that is not part of the block it sits on', () => {
    for (const block of blocks) {
      for (const link of block.links) {
        expect(block.text).toContain(link.text)
      }
    }
  })

  it('leaves every block holding a list, never undefined', () => {
    expect(blocks.length).toBeGreaterThan(4)
    expect(blocks.every((block) => Array.isArray(block.links))).toBe(true)
  })
})

describe('complex.pdf', () => {
  it('classifies the three-column watermark page as complex', async () => {
    const doc = await open('complex.pdf')
    const result = await probeDocument(doc)

    expect(result.probes).toHaveLength(1)
    const probe = result.probes[0]
    expect(probe.contentClass).toBe('complex')
    expect(probe.layout.complex).toBe(true)
    expect(probe.layout.reasons).toContain('columns3')
    expect(result.summary.tally).toEqual({ text: 0, scanned: 0, mixed: 0, complex: 1, empty: 0 })
    // A complex page still has a usable text layer — OCR is not required.
    expect(result.summary.textLayerPages).toBe(1)
    expect(result.summary.ocrNeededPages).toBe(0)

    // The text itself must still extract (reading order is the tricky part).
    const page = await doc.getPage(1)
    const extracted = await extractPage(page, { pageIndex: 0 })
    expect(extracted.blocks.length).toBeGreaterThan(1)
    expect(extracted.blocks.some((block) => block.text.includes('Column filler line'))).toBe(true)
  })

  it('reads the three columns column-by-column and leaves the watermark last', async () => {
    const doc = await open('complex.pdf')
    const page = await doc.getPage(1)
    const extracted = await extractPage(page, { pageIndex: 0 })
    const body = extracted.blocks
      .filter((block) => block.region === 'body')
      .sort((a, b) => a.order - b.order)

    // One block per column, in left-to-right order. Before the gutter band kept
    // its exact edges, the last row of the page survived the column cut fused
    // across the fold, and that one fused line sent the whole right-hand side
    // of the page back to row-by-row order.
    const columns = body.filter((block) => block.text.includes('Column filler'))
    expect(columns.map((block) => Math.round(block.bbox.x))).toEqual([40, 226, 412])

    // Every column is whole and top-to-bottom: lines 1 … 10, nothing missing,
    // nothing from a neighbouring column interleaved.
    for (const column of columns) {
      expect([...column.text.matchAll(/line (\d+) of/g)].map((match) => match[1])).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
      ])
    }

    // The rotated watermark is an overlay: it belongs after the body it crosses,
    // not wedged between column two and column three.
    expect(body[body.length - 1].text).toContain('DRAFT COPY')
  })
})

describe('encrypted.pdf', () => {
  it('refuses to open without the password', async () => {
    await expect(open('encrypted.pdf')).rejects.toBeInstanceOf(PasswordException)
  })

  it('opens with the password and reports encryption', async () => {
    const doc = await open('encrypted.pdf', 'secret123')
    const info = await readDocumentInfo(doc)
    expect(info.encrypted).toBe(true)
    expect(info.pageCount).toBe(3)

    const result = await probeDocument(doc)
    expect(result.summary.textLayerPages).toBe(3)
    expect(result.summary.totalChars).toBeGreaterThan(100)
  })

  it('rejects a wrong password', async () => {
    await expect(open('encrypted.pdf', 'wrong-password')).rejects.toBeInstanceOf(PasswordException)
  })
})
