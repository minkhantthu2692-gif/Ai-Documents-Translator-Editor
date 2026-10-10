import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import type { FigureRef } from '@/pdf/structure'
import { buildDocx, type DocxOptions } from './docx'
import type { ExportBlock, ExportDocument, ExportPage } from './types'

/** A traced figure for a page-space box, at the 2× the fixtures were rendered at. */
function ref(bbox: { x: number; y: number; w: number; h: number }): FigureRef {
  return { bbox, pixelWidth: bbox.w * 2, pixelHeight: bbox.h * 2 }
}

function block(partial: Partial<ExportBlock>): ExportBlock {
  return {
    id: 'block',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 10,
    y: 20,
    width: 500,
    height: 24,
    fontFamily: 'Noto Sans',
    fontSize: 12,
    lineHeight: 1.5,
    color: '#000000',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    links: [],
    figures: [],
    tableCells: null,
    tableSpans: null,
    sourceText: '',
    translatedText: '',
    characterCount: 0,
    skipRule: null,
    placeholders: [],
    direction: 'ltr',
    fittedFontSize: null,
    overflow: false,
    hasSuggestion: false,
    ...partial,
  }
}

function page(index: number, blocks: ExportBlock[]): ExportPage {
  return { index, width: 595, height: 842, rotation: 0, contentClass: 'text', blocks }
}

/** Two pages covering Latin, Myanmar, RTL, list, untranslated and emphasis. */
function fixtureDoc(): ExportDocument {
  return {
    schema: 1,
    projectId: 'prj_docx',
    title: 'မြန်မာစာ စာအုပ်',
    sourceFileName: 'sample.pdf',
    sourceLang: 'en',
    targetLang: 'my',
    pageCount: 2,
    exportedAt: 1_760_000_000_000,
    templateId: null,
    pages: [
      page(0, [
        block({
          id: 'latin',
          sourceText: 'Hello world',
          translatedText: 'မြန်မာစာ ကြိုဆိုပါသည်',
        }),
        block({
          id: 'arabic',
          order: 1,
          sourceText: 'Welcome',
          translatedText: 'مرحبا بالعالم',
          alignment: 'right',
        }),
        block({
          id: 'list',
          order: 2,
          listMarker: '1.',
          sourceText: 'First point',
          translatedText: 'ပထမအချက်',
        }),
        block({
          id: 'plain',
          order: 3,
          alignment: 'right',
          sourceText: 'Untranslated line',
          translatedText: '',
        }),
        block({
          id: 'emph',
          order: 4,
          bold: true,
          italic: true,
          color: '#ff0000',
          fontSize: 24,
          alignment: 'center',
          sourceText: 'Bold italic line',
          translatedText: 'ထူးခြားစာကြောင်း',
        }),
        block({ id: 'empty', order: 5, sourceText: '   ', translatedText: '' }),
        block({
          id: 'justified',
          order: 6,
          alignment: 'justified',
          sourceText: 'Justified paragraph',
          translatedText: 'ချိန်ညှိထားသောစာပိုဒ်',
        }),
      ]),
      page(1, [
        block({ id: 'p2', sourceText: 'Page two source', translatedText: 'စာမျက်နှာနှစ်' }),
      ]),
    ],
  }
}

function options(overrides: Partial<DocxOptions> = {}): DocxOptions {
  return {
    title: 'မြန်မာစာ စာအုပ်',
    includeOriginal: false,
    titleHeading: true,
    font: 'Noto Sans Myanmar',
    pageHeadings: false,
    pageBreaks: false,
    ...overrides,
  }
}

async function zipText(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file(path)
  if (!entry) throw new Error(`missing zip entry: ${path}`)
  return entry.async('string')
}

