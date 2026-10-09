import { describe, expect, it } from 'vitest'
import { buildHtmlDocument, buildPrintDocument, htmlExportOptions, type HtmlOptions } from './html'
import { DEFAULT_EXPORT_OPTIONS, EXPORT_SCHEMA, type ExportDocument } from './types'

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
