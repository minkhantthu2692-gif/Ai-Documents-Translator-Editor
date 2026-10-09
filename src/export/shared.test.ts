import { describe, expect, it } from 'vitest'
import {
  CODE_FONT_STACK,
  DEFAULT_FONT_STACK,
  applyLinks,
  documentStats,
  escapeHtml,
  cssFontName,
  fileNameFor,
  fontStackFor,
  fontStackForCode,
  headingOffset,
  isDocumentEmpty,
  langTag,
  linkSegments,
  listPrefix,
  pageBlocks,
  pt,
  resolvedOptions,
  round,
  slugify,
} from './shared'
import type { ExportBlock, ExportDocument, ExportPage } from './types'

function block(overrides: Partial<ExportBlock> = {}): ExportBlock {
  return {
    id: 'blk_1',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 72,
    y: 100,
    width: 400,
    height: 40,
    fontFamily: 'Noto Sans',
    fontSize: 11,
    lineHeight: 1.6,
    color: '#111111',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    links: [],
    sourceText: 'Hello',
    translatedText: 'မင်္ဂလာပါ',
    characterCount: 10,
    skipRule: null,
    placeholders: [],
    direction: 'ltr',
    fittedFontSize: null,
    overflow: false,
    hasSuggestion: false,
    ...overrides,
  }
}

function doc(pages: ExportPage[]): ExportDocument {
  return {
    schema: 1,
    projectId: 'prj_1',
    title: 'My Report',
    sourceFileName: 'report.pdf',
    sourceLang: 'en',
    targetLang: 'my',
    pageCount: pages.length,
    exportedAt: 1_700_000_000_000,
    templateId: null,
    pages,
  }
}

const page = (index: number, blocks: ExportBlock[]): ExportPage => ({
  index,
  width: 612,
  height: 792,
  rotation: 0,
  contentClass: 'text',
  blocks,
})

describe('escapeHtml / cssFontName / pt', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  it('quotes font families only when they need it', () => {
    expect(cssFontName('Noto Sans')).toBe('"Noto Sans"')
    expect(cssFontName('Inter')).toBe('Inter')
    expect(cssFontName('   ')).toBe('sans-serif')
  })

  it('writes point units', () => {
    expect(pt(11)).toBe('11pt')
    expect(pt(11.23456)).toBe('11.235pt')
  })
})

describe('fontStackFor', () => {
  it('puts the block family first and always ends with the Myanmar stack', () => {
    const value = fontStackFor(block({ fontFamily: 'Source Serif 4' }))
    expect(value.startsWith('"Source Serif 4"')).toBe(true)
    expect(value).toContain(DEFAULT_FONT_STACK)
  })

  it('appends the export stack before the defaults', () => {
    const value = fontStackFor(block({ fontFamily: 'Inter' }), { fontStack: 'My Custom' })
    expect(value).toBe(`Inter, My Custom, ${DEFAULT_FONT_STACK}`)
  })

  it('does not repeat a family that is already in the stack', () => {
    const value = fontStackFor(block({ fontFamily: 'Noto Sans Myanmar' }))
    expect(value.split('Noto Sans Myanmar')).toHaveLength(2)
  })
})

describe('fontStackForCode', () => {
  it('pins a snippet to a monospaced face ahead of its own family', () => {
    const value = fontStackForCode(block({ kind: 'code', fontFamily: 'Inter' }))
    expect(value).toBe(CODE_FONT_STACK)
    expect(value).toContain('Courier New')
    expect(value.endsWith('monospace')).toBe(true)
  })

  it('leaves an ordinary block exactly as fontStackFor writes it', () => {
    const value = fontStackForCode(block({ fontFamily: 'Source Serif 4' }))
    expect(value).toBe(fontStackFor(block({ fontFamily: 'Source Serif 4' })))
  })
})