describe('buildDocx', () => {
  it('packs browser-safe DOCX bytes with the PK signature', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(1000)
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)

    const zip = await JSZip.loadAsync(bytes)
    const parts = [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'docProps/core.xml',
    ]
    for (const part of parts) {
      expect(zip.file(part), part).not.toBeNull()
    }
  })

  it('writes Myanmar text verbatim and skips empty blocks', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('မြန်မာစာ')
    expect(xml).not.toContain('   ')
  })

  it('declares the export font on runs and in the document defaults', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    const styles = await zipText(bytes, 'word/styles.xml')
    expect(xml).toContain('Noto Sans Myanmar')
    expect(styles).toContain('Noto Sans Myanmar')
  })

  it('marks RTL paragraphs bidirectional and right-to-left', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('<w:bidi/>')
    expect(xml).toContain('<w:rtl/>')
    // docx swaps left/right inside a bidi paragraph, so the RTL block's
    // physical right alignment is written as `w:jc w:val="left"`.
    expect(xml).toMatch(/<w:bidi\/><w:spacing[^>]*\/><w:jc[^>]*w:val="left"/)
  })

  it('maps alignment, emphasis, colour and font size', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toMatch(/<w:jc[^>]*w:val="center"/)
    expect(xml).toMatch(/<w:jc[^>]*w:val="both"/)
    expect(xml).toMatch(/<w:b\/>/)
    expect(xml).toMatch(/<w:i\/>/)
    expect(xml).toMatch(/<w:color[^>]*w:val="FF0000"/)
    expect(xml).toMatch(/<w:sz[^>]*w:val="48"/)
  })

  it('prefixes the list marker', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('1. ပထမအချက်')
  })

  it('emits the source before the translation when includeOriginal is on', async () => {
    const bilingual = await zipText(
      await buildDocx(fixtureDoc(), options({ includeOriginal: true })),
      'word/document.xml',
    )
    expect(bilingual.indexOf('Hello world')).toBeLessThan(
      bilingual.indexOf('မြန်မာစာ ကြိုဆိုပါသည်'),
    )
    expect(bilingual.indexOf('Welcome')).toBeLessThan(bilingual.indexOf('مرحبا بالعالم'))

    const mono = await zipText(await buildDocx(fixtureDoc(), options()), 'word/document.xml')
    expect(mono).not.toContain('Hello world')
    expect(mono).toContain('မြန်မာစာ ကြိုဆိုပါသည်')
  })

  it('adds the title heading, page headings and page breaks on request', async () => {
    const bytes = await buildDocx(
      fixtureDoc(),
      options({ titleHeading: true, pageHeadings: true, pageBreaks: true }),
    )
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('မြန်မာစာ စာအုပ်')
    expect(xml).toContain('Page 1')
    expect(xml).toContain('Page 2')
    expect(xml).toContain('w:type="page"')

    const plain = await zipText(await buildDocx(fixtureDoc(), options()), 'word/document.xml')
    expect(plain).not.toContain('w:type="page"')
    expect(plain).not.toContain('Page 1')
  })

  it('sizes the section from the first source page (points → twips)', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toMatch(/<w:pgSz[^>]*w:w="11900"/)
    expect(xml).toMatch(/<w:pgSz[^>]*w:h="16840"/)
  })

  it('sets the core properties', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const core = await zipText(bytes, 'docProps/core.xml')
    expect(core).toContain('မြန်မာစာ စာအုပ်')
    expect(core).toContain('AI Documents Translator')
    expect(core).toContain('en → my')
  })

  it('wraps builder failures in DOCX_FAILED', async () => {
    const broken = {
      get pages(): ExportPage[] {
        throw new Error('boom')
      },
    } as unknown as ExportDocument
    await expect(buildDocx(broken, options())).rejects.toThrow('DOCX_FAILED: boom')
  })
})

