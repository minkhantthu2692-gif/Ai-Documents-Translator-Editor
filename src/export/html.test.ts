import { describe, expect, it } from 'vitest'
import type { TextMeasurer } from '@/editor/autofit'
import { buildHtmlDocument, buildPrintDocument, htmlExportOptions, type HtmlOptions } from './html'
import {
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_SCHEMA,
  type ExportBlock,
  type ExportDocument,
} from './types'

function block(overrides: Partial<ExportDocument['pages'][number]['blocks'][number]> = {}) {
  return {
    id: 'blk_1',
    order: 0,
    kind: 'paragraph' as const,
    region: 'body' as const,
    status: 'translated' as const,
    alignment: 'left' as const,
    x: 72,
    y: 72,
    width: 468,
    height: 14,
    fontFamily: 'Noto Sans',
    fontSize: 11,
    lineHeight: 1.7,
    color: '#111827',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    links: [],
    tableCells: null,
    sourceText: 'Hello world',
    translatedText: 'မြန်မာစာ စာသား',
    characterCount: 11,
    skipRule: null,
    placeholders: [],
    direction: 'ltr' as const,
    fittedFontSize: null,
    overflow: false,
    hasSuggestion: false,
    ...overrides,
  }
}

function doc(overrides: Partial<ExportDocument> = {}): ExportDocument {
  return {
    schema: EXPORT_SCHEMA,
    projectId: 'prj_1',
    title: 'Sample <Doc>',
    sourceFileName: 'sample.pdf',
    sourceLang: 'en',
    targetLang: 'my',
    pageCount: 1,
    exportedAt: 1_700_000_000_000,
    templateId: null,
    pages: [
      {
        index: 0,
        width: 612,
        height: 792,
        rotation: 0,
        contentClass: 'text',
        blocks: [block()],
      },
    ],
    ...overrides,
  }
}

const base: HtmlOptions = {
  mode: 'screen',
  layout: 'absolute',
  bilingual: 'none',
  includeOriginal: false,
  fontCss: '',
  fontStack: '',
  title: 'Sample <Doc>',
  lang: 'my',
  generator: 'AI Documents Translator',
}

describe('buildHtmlDocument (absolute)', () => {
  const html = buildHtmlDocument(doc(), base)

  it('produces a complete document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Sample &lt;Doc&gt;</title>')
    expect(html).toContain('</html>')
  })

  it('positions blocks with the original geometry in points', () => {
    expect(html).toContain('left:72pt')
    expect(html).toContain('top:72pt')
    expect(html).toContain('width:468pt')
    expect(html).toContain('font-size:11pt')
    expect(html).toContain('line-height:1.7')
  })

  it('sizes the print sheet to the original page', () => {
    expect(html).toContain('@page { size: 612pt 792pt; margin: 0; }')
  })

  it('renders the translation, not the source, by default', () => {
    expect(html).toContain('မြန်မာစာ စာသား')
    expect(html).not.toContain('Hello world')
  })

  it('keeps the source when includeOriginal is on (flow layout)', () => {
    const flow = buildHtmlDocument(doc(), { ...base, layout: 'flow', includeOriginal: true })
    expect(flow).toContain('Hello world')
    expect(flow).toContain('မြန်မာစာ စာသား')
    expect(flow).toContain('class="src"')
  })

  it('renders a parsed list bullet exactly once in both layouts', () => {
    const listDoc = (overrides: Partial<ReturnType<typeof block>>) =>
      doc({
        pages: [
          {
            index: 0,
            width: 612,
            height: 792,
            rotation: 0,
            contentClass: 'text',
            blocks: [
              block({
                kind: 'list',
                listMarker: '•',
                sourceText: '• First point',
                ...overrides,
              }),
            ],
          },
        ],
      })
    const bullets = (html: string): number => (html.match(/•/g) ?? []).length

    // Still pending: the primary text falls back to the source, which already
    // carries the bullet the PDF drew — the marker span must stand down.
    const pending = listDoc({ translatedText: '', status: 'pending' })
    expect(buildHtmlDocument(pending, base)).not.toContain('• •')
    expect(bullets(buildHtmlDocument(pending, base))).toBe(1)
    const bilingualPending = buildHtmlDocument(pending, {
      ...base,
      layout: 'flow',
      includeOriginal: true,
    })
    expect(bilingualPending).not.toContain('• •')
    expect(bullets(bilingualPending)).toBe(1)

    // Translated: the target left the bullet out (prompt rule 3), so the source
    // paragraph shows the PDF's copy and the block keeps exactly one.
    const translated = listDoc({ translatedText: 'ပထမ အချက်', status: 'translated' })
    const flow = buildHtmlDocument(translated, { ...base, layout: 'flow', includeOriginal: true })
    expect(flow).not.toContain('• •')
    expect(bullets(flow)).toBe(1)
  })

  it('escapes hostile text instead of executing it', () => {
    const hostile = doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ translatedText: '<script>alert(1)</script>' })],
        },
      ],
    })
    const out = buildHtmlDocument(hostile, base)
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('marks the RTL block with dir="rtl"', () => {
    const rtl = doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ translatedText: 'سلام دنیا', direction: 'rtl' })],
        },
      ],
    })
    expect(buildHtmlDocument(rtl, base)).toContain('dir="rtl"')
  })

  it('skips blocks with no text at all', () => {
    const empty = doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ sourceText: '', translatedText: '' })],
        },
      ],
    })
    expect(buildHtmlDocument(empty, base)).not.toContain('data-block-id')
  })

  it('flags overflowing blocks for review', () => {
    const over = doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ overflow: true })],
        },
      ],
    })
    expect(buildHtmlDocument(over, base)).toContain('block overflow')
  })

  it('inlines the font CSS it is given', () => {
    const withFonts = buildHtmlDocument(doc(), {
      ...base,
      fontCss: '@font-face { font-family: "Noto Sans Myanmar"; }',
    })
    expect(withFonts).toContain('@font-face')
  })

  it('embeds page images when provided', () => {
    const withImage = buildHtmlDocument(doc(), {
      ...base,
      pageImages: [{ index: 0, dataUrl: 'data:image/webp;base64,AAA' }],
    })
    expect(withImage).toContain('class="page-bg"')
    expect(withImage).toContain('data:image/webp;base64,AAA')
  })
})