describe('pageBlocks / listPrefix', () => {
  it('keeps reading order and drops blocks with no text', () => {
    const blocks = [
      block({ id: 'b2', order: 2 }),
      block({ id: 'b1', order: 1, sourceText: '', translatedText: '   ' }),
      block({ id: 'b3', order: 3 }),
    ]
    expect(pageBlocks(page(0, blocks)).map((entry) => entry.id)).toEqual(['b2', 'b3'])
  })

  it('falls back to the source text when nothing is translated', () => {
    expect(pageBlocks(page(0, [block({ translatedText: '' })]))).toHaveLength(1)
  })

  it('prefixes list markers with a trailing space', () => {
    expect(listPrefix(block({ listMarker: '1.' }))).toBe('1. ')
    expect(listPrefix(block({ listMarker: '   ' }))).toBe('')
    expect(listPrefix(block())).toBe('')
  })

  it('never prefixes a marker the text already carries', () => {
    // A parsed list line keeps its bullet in the text pdf.js returned *and* in
    // `listMarker`, so prefixing blindly printed it twice.
    expect(listPrefix(block({ listMarker: '•' }), '• First point')).toBe('')
    expect(listPrefix(block({ listMarker: '•' }), '  • First point')).toBe('')
    expect(listPrefix(block({ listMarker: '•' }), '•')).toBe('')
    // The translation dropped it (prompt rule 3) — it goes back on.
    expect(listPrefix(block({ listMarker: '•' }), 'First point')).toBe('• ')
    expect(listPrefix(block({ listMarker: '•' }), 'မြန်မာစာ')).toBe('• ')
  })

  it('only suppresses the prefix when the marker is a real prefix', () => {
    expect(listPrefix(block({ listMarker: '1.' }), '1. First point')).toBe('')
    // `1.` is not a prefix of `1.5`, and `-` is not one of `-5`.
    expect(listPrefix(block({ listMarker: '1.' }), '1.5 tonnes')).toBe('1. ')
    expect(listPrefix(block({ listMarker: '-' }), '-5 °C')).toBe('- ')
    expect(listPrefix(block({ listMarker: '-' }), '- Lowered')).toBe('')
  })
})

describe('documentStats / isDocumentEmpty', () => {
  it('counts translated, overflow and suggestion blocks', () => {
    const stats = documentStats(
      doc([
        page(0, [block(), block({ status: 'locked' })]),
        page(1, [
          block({ id: 'b3', translatedText: '', overflow: true }),
          block({ id: 'b4', hasSuggestion: true }),
          block({ id: 'b5', sourceText: '', translatedText: '' }),
        ]),
      ]),
    )
    expect(stats.pages).toBe(2)
    expect(stats.blocks).toBe(4)
    expect(stats.translated).toBe(3)
    expect(stats.untranslated).toBe(1)
    expect(stats.overflow).toBe(1)
    expect(stats.suggestions).toBe(1)
    expect(stats.locked).toBe(1)
  })

  it('reports a document with no text at all', () => {
    expect(isDocumentEmpty(doc([]))).toBe(true)
    expect(isDocumentEmpty(doc([page(0, [block({ sourceText: '', translatedText: '' })])]))).toBe(
      true,
    )
    expect(isDocumentEmpty(doc([page(0, [block()])]))).toBe(false)
  })
})

describe('file names and language tags', () => {
  it('slugifies unhelpful source names', () => {
    expect(slugify('My Report (v2).pdf')).toBe('my-report-v2-pdf')
    expect(slugify('!!!')).toBe('document')
    expect(slugify('')).toBe('document')
  })

  it('appends the format extension', () => {
    expect(fileNameFor(resolvedOptions({ fileName: 'report' }), 'markdown')).toBe('report.md')
    expect(fileNameFor(resolvedOptions({ fileName: '  ' }), 'images')).toBe('document.zip')
  })

  it('normalises language tags for lang= attributes', () => {
    expect(langTag('EN')).toBe('en')
    expect(langTag('zh-Hans')).toBe('zh-HANS')
    expect(langTag('')).toBe('en')
  })

  it('rounds geometry helpers', () => {
    expect(round(1.23999, 2)).toBe(1.24)
    expect(round(1.5)).toBe(1.5)
  })
})

describe('headingOffset', () => {
  it('leaves anything that is not a heading alone', () => {
    expect(headingOffset(block(), 1)).toBeNull()
    expect(headingOffset(block({ headingLevel: null }), 0)).toBeNull()
  })

  it('pushes a heading below the structural headings printed above it', () => {
    expect(headingOffset(block({ headingLevel: 1 }), 0)).toBe(1)
    expect(headingOffset(block({ headingLevel: 1 }), 1)).toBe(2)
    expect(headingOffset(block({ headingLevel: 2 }), 2)).toBe(4)
  })

  it('clamps at six, the deepest any format can render', () => {
    expect(headingOffset(block({ headingLevel: 6 }), 1)).toBe(6)
    expect(headingOffset(block({ headingLevel: 5 }), 1)).toBe(6)
    // The clamp can merge the deepest levels once a builder has spent some
    // above them — the trade for never colliding with those.
    expect(headingOffset(block({ headingLevel: 4 }), 2)).toBe(6)
  })

  it('never returns a level below one, whatever the record says', () => {
    expect(headingOffset(block({ headingLevel: 0 }), 0)).toBe(1)
    expect(headingOffset(block({ headingLevel: -3 }), 0)).toBe(1)
  })
})