describe('buildDocx links', () => {
  async function bytesFor(links: ExportBlock['links'], text = 'See the pricing page for details.') {
    const doc: ExportDocument = {
      ...fixtureDoc(),
      pages: [page(0, [block({ id: 'linked', links, sourceText: text, translatedText: text })])],
    }
    return buildDocx(doc, options())
  }

  it('emits a hyperlink that keeps the run and declares an external relationship', async () => {
    const bytes = await bytesFor([{ text: 'pricing page', url: 'https://example.com/pricing' }])
    const xml = await zipText(bytes, 'word/document.xml')
    const rels = await zipText(bytes, 'word/_rels/document.xml.rels')

    expect(xml).toContain('<w:hyperlink')
    expect(xml).toContain('pricing page')
    expect(rels).toContain('Target="https://example.com/pricing"')
    expect(rels).toContain('TargetMode="External"')
  })

  it('keeps the surrounding text as ordinary runs', async () => {
    const xml = await zipText(
      await bytesFor([{ text: 'pricing page', url: 'https://example.com/pricing' }]),
      'word/document.xml',
    )
    // Three runs: before, inside, after — the hyperlink must not swallow the
    // paragraph, or the font and size of the rest are lost with it.
    expect(xml).toContain('See the ')
    expect(xml).toContain(' for details.')
    expect(xml.match(/<w:hyperlink/g)).toHaveLength(1)
  })

  it('drops a link whose URL would not be safe to navigate', async () => {
    const bytes = await bytesFor([{ text: 'Click me', url: 'javascript:alert(1)' }], 'Click me now')
    const xml = await zipText(bytes, 'word/document.xml')
    const rels = await zipText(bytes, 'word/_rels/document.xml.rels')
    expect(xml).not.toContain('<w:hyperlink')
    expect(rels).not.toContain('javascript:')
    expect(xml).toContain('Click me now')
  })

  it('writes no hyperlink for a block with no links', async () => {
    const xml = await zipText(await bytesFor([]), 'word/document.xml')
    expect(xml).not.toContain('<w:hyperlink')
  })

  it('prints an internal destination as words, never as a hash "web" link', async () => {
    // Word resolves in-document jumps through bookmarks this exporter does
    // not write; an ExternalHyperlink to `#page-3` would open as a broken
    // target. The words still print — only the destination is lost.
    const bytes = await bytesFor(
      [{ text: 'Introduction', url: '', destPage: 1 }],
      'See Introduction for the background.',
    )
    const xml = await zipText(bytes, 'word/document.xml')
    const rels = await zipText(bytes, 'word/_rels/document.xml.rels')
    expect(xml).toContain('Introduction')
    expect(xml).not.toContain('<w:hyperlink')
    expect(rels).not.toContain('#page-2')
  })
})

describe('buildDocx code blocks', () => {
  async function codeXml(
    overrides: Partial<ExportBlock> = {},
    docxOpts: Partial<DocxOptions> = {},
  ) {
    const doc: ExportDocument = {
      ...fixtureDoc(),
      pages: [
        page(0, [
          block({
            id: 'snippet',
            kind: 'code',
            status: 'skipped',
            skipRule: 'code',
            fontFamily: 'Courier',
            sourceText: 'if (a) {\n  b = 2;\n}',
            ...overrides,
          }),
        ]),
      ],
    }
    return zipText(await buildDocx(doc, options(docxOpts)), 'word/document.xml')
  }

  it('sets the snippet in a monospace face rather than the document one', async () => {
    const xml = await codeXml()
    expect(xml).toContain('w:ascii="Courier New"')
  })

  it('turns each newline into a real line break Word will keep', async () => {
    const xml = await codeXml()
    // A bare `\n` inside a run is discarded on the way to `<w:t>`.
    expect(xml.match(/<w:br\/>/g) ?? []).toHaveLength(2)
    expect(xml).not.toContain('if (a) {\n')
  })

  it('paints each token of the snippet in its palette colour', async () => {
    const snippet = 'const n = 42 // tally'
    const xml = await codeXml({ sourceText: snippet, translatedText: snippet })
    expect(xml).toContain('w:val="0000FF"') // `const` — keyword
    expect(xml).toContain('w:val="098658"') // `42` — number
    expect(xml).toContain('w:val="008000"') // `// tally` — comment
    // The font the snippet already wore is untouched by the palette.
    expect(xml).toContain('w:ascii="Courier New"')
  })

  it('gives the snippet no outline level and no bullet', async () => {
    const xml = await codeXml({ headingLevel: 1, listMarker: '1.' }, { titleHeading: false })
    expect(xml).not.toContain('Heading1')
    expect(xml).not.toContain('<w:outlineLvl')
    expect(xml).not.toContain('1. if (a)')
  })
})