describe('buildPrintDocument', () => {
  const html = buildPrintDocument(doc(), base)

  it('drops screen chrome and forces a page break per sheet', () => {
    expect(html).not.toContain('doc-header')
    expect(html).toContain('page-break-after: always')
    expect(html).toContain('.page { border: none; }')
  })

  it('keeps the geometry', () => {
    expect(html).toContain('left:72pt')
    expect(html).toContain('@page p612x792 { size: 612pt 792pt; margin: 0; }')
  })
})

describe('htmlExportOptions', () => {
  it('uses absolute layout for the plain translation', () => {
    const options = htmlExportOptions(doc(), DEFAULT_EXPORT_OPTIONS, '')
    expect(options.layout).toBe('absolute')
    expect(options.includeOriginal).toBe(false)
  })

  it('switches to a bilingual flow when the source is included', () => {
    const options = htmlExportOptions(
      doc(),
      { ...DEFAULT_EXPORT_OPTIONS, includeOriginal: true, bilingual: 'interleaved' },
      '',
    )
    expect(options.layout).toBe('flow')
    expect(options.bilingual).toBe('interleaved')
  })
})

describe('multi-page documents', () => {
  it('emits one section per page and names every page size', () => {
    const two = doc({
      pageCount: 2,
      pages: [
        { index: 0, width: 612, height: 792, rotation: 0, contentClass: 'text', blocks: [block()] },
        {
          index: 1,
          width: 595,
          height: 842,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ id: 'blk_2' })],
        },
      ],
    })
    const html = buildHtmlDocument(two, base)
    expect(html.match(/<section class="page /g)?.length).toBe(2)
    expect(html).toContain('@page p595x842 { size: 595pt 842pt; margin: 0; }')
    expect(html).toContain('.page.p595x842 { page: p595x842; }')
  })
})