describe('linkSegments', () => {
  const url = 'https://example.com/api'
  const priced = { text: 'pricing page', url: 'https://example.com/pricing' }

  it('returns the text untouched when there is nothing to link', () => {
    expect(linkSegments('Hello', [])).toEqual([{ text: 'Hello', url: null }])
    expect(linkSegments('', [{ text: 'x', url }])).toEqual([{ text: '', url: null }])
  })

  it('cuts the anchor out and keeps the rest as ordinary text', () => {
    expect(linkSegments('Read more at https://example.com/api now', [{ text: url, url }])).toEqual([
      { text: 'Read more at ', url: null },
      { text: url, url },
      { text: ' now', url: null },
    ])
  })

  it('offers the URL verbatim when the model rewrote the words around it', () => {
    // `link.text` is a substring of the *source*; a translation moves it. The
    // URL is the one thing that reliably survives, so it is the fallback.
    const source = 'See the pricing page for details.'
    expect(linkSegments(source, [priced])).toEqual([
      { text: 'See the ', url: null },
      { text: 'pricing page', url: priced.url },
      { text: ' for details.', url: null },
    ])
    const rewritten = 'ကုန်ကျစရိတ် https://example.com/pricing ကို ကြည့်ပါ'
    expect(linkSegments(rewritten, [priced])).toEqual([
      { text: 'ကုန်ကျစရိတ် ', url: null },
      { text: 'https://example.com/pricing', url: priced.url },
      { text: ' ကို ကြည့်ပါ', url: null },
    ])
  })

  it('never nests two anchors, even when their words overlap', () => {
    const links = [
      { text: 'pricing page', url: priced.url },
      { text: 'page for details', url },
    ]
    const segments = linkSegments('See the pricing page for details.', links)
    expect(segments.filter((segment) => segment.url !== null)).toHaveLength(1)
    // Leftmost wins, so the first link is the one that fires.
    expect(segments[1]).toEqual({ text: 'pricing page', url: priced.url })
    expect(segments.map((segment) => segment.text).join('')).toBe(
      'See the pricing page for details.',
    )
  })

  it('fires a link once even though it is offered twice', () => {
    const link = { text: url, url }
    const segments = linkSegments(`Read ${url} then ${url} again`, [link])
    expect(segments.filter((segment) => segment.url !== null)).toHaveLength(1)
    // The second occurrence stays plain text.
    expect(segments.map((segment) => segment.text).join('')).toBe(`Read ${url} then ${url} again`)
  })

  it('drops a link whose URL would not be safe to navigate', () => {
    const text = 'Click data:text/html;base64,PHNjcmlwdD4= now'
    expect(
      linkSegments(text, [
        { text: 'data:text/html;base64,PHNjcmlwdD4=', url: 'data:text/html;base64,PHNjcmlwdD4=' },
      ]),
    ).toEqual([{ text, url: null }])
  })

  it('ignores an empty anchor, which would otherwise match everywhere', () => {
    expect(linkSegments('Hello', [{ text: '   ', url }])).toEqual([{ text: 'Hello', url: null }])
  })
})

describe('applyLinks', () => {
  const wrap = (url: string, anchor: string) => `<${anchor}|${url}>`
  const escape = (segment: string) => segment.replace(/&/g, '&amp;')

  it('escapes only the stretches that are not links', () => {
    // The classic double-escaping bug: the URL's own `&` must be escaped for
    // the attribute and once for the body — never twice over.
    const out = applyLinks(
      'a & b https://example.com/a?x=1&y=2 c & d',
      [{ text: 'https://example.com/a?x=1&y=2', url: 'https://example.com/a?x=1&y=2' }],
      wrap,
      escape,
    )
    expect(out).toBe(
      'a &amp; b <https://example.com/a?x=1&y=2|https://example.com/a?x=1&y=2> c &amp; d',
    )
  })

  it('leaves the text alone when nothing matches', () => {
    expect(applyLinks('nothing here', [{ text: 'gone', url: 'https://a.com' }], wrap, escape)).toBe(
      'nothing here',
    )
    expect(applyLinks('', [], wrap, escape)).toBe('')
  })

  it('wraps in reading order across several links', () => {
    const out = applyLinks(
      'See pricing or docs',
      [
        { text: 'pricing', url: 'https://a.com/p' },
        { text: 'docs', url: 'https://a.com/d' },
      ],
      wrap,
    )
    expect(out).toBe('See <pricing|https://a.com/p> or <docs|https://a.com/d>')
  })
})