describe('buildDocx tables', () => {
  async function tableXml(
    overrides: Partial<ExportBlock> = {},
    docxOpts: Partial<DocxOptions> = {},
  ) {
    const doc: ExportDocument = {
      ...fixtureDoc(),
      pages: [
        page(0, [
          block({
            id: 'tbl',
            kind: 'table',
            sourceText: 'Name \t Value\nAlpha \t 12',
            translatedText: 'Name \t Value\nAlpha \t 12',
            tableCells: [
              ['Name', 'Value'],
              ['Alpha', '12'],
            ],
            ...overrides,
          }),
        ]),
      ],
    }
    return zipText(await buildDocx(doc, options(docxOpts)), 'word/document.xml')
  }

  it('writes a real w:tbl with one cell per column', async () => {
    const xml = await tableXml()
    expect(xml).toContain('<w:tbl>')
    expect(xml.match(/<w:tc>/g) ?? []).toHaveLength(4)
    expect(xml).toContain('<w:t xml:space="preserve">Name</w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">Alpha</w:t>')
    expect(xml).not.toContain('Name \t Value')
  })

  it('merges cells with a gridSpan and writes no cell for the ones they cover', async () => {
    const xml = await tableXml({
      sourceText: 'Name \t First half 2026 \t \nAlpha \t \t 12',
      translatedText: 'Name \t First half 2026 \t \nAlpha \t \t 12',
      tableCells: [
        ['Name', 'First half 2026', ''],
        ['Alpha', '', '12'],
      ],
      tableSpans: [
        [1, 2, 0],
        [1, 1, 1],
      ],
    })
    // Row one draws two cells against row two's three, and five in total
    // rather than six: the covered column is not a cell of its own, or the
    // row would come out wider than the one below it.
    expect(xml).toContain('<w:gridSpan w:val="2"/>')
    expect(xml.match(/<w:tc>/g) ?? []).toHaveLength(5)
    expect(xml).toContain('<w:t xml:space="preserve">First half 2026</w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">12</w:t>')
  })

  it('drops the merge when the printed grid is no longer that shape', async () => {
    const xml = await tableXml({
      translatedText: 'Name \t First half 2026\nAlpha \t 12',
      tableCells: [
        ['Name', 'First half 2026', ''],
        ['Alpha', '', '12'],
      ],
      tableSpans: [
        [1, 2, 0],
        [1, 1, 1],
      ],
    })
    expect(xml).not.toContain('gridSpan')
    expect(xml.match(/<w:tc>/g) ?? []).toHaveLength(4)
  })

  it('gives the table no outline level and no bullet', async () => {
    const xml = await tableXml({ headingLevel: 1, listMarker: '1.' }, { titleHeading: false })
    expect(xml).not.toContain('Heading1')
    expect(xml).not.toContain('1. Name')
  })

  it('falls back to a paragraph when the printed text has no cells left', async () => {
    const xml = await tableXml({ translatedText: 'The figures were summarised.' })
    expect(xml).not.toContain('<w:tbl>')
    expect(xml).toContain('The figures were summarised.')
  })
})