describe('heading hierarchy', () => {
  function headingDoc(headingLevel: number | null, kind: 'heading' | 'paragraph' = 'heading') {
    return doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ kind, headingLevel })],
        },
      ],
    })
  }

  it('emits a heading tag instead of a div, below the screen title', () => {
    const html = buildHtmlDocument(headingDoc(1), base)
    expect(html).toContain('<h2 class="block" data-block-id="blk_1"')
    expect(html).toContain('</h2>')
    expect(html).not.toContain('<div class="block"')
  })

  it('starts at level 1 in the printed document, which has no title header', () => {
    const html = buildHtmlDocument(headingDoc(1), { ...base, mode: 'print' })
    expect(html).toContain('<h1 class="block" data-block-id="blk_1"')
  })

  it('keeps a non-heading block a div', () => {
    const html = buildHtmlDocument(headingDoc(null, 'paragraph'), base)
    expect(html).toContain('<div class="block" data-block-id="blk_1"')
  })

  it('neutralises the browser heading styles, so the printed page is unchanged', () => {
    const html = buildHtmlDocument(headingDoc(3), { ...base, mode: 'print' })
    expect(html).toMatch(/\.block \{[^}]*margin: 0;/)
    expect(html).toMatch(/\.block \{[^}]*font-weight: inherit;/)
    // The geometry that decides how the page prints is still on the element.
    expect(html).toContain('<h3 class="block" data-block-id="blk_1"')
    expect(html).toContain('left:72pt')
  })

  it('tags the translation, not the source, in a bilingual flow', () => {
    const html = buildHtmlDocument(headingDoc(1), {
      ...base,
      layout: 'flow',
      includeOriginal: true,
      bilingual: 'side-by-side',
    })
    expect(html).toContain('<p class="src"')
    expect(html).toMatch(/<h\d class="tgt" data-block-id="blk_1"/)
  })
})

describe('links', () => {
  const link = {
    text: 'pricing page',
    url: 'https://example.com/pricing?x=1&y=2',
  }

  function linkedDoc(overrides: Partial<ExportBlock> = {}) {
    return doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [
            block({
              sourceText: 'See the pricing page for details.',
              translatedText: 'See the pricing page for details.',
              links: [link],
              ...overrides,
            }),
          ],
        },
      ],
    })
  }

  it('turns the anchor into a real <a> with an escaped href', () => {
    const html = buildHtmlDocument(linkedDoc(), base)
    // The `&` in the query string must be an entity *inside the attribute*,
    // and the body text must not be escaped twice by the same pass.
    expect(html).toContain('<a href="https://example.com/pricing?x=1&amp;y=2"')
    expect(html).toContain('>pricing page</a>')
    expect(html).toContain('See the ')
  })

  it('leaves the surrounding text escaped', () => {
    const html = buildHtmlDocument(
      linkedDoc({ sourceText: 'a & b', translatedText: 'a & b < c' }),
      base,
    )
    expect(html).toContain('a &amp; b &lt; c')
  })

  it('refuses a URL that would not be safe to navigate', () => {
    const html = buildHtmlDocument(
      linkedDoc({
        sourceText: 'Click me',
        translatedText: 'Click me',
        links: [{ text: 'Click me', url: 'javascript:alert(1)' }],
      }),
      base,
    )
    expect(html).not.toContain('javascript:')
    expect(html).toContain('Click me')
    expect(html).not.toContain('<a href=')
  })

  it('opens a new tab without handing the opener over', () => {
    const html = buildHtmlDocument(linkedDoc(), base)
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
  })

  it('links the flow layout too, on the side that still has the words', () => {
    const html = buildHtmlDocument(linkedDoc({ translatedText: 'စျေးနှုန်း' }), {
      ...base,
      layout: 'flow',
      includeOriginal: true,
      bilingual: 'side-by-side',
    })
    expect(html).toContain('>pricing page</a>')
    expect(html.match(/<a href=/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('renders nothing extra for a block with no links', () => {
    const html = buildHtmlDocument(linkedDoc({ links: [] }), base)
    expect(html).not.toContain('<a href=')
  })
})

describe('absolute export height handling', () => {
  /** ~0.5 em average advance — deterministic, no canvas needed. */
  const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize * 0.5

  /** `n` space-separated words: `wrapLines` cannot break a single long token. */
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

  function twoBlocks(first: Partial<ExportBlock>): ExportDocument {
    return doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ id: 'a', ...first }), block({ id: 'b', y: 95, order: 1 })],
        },
      ],
    })
  }

  it('moves the block below one that outgrew its box, and only that block', () => {
    // Twenty-five words are two lines at 11pt/1.7 — 37.4pt in a 14pt box.
    const html = buildHtmlDocument(twoBlocks({ translatedText: words(25) }), base, measure)
    expect(html).toContain('top:72pt')
    expect(html).toContain('top:109.4pt')
  })

  it('leaves a page whose text still fits exactly as the PDF drew it', () => {
    const html = buildHtmlDocument(twoBlocks({}), base, measure)
    expect(html).toContain('top:72pt')
    expect(html).toContain('top:95pt')
  })

  it('emits the source box as a floor the text may grow into', () => {
    const html = buildHtmlDocument(twoBlocks({ translatedText: words(25) }), base, measure)
    expect(html).toContain('min-height:14pt')
  })

  it('names the blocks the page edge stopped it from clearing', () => {
    // a grows at the foot of the page; the push lands b past 792pt, so b is
    // parked at the edge — still under a. That is worth a name, because the
    // reader is looking at an overlap and the export said nothing.
    const page = doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [
            block({ id: 'a', y: 750, translatedText: words(25) }),
            block({ id: 'b', y: 773, order: 1 }),
          ],
        },
      ],
    })
    const clipped: string[] = []
    buildHtmlDocument(page, base, measure, (id) => clipped.push(id))
    expect(clipped).toEqual(['b'])
  })

  it('reports nothing when every block clears', () => {
    const clipped: string[] = []
    buildHtmlDocument(twoBlocks({ translatedText: words(25) }), base, measure, (id) =>
      clipped.push(id),
    )
    expect(clipped).toEqual([])
  })
})

