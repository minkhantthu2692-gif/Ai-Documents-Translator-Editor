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
import {
  extractPage,
  needsSidecarFallback,
  parsePdfDate,
  probeDocument,
  readDocumentInfo,
  type ExtractedPage,
} from './pdfExtract'
import type { PageBlock } from './structure'

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

/** Extracts one page with the options the worker sends for an ordinary run. */
async function extractAt(doc: PDFDocumentProxy, pageIndex: number): Promise<ExtractedPage> {
  return extractPage(await doc.getPage(pageIndex + 1), {
    pageIndex,
    ctx: { sourceLang: 'en', targetLang: 'my' },
    headerTexts: [],
    footerTexts: [],
  })
}

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

  it('gives the picture to the paragraph, not to a running head that reads like a label', async () => {
    const doc = await open('mixed.pdf')
    const { blocks } = await extractAt(doc, 0)

    // The running head is `Figure 1 - …`, which matches the label pattern as
    // well as any real caption does. It is four hundred points away from the
    // picture, and that is what must decide — a name alone is not a pairing.
    expect(blocks.find((block) => block.text.startsWith('Figure 1 -'))?.figures).toEqual([])
    const owner = blocks.find((block) => block.figures.length > 0)
    expect(owner?.text).toContain('The figure shows the stages')
    expect(owner?.figures).toEqual([
      { bbox: { x: 280, y: 432, w: 300, h: 300 }, pixelWidth: 90, pixelHeight: 110 },
    ])
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

describe('table.pdf', () => {
  const extract = async (doc: PDFDocumentProxy, pageIndex: number) => {
    const page = await doc.getPage(pageIndex + 1)
    return extractPage(page, {
      pageIndex,
      ctx: { sourceLang: 'en', targetLang: 'my' },
      headerTexts: [],
      footerTexts: [],
    })
  }

  it('reads a table drawn cell by cell as one block of real cells', async () => {
    const doc = await open('table.pdf')
    const { blocks } = await extract(doc, 0)

    const table = blocks.find((block) => block.kind === 'table')
    expect(table).toBeDefined()
    expect(table?.tableCells).toEqual([
      ['Region', 'Q1', 'Q2'],
      ['North', '120', '150'],
      ['South', '90', '110'],
      ['East', '75', '80'],
    ])
    // The text form is unchanged — the model still sees ` \t ` between cells —
    // but it is built from the grid now, so the two can never disagree.
    expect(table?.text.split('\n')).toEqual([
      'Region \t Q1 \t Q2',
      'North \t 120 \t 150',
      'South \t 90 \t 110',
      'East \t 75 \t 80',
    ])
    // Nothing on this table straddles a column, so the exporters are told
    // nothing rather than handed a row of ones.
    expect(table?.tableSpans).toBeNull()
  })

  it('keeps the prose either side of a table out of it', async () => {
    const doc = await open('table.pdf')
    const { blocks } = await extract(doc, 0)

    const tables = blocks.filter((block) => block.kind === 'table')
    expect(tables).toHaveLength(1)
    const prose = blocks.filter((block) => block.kind !== 'table').map((block) => block.text)
    expect(prose.join('\n')).toContain('Revenue was reviewed')
    expect(prose.join('\n')).toContain('without amendment')
    expect(prose.join('\n')).toContain('Quarterly revenue')
  })

  it('pads a row whose middle cell is empty back out to the full width', async () => {
    const doc = await open('table.pdf')
    const { blocks } = await extract(doc, 1)

    const table = blocks.find((block) => block.kind === 'table')
    expect(table?.tableCells).toEqual([
      ['Product', 'Units', 'Notes'],
      ['Widget', '120', 'restocked'],
      ['Gadget', '', 'clearance'],
      ['Gizmo', '80', 'backorder'],
    ])
  })
})

describe('table-spans.pdf', () => {
  it('reads a header drawn across two columns as one merged cell', async () => {
    const doc = await open('table-spans.pdf')
    const { blocks } = await extractAt(doc, 0)

    const table = blocks.find((block) => block.kind === 'table')
    expect(table?.tableCells).toEqual([
      ['Region', 'First half 2026', ''],
      ['North', '120', '150'],
      ['South', '90', '110'],
      ['East', '75', '80'],
    ])
    // The merge is read off the *source* geometry and kept beside the cells
    // rather than inside them: the covered column holds no text of its own, the
    // row stays three wide, and `text` is exactly what it was before spans
    // existed — so the translation cache and the model see no change at all.
    expect(table?.tableSpans).toEqual([
      [1, 2, 0],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ])
    expect(table?.text.split('\n')).toEqual([
      'Region \t First half 2026 \t ',
      'North \t 120 \t 150',
      'South \t 90 \t 110',
      'East \t 75 \t 80',
    ])
  })

  it('keeps the prose either side of the table out of it', async () => {
    const doc = await open('table-spans.pdf')
    const { blocks } = await extractAt(doc, 0)

    const prose = blocks.filter((block) => block.kind !== 'table').map((block) => block.text)
    expect(prose.join('\n')).toContain('drawn across both figure columns')
    expect(prose.join('\n')).toContain('spans both figure columns')
  })
})

describe('figure.pdf', () => {
  // Six images are painted across the two pages; only two of them are figures.
  // The rest are page furniture — a wash, a logo, an icon — or texture the
  // body text is printed on, and a flow export must not drag any of them in.
  const figuresOn = async (doc: PDFDocumentProxy, pageIndex: number) => {
    const { blocks } = await extractAt(doc, pageIndex)
    return blocks.flatMap((block) => block.figures)
  }

  it('reports every image the fixture paints, so the two survivors are a choice', async () => {
    const doc = await open('figure.pdf')
    const probe = await probeDocument(doc)
    expect(probe.summary.tally).toEqual({ text: 0, scanned: 0, mixed: 2, complex: 0, empty: 0 })
    expect(probe.summary.totalImages).toBe(6)
    expect((await figuresOn(doc, 0)).length + (await figuresOn(doc, 1)).length).toBe(2)
  })

  it('anchors a figure to the caption that labels it', async () => {
    const doc = await open('figure.pdf')
    const { blocks } = await extractAt(doc, 0)

    const caption = blocks.find((block) => block.text.startsWith('Figure 1.'))
    expect(caption).toBeDefined()
    expect(caption?.figures).toEqual([
      { bbox: { x: 156, y: 132, w: 300, h: 140 }, pixelWidth: 90, pixelHeight: 110 },
    ])
    // Exactly one block owns a picture, so an exporter emitting `<figure>` per
    // block cannot duplicate it.
    expect(blocks.filter((block) => block.figures.length > 0)).toHaveLength(1)
    // The prose above the picture and the paragraph below the caption are not
    // the caption, however much closer to the image they may be.
    expect(blocks.find((block) => block.text.startsWith('Rollback'))?.figures).toEqual([])
  })

  it('falls back to the nearest paragraph when a figure has no label', async () => {
    const doc = await open('figure.pdf')
    const { blocks } = await extractAt(doc, 1)

    const owner = blocks.find((block) => block.figures.length > 0)
    expect(owner?.text).toContain('The picture above lists the four stages')
    expect(owner?.figures).toEqual([
      { bbox: { x: 72, y: 72, w: 240, h: 160 }, pixelWidth: 90, pixelHeight: 110 },
    ])
  })

  it('passes over texture under type, a wash, a logo and an icon', async () => {
    const doc = await open('figure.pdf')
    const { blocks } = await extractAt(doc, 1)

    // The paragraph printed on the 460 × 150 texture must not carry it: it is
    // background, and it covers the whole of the picture.
    expect(blocks.find((block) => block.text.startsWith('The quarterly review'))?.figures).toEqual(
      [],
    )
    expect(blocks.every((block) => block.figures.length <= 1)).toBe(true)
    expect(await figuresOn(doc, 1)).toHaveLength(1)
  })
})

describe('form.pdf', () => {
  // A fillable form's *printed* labels — `Full Name:`, `Country:` — are
  // ordinary content-stream text and were never at risk: they come through the
  // normal line → block path with nothing done to them. What nothing else in
  // the pipeline can reach is the text the **widget** carries: its `/TU`
  // tooltip and a dropdown's option captions, neither of which is printed
  // anywhere on the page.
  const fieldsOn = async (doc: PDFDocumentProxy, pageIndex: number) => {
    const { blocks } = await extractAt(doc, pageIndex)
    return blocks.filter((block) => block.kind === 'form-field')
  }

  it('counts every widget in the probe, hidden ones included', async () => {
    const doc = await open('form.pdf')
    const probe = await probeDocument(doc)
    expect(probe.summary.formFields).toBe(10)
    expect(probe.summary.tally).toEqual({ text: 2, scanned: 0, mixed: 0, complex: 0, empty: 0 })
  })

  it('drops each description in directly after the label it describes', async () => {
    const doc = await open('form.pdf')
    const { blocks } = await extractAt(doc, 0)
    expect(blocks.map((block) => block.text)).toEqual([
      'Application form',
      'Complete every field in block capitals. Signed forms are kept for seven years.',
      'Full Name:',
      'Full name of the applicant',
      'Date of Birth:',
      'Date of birth, day month year',
      'Country:',
      'Country of residence\nMyanmar\nThailand\nViet Nam\nLao PDR',
      'I agree to the terms',
      'I have read and accept the terms',
    ])
    expect(blocks.filter((block) => block.kind === 'form-field')).toHaveLength(4)
  })

  it("carries a dropdown's option captions as content, not as chrome", async () => {
    const doc = await open('form.pdf')
    const { blocks } = await extractAt(doc, 0)
    const country = blocks.find((block) => block.text.startsWith('Country of residence'))
    expect(country?.kind).toBe('form-field')
    expect(country?.lines.map((line) => line.text)).toEqual([
      'Country of residence',
      'Myanmar',
      'Thailand',
      'Viet Nam',
      'Lao PDR',
    ])
    // Long enough to hold every caption rather than squeezing five of them
    // into the 16 pt box the dropdown actually occupies.
    expect(country?.bbox.h).toBeGreaterThan(16)
    // Everything the widget carries is content: it reaches the model.
    expect(country?.skipRule).toBeNull()
    expect(country?.italic).toBe(true)
  })

  it("hangs every description under its own widget, at that widget's width", async () => {
    const doc = await open('form.pdf')
    const { blocks } = await extractAt(doc, 1)
    const email = blocks.find((block) => block.kind === 'form-field')
    // The email widget is `[180 570 400 586]`: 792 − 586 = 206, +16 = 222.
    expect(email?.text).toBe('Electronic mail address')
    expect(email?.bbox).toEqual({ x: 180, y: 222, w: 220, h: 13.5 })
    // Printed text is exactly where it was, in the same order.
    expect(blocks.map((block) => block.text)).toEqual([
      'Contact details',
      'Email:',
      'Electronic mail address',
      'By post By email',
      'Signature',
      'Signature of the applicant',
    ])
  })

  it('says nothing for a hidden field, a radio group or a push button', async () => {
    const doc = await open('form.pdf')
    const described = [...(await fieldsOn(doc, 0)), ...(await fieldsOn(doc, 1))].map(
      (block) => block.text,
    )

    // `/F` hidden: shown to nobody and announced to nobody.
    expect(described).not.toContain('Internal reference number')
    // The radio group *does* carry a `/TU` — on its parent field — and pdf.js
    // hands over widget annotations only, so a group's own caption never
    // reaches this pass. Its options are printed on the page instead (`By
    // post`, `By email`), which is what the form's author did here anyway.
    // A push button with no `/TU` has nothing to say either.
    expect(described).toHaveLength(6)
  })
})

describe('annotations.pdf', () => {
  // A reviewed page keeps its marginalia in the annotation dictionary rather
  // than in the content stream, and nothing before this pass could reach it:
  // not grouping, not reading order, not links, not figures, not form labels.
  const notesOn = async (doc: PDFDocumentProxy) => {
    const { blocks } = await extractAt(doc, 0)
    return blocks.filter((block) => block.kind === 'annotation')
  }

  it('counts every annotation in the probe, speaking or not', async () => {
    const doc = await open('annotations.pdf')
    const probe = await probeDocument(doc)
    expect(probe.summary.annotations).toBe(9)
  })

  it('turns the four notes that say something into blocks', async () => {
    const doc = await open('annotations.pdf')
    // Annotation order: the highlight's reason, the sticky note, the callout,
    // the stamp. The other five annotations on the page produce nothing.
    expect((await notesOn(doc)).map((block) => block.text)).toEqual([
      'Please confirm this figure against the ledger before filing.',
      'Check this figure with the finance team.',
      'Updated for the 2026 reporting cycle.',
      'Approved by the audit committee.',
    ])
  })

  it('files the highlight right under the passage it marks, in that column', async () => {
    const doc = await open('annotations.pdf')
    const { blocks } = await extractAt(doc, 0)
    const passage = blocks.find((block) => block.text.startsWith('Revenue rose')) as PageBlock
    const note = blocks.find((block) => block.text.startsWith('Please confirm')) as PageBlock
    // Immediately after, not somewhere later in the page's order: the note is
    // *about* that passage and nothing else.
    expect(blocks.indexOf(note)).toBe(blocks.indexOf(passage) + 1)
    expect(note.bbox.x).toBe(passage.bbox.x)
    expect(note.bbox.w).toBe(passage.bbox.w)
    expect(note.bbox.y).toBeCloseTo(passage.bbox.y + passage.bbox.h, 4)
    // The one thing set deliberately: this text was never printed.
    expect(note.italic).toBe(true)
    expect(note.color).toBe('#6b7280')
    expect(note.fontSize).toBe(passage.fontSize)
  })

  it('hangs the callout and the stamp in the empty space they were drawn in', async () => {
    const doc = await open('annotations.pdf')
    const { blocks } = await extractAt(doc, 0)
    const callout = blocks.find((block) => block.text.startsWith('Updated for')) as PageBlock
    const stamp = blocks.find((block) => block.text.startsWith('Approved by')) as PageBlock
    // The callout's rectangle is `[72 545 400 575]`: 792 − 575 = 217, +30.
    expect(callout.bbox).toEqual({ x: 72, y: 247, w: 328, h: 13.5 })
    // The stamp's legend is longer than the 130 pt box, so it is cut to the
    // room that is left — 612 − 430 − 12 — and wraps inside it rather than
    // running off the right edge of the page.
    expect(stamp.bbox.x).toBe(430)
    expect(stamp.bbox.w).toBe(170)
    expect(stamp.lines.map((line) => line.text)).toEqual(['Approved by the audit', 'committee.'])
    expect(stamp.bbox.x + stamp.bbox.w).toBeLessThanOrEqual(612)
  })

  it('says nothing for a link, a hidden note, a popup or an empty one', async () => {
    const doc = await open('annotations.pdf')
    const { blocks } = await extractAt(doc, 0)
    const all = blocks.map((block) => block.text).join('\n')

    // A link that also carries `/Contents` stays a link: `links.ts` owns it.
    expect(all).not.toContain('The note must not become a note.')
    // `/F 2`: shown to nobody, announced to nobody.
    expect(all).not.toContain('Hidden note that must not appear.')
    // A popup repeats its parent's words at another rectangle, so only the
    // subtype keeps the note from being printed twice.
    expect(all.split('Please confirm this figure against the ledger before filing.')).toHaveLength(
      2,
    )
    // A note with nothing in it is not a block with nothing in it.
    expect(blocks.some((block) => block.text.trim().length === 0)).toBe(false)

    // The widget's `/TU` is still a form label, and only a form label: the two
    // passes take one annotation each rather than both taking both.
    expect(
      blocks.filter((block) => block.kind === 'form-field').map((block) => block.text),
    ).toEqual(['Name of the reviewer'])
  })

  it('leaves every printed line exactly where it was', async () => {
    const doc = await open('annotations.pdf')
    const { blocks } = await extractAt(doc, 0)
    expect(blocks.filter((block) => block.kind === 'paragraph').map((block) => block.text)).toEqual(
      [
        'Annual Report 2026',
        'Revenue rose twelve percent against the same quarter.\nOperating costs were held flat for the third period.',
        'Deferred income is recognised on delivery.\nThe audit committee met twice in the period.',
        'Notes are attached to the relevant paragraph.\nEvery figure is reconciled to the ledger.',
        'Page 1 of 1',
      ],
    )
    expect(blocks.map((block) => block.order)).toEqual(blocks.map((_, index) => index))
  })
})

describe('needsSidecarFallback', () => {
  const page = (charCount: number, blocks: ExtractedPage['blocks']): ExtractedPage => ({
    pageIndex: 0,
    width: 612,
    height: 792,
    rotation: 0,
    charCount,
    lineCount: blocks.length,
    blocks,
  })
  const someBlock = {} as ExtractedPage['blocks'][number]

  it('asks for a second reader only when text arrived that could not be placed', () => {
    // The silent failure worth a sidecar round trip: pdf.js handed over 400
    // characters and the grouper rejected every run, so no block exists to
    // show the user. `structurePage` cannot return empty for non-empty lines,
    // so this shape is unreachable unless pdf.js's geometry was unusable.
    expect(needsSidecarFallback(page(400, []))).toBe(true)
  })

  it('leaves a page that produced blocks to pdf.js', () => {
    expect(needsSidecarFallback(page(400, [someBlock]))).toBe(false)
  })

  it('leaves a genuinely blank page alone — a scan has nothing to recover', () => {
    // Every scanned page of a 300-page document comes back with no text and
    // no blocks. That is the *correct* answer, so treating it as a failure
    // would pay the sidecar a second on each of them to arrive at the same
    // nothing, while the OCR pipeline reads them properly anyway.
    expect(needsSidecarFallback(page(0, []))).toBe(false)
  })
})