describe('buildDocx tables continued over a page break', () => {
  const ABOVE: Partial<ExportBlock> = {
    id: 'above',
    order: 0,
    kind: 'table',
    sourceText: 'Name \t Value\nAlpha \t 12',
    translatedText: 'Name \t Value\nAlpha \t 12',
    tableCells: [
      ['Name', 'Value'],
      ['Alpha', '12'],
    ],
  }
  const OVER: Partial<ExportBlock> = {
    id: 'over',
    order: 0,
    kind: 'table',
    tableContinuation: true,
    sourceText: 'Beta \t 34',
    translatedText: 'Beta \t 34',
    tableCells: [['Beta', '34']],
  }

  async function continuedXml(
    above: Partial<ExportBlock> = {},
    over: Partial<ExportBlock> = {},
    docxOpts: Partial<DocxOptions> = {},
  ): Promise<string> {
    const doc: ExportDocument = {
      ...fixtureDoc(),
      pages: [
        page(0, [block({ order: 0, ...ABOVE, ...above })]),
        page(1, [block({ ...OVER, ...over })]),
      ],
    }
    return zipText(await buildDocx(doc, options(docxOpts)), 'word/document.xml')
  }

  it('joins the halves into a single Word table, rows in reading order', async () => {
    const xml = await continuedXml()
    // One `w:tbl` where two would butt up and show a seam at the break, and
    // six cells — three rows of two — because the join added the row the
    // break moved to page two instead of a second table.
    expect(xml.match(/<w:tbl>/g) ?? []).toHaveLength(1)
    expect(xml.match(/<w:tc>/g) ?? []).toHaveLength(6)
    expect(xml).toContain('<w:t xml:space="preserve">Alpha</w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">Beta</w:t>')
    expect(xml.indexOf('Beta')).toBeGreaterThan(xml.indexOf('Alpha'))
  })

  it('spends the page break on the join and forces none after it', async () => {
    // The break's job — keep what follows it off the page it broke — is done
    // by the join itself: Word paginates a w:tbl taller than a page all by
    // itself, and a break here would push the rest of the document a page
    // further on than the source had it.
    const xml = await continuedXml({}, {}, { pageBreaks: true })
    expect(xml).not.toContain('w:type="page"')
    expect(xml.match(/<w:tbl>/g) ?? []).toHaveLength(1)
  })

  it('keeps the break when the next page does not continue the table', async () => {
    const xml = await continuedXml({}, { tableContinuation: false }, { pageBreaks: true })
    expect(xml.match(/w:type="page"/g) ?? []).toHaveLength(1)
    expect(xml.match(/<w:tbl>/g) ?? []).toHaveLength(2)
  })

  it('prints the page marker after the joined rows, not before them', async () => {
    // `Page 2` cannot sit inside a table; it waits for the join and lands just
    // after it, where that page's own content begins.
    const xml = await continuedXml({}, {}, { pageHeadings: true })
    expect(xml.match(/<w:tbl>/g) ?? []).toHaveLength(1)
    expect(xml).toContain('Page 2')
    expect(xml.indexOf('Page 2')).toBeGreaterThan(xml.indexOf('Beta'))
  })

  it('pads a continuation row the model answered with fewer columns', async () => {
    // The column count is what Word reconciles the table against; a row that
    // disagrees is what makes it offer to repair the file.
    const xml = await continuedXml({
      sourceText: 'Name \t Value \t Qty\nAlpha \t 12 \t 7',
      translatedText: 'Name \t Value \t Qty\nAlpha \t 12 \t 7',
      tableCells: [
        ['Name', 'Value', 'Qty'],
        ['Alpha', '12', '7'],
      ],
    })
    expect(xml.match(/<w:tbl>/g) ?? []).toHaveLength(1)
    expect(xml.match(/<w:tc>/g) ?? []).toHaveLength(9)
    expect(xml).toContain('<w:t xml:space="preserve">Qty</w:t>')
  })

  it('joins both halves of a bilingual export into one table per column', async () => {
    const xml = await continuedXml(
      { translatedText: 'Ner \t Taya\nAlpha \t 12' },
      { translatedText: 'Bet \t 34' },
      { includeOriginal: true },
    )
    // Two tables — the quoted source and the translation — each carrying both
    // halves of its column, not four tables that butt up against each other.
    expect(xml.match(/<w:tbl>/g) ?? []).toHaveLength(2)
    expect(xml.match(/<w:tc>/g) ?? []).toHaveLength(12)
  })

  it('does not join a block the model answered with prose for a half', async () => {
    // The halves no longer match shape-for-shape, so the join stands down:
    // two tables — still every row, in order — and the sentence printed after
    // the table its own text belongs to, never before it.
    const xml = await continuedXml(
      { translatedText: 'The figures continued below.' },
      {},
      { includeOriginal: true },
    )
    expect(xml.match(/<w:tbl>/g) ?? []).toHaveLength(2)
    expect(xml).toContain('The figures continued below.')
    expect(xml.indexOf('The figures continued below.')).toBeGreaterThan(xml.indexOf('Alpha'))
  })
})