describe('code blocks', () => {
  function codeDoc(overrides: Partial<ExportBlock> = {}): ExportDocument {
    return doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [
            block({
              kind: 'code',
              status: 'skipped',
              skipRule: 'code',
              fontFamily: 'Courier',
              sourceText: 'if (a) {\n  b = 2;\n}',
              ...overrides,
            }),
          ],
        },
      ],
    })
  }

  it('pins the absolute layout to a monospace stack and marks the block', () => {
    const html = buildHtmlDocument(codeDoc(), base)
    expect(html).toContain('class="block code"')
    expect(html).toMatch(/class="block code"[^>]*font-family:"Courier New"/)
    expect(html).toContain('tab-size:4')
  })

  it('carries the code class and the stylesheet into the flow layout', () => {
    const html = buildHtmlDocument(codeDoc(), {
      ...base,
      layout: 'flow',
      includeOriginal: true,
      bilingual: 'side-by-side',
    })
    expect(html).toContain('class="tgt code"')
    expect(html).toContain('.code {')
    expect(html).toContain('white-space: pre-wrap;')
  })

  it('never lets a snippet become a heading', () => {
    const html = buildHtmlDocument(codeDoc({ headingLevel: 1 }), base)
    expect(html).not.toMatch(/<h[1-6][^>]*data-block-id/)
  })

  it('leaves an ordinary block out of the code styling', () => {
    const html = buildHtmlDocument(doc(), base)
    expect(html).not.toContain('block code')
    expect(html).not.toContain('tab-size:4')
  })
})

describe('tables', () => {
  const TABLE = 'Region \t Q1 \t Q2\nNorth \t 120 \t 150'

  function tableDoc(overrides: Partial<ExportBlock> = {}): ExportDocument {
    return doc({
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [
            block({
              kind: 'table',
              sourceText: TABLE,
              translatedText: TABLE,
              tableCells: [
                ['Region', 'Q1', 'Q2'],
                ['North', '120', '150'],
              ],
              ...overrides,
            }),
          ],
        },
      ],
    })
  }

  it('draws cells instead of a paragraph of tab-separated text', () => {
    const html = buildHtmlDocument(tableDoc(), base)
    expect(html).toContain('<table>')
    expect(html).toContain('<tr><td>Region</td><td>Q1</td><td>Q2</td></tr>')
    expect(html).toContain('<tr><td>North</td><td>120</td><td>150</td></tr>')
    expect(html).not.toContain('Region \t')
  })

  it('never lets a table become a heading', () => {
    const html = buildHtmlDocument(tableDoc({ headingLevel: 1 }), base)
    expect(html).not.toMatch(/<h[1-6][^>]*data-block-id/)
  })

  it('rules the cells in the absolute layout', () => {
    expect(buildHtmlDocument(tableDoc(), base)).toContain('.page td {')
  })

  it('renders the table in the flow layout through a div, not a p', () => {
    const html = buildHtmlDocument(tableDoc(), { ...base, layout: 'flow' })
    expect(html).toContain('<div class="tgt table"')
    expect(html).toContain('<table>')
    expect(html).not.toMatch(/<p[^>]*><table>/)
  })

  it('falls back to the paragraph when the printed text has no cells left', () => {
    const html = buildHtmlDocument(
      tableDoc({ translatedText: 'The figures were summarised in prose.' }),
      base,
    )
    expect(html).not.toContain('<table>')
    expect(html).toContain('The figures were summarised in prose.')
  })

  it('leaves an ordinary block out of the table styling', () => {
    expect(buildHtmlDocument(doc(), base)).not.toContain('<table>')
  })
})