describe('buildDocx figures', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ART = [{ key: 'cap#0', bytes: PNG, dataUrl: 'data:image/png;base64,iVBORw0KG==' }]

  function figureDoc(figure: Partial<ExportBlock>): ExportDocument {
    return {
      ...fixtureDoc(),
      pages: [
        page(0, [block({ id: 'cap', y: 200, sourceText: '', translatedText: '', ...figure })]),
      ],
    }
  }

  async function figureBytes(figure: Partial<ExportBlock>, figures = ART, opts = {}) {
    return buildDocx(figureDoc(figure), options({ figures, ...opts }))
  }

  async function figureXml(figure: Partial<ExportBlock>, figures = ART, opts = {}) {
    return zipText(await figureBytes(figure, figures, opts), 'word/document.xml')
  }

  it('packs the picture into the document package', async () => {
    const zip = await JSZip.loadAsync(
      await figureBytes({
        sourceText: 'Figure 1 — Stages',
        figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
      }),
    )
    const media = zip.file(/word\/media\//)
    expect(media).toHaveLength(1)
    expect(await media[0].async('uint8array')).toEqual(PNG)
    expect(
      await zipText(await figureBytes({ sourceText: 'x' }), 'word/document.xml'),
    ).not.toContain('<w:drawing>')
  })

  it('puts a picture painted above its caption before the caption', async () => {
    const xml = await figureXml({
      sourceText: 'Figure 2 — Stages',
      figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
    })
    expect(xml.indexOf('<w:drawing>')).toBeLessThan(xml.indexOf('Figure 2'))
  })

  it('puts a picture painted below its block after it', async () => {
    const xml = await figureXml({
      sourceText: 'The pipeline runs in four stages.',
      figures: [ref({ x: 100, y: 400, w: 300, h: 140 })],
    })
    expect(xml.indexOf('<w:drawing>')).toBeGreaterThan(xml.indexOf('The pipeline runs'))
  })

  it('carries the caption as the accessibility description', async () => {
    const xml = await figureXml({
      sourceText: 'Figure 3 — Deployment',
      figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
    })
    expect(xml).toContain('descr="Figure 3 — Deployment"')
  })

  it('shrinks a figure wider than the column, and only then', async () => {
    const wide = {
      sourceText: 'Figure 4 — Wide',
      figures: [ref({ x: 0, y: 40, w: 700, h: 350 })],
    }
    const extent = (xml: string): number => Number(/<wp:extent cx="(\d+)"/.exec(xml)?.[1] ?? 0)

    const free = extent(await figureXml(wide))
    const clamped = extent(await figureXml(wide, ART, { maxFigureWidthPt: 200 }))
    expect(free).toBeGreaterThan(0)
    expect(clamped).toBeGreaterThan(0)
    expect(clamped).toBeLessThan(free)

    const natural = extent(
      await figureXml({
        sourceText: 'Figure 5',
        figures: [ref({ x: 0, y: 40, w: 300, h: 140 })],
      }),
    )
    const alsoClamped = extent(
      await figureXml(
        { sourceText: 'Figure 5', figures: [ref({ x: 0, y: 40, w: 300, h: 140 })] },
        ART,
        { maxFigureWidthPt: 100 },
      ),
    )
    expect(alsoClamped).toBeLessThan(natural)
  })

  it('leaves a document with no figures untouched', async () => {
    const xml = await zipText(await buildDocx(fixtureDoc(), options()), 'word/document.xml')
    expect(xml).not.toContain('<w:drawing>')
  })
})
