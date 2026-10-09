import { describe, expect, it } from 'vitest'
import { buildMarkdown } from './markdown'
import type { ExportBlock, ExportDocument } from './types'

/** Minimal block with every `ExportBlock` field filled in. */
function block(overrides: Partial<ExportBlock>): ExportBlock {
  return {
    id: 'b0',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 12,
    y: 34,
    width: 200,
    height: 18,
    fontFamily: 'Noto Sans',
    fontSize: 12,
    lineHeight: 1.35,
    color: '#111111',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    sourceText: '',
    translatedText: '',
    characterCount: 0,
    skipRule: null,
    placeholders: [],
    direction: 'ltr',
    fittedFontSize: null,
    overflow: false,
    hasSuggestion: false,
    ...overrides,
  }
}

/** Two content pages plus one page with no text at all. */
function makeDoc(): ExportDocument {
  return {
    schema: 1,
    projectId: 'p1',
    title: 'Sample',
    sourceFileName: 'sample.pdf',
    sourceLang: 'en',
    targetLang: 'my',
    pageCount: 3,
    exportedAt: 1700000000000,
    templateId: null,
    pages: [
      {
        index: 0,
        width: 612,
        height: 792,
        rotation: 0,
        contentClass: 'text',
        blocks: [
          block({
            id: 'b1',
            order: 0,
            kind: 'heading',
            sourceText: 'Chapter One',
            translatedText: 'မြန်မာစာ',
            status: 'translated',
          }),
          block({
            id: 'b2',
            order: 1,
            kind: 'list',
            listMarker: '•',
            sourceText: 'Hello world',
            translatedText: 'Good morning',
            status: 'edited',
          }),
          block({
            id: 'b3',
            order: 2,
            sourceText: 'Untranslated line',
            translatedText: '',
            status: 'pending',
          }),
          // No source and no target: must never reach the output.
          block({ id: 'b4', order: 3, sourceText: '', translatedText: '', status: 'pending' }),
        ],
      },
      {
        index: 1,
        width: 612,
        height: 792,
        rotation: 0,
        contentClass: 'text',
        blocks: [
          block({
            id: 'b5',
            order: 0,
            sourceText: 'Welcome',
            translatedText: 'مرحبا بالعالم',
            direction: 'rtl',
            status: 'translated',
          }),
          block({
            id: 'b6',
            order: 1,
            sourceText: 'Locked line',
            translatedText: '',
            status: 'locked',
            skipRule: 'code',
          }),
        ],
      },
      { index: 2, width: 612, height: 792, rotation: 0, contentClass: 'empty', blocks: [] },
    ],
  }
}

describe('buildMarkdown', () => {
  it('escapes Markdown specials in the title H1', () => {
    const doc: ExportDocument = { ...makeDoc(), pages: [] }
    const out = buildMarkdown(doc, {
      title: '#1 *draft* [v2]_x`y',
      includeOriginal: false,
      includePageHeadings: false,
    })
    expect(out).toBe('# \\#1 \\*draft\\* \\[v2\\]\\_x\\`y\n')
  })

  it('emits page headings, list markers and one line per block', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: false,
      includePageHeadings: true,
    })
    const expected =
      '# Sample\n' +
      '\n## Page 1\n' +
      '\nမြန်မာစာ\n' +
      '\n• Good morning\n' +
      '\nUntranslated line\n' +
      '\n## Page 2\n' +
      '\nمرحبا بالعالم\n' +
      '\nLocked line\n'
    expect(out).toBe(expected)
  })

  it('omits page headings when includePageHeadings is off', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'T',
      includeOriginal: false,
      includePageHeadings: false,
    })
    expect(out).not.toContain('## Page')
    expect(out.startsWith('# T\n\nမြန်မာစာ')).toBe(true)
  })

  it('skips pages and blocks that carry no text', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: false,
      includePageHeadings: true,
    })
    expect(out).not.toContain('## Page 3')
    // title + 2 page headings + exactly 5 blocks (the empty one is dropped)
    expect(out.split('\n\n')).toHaveLength(8)
  })

  it('emits a blockquote directly above the translation when includeOriginal is on', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: true,
      includePageHeadings: false,
    })
    expect(out).toContain('> Chapter One\nမြန်မာစာ')
    expect(out).toContain('> Hello world\n• Good morning')
    expect(out).toContain('> Welcome\nمرحبا بالعالم')
    // Untranslated blocks repeat themselves as a quote: never emit it.
    expect(out).not.toContain('> Untranslated line')
    expect(out).not.toContain('> Locked line')
    // The quote shares its group with the block line: no blank line inside.
    expect(out.split('\n\n')).toHaveLength(6)
  })

  it('emits no blockquote at all when includeOriginal is off', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: false,
      includePageHeadings: false,
    })
    expect(out.split('\n').some((line) => line.startsWith('> '))).toBe(false)
  })

  it('prefixes the list marker from listPrefix', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: false,
      includePageHeadings: false,
    })
    expect(out).toContain('• Good morning')
    expect(out).not.toContain('\nGood morning')
  })

  it('prints a parsed list bullet exactly once, translated or not', () => {
    // The PDF gives us `• First point` *and* `listMarker: '•'`; every builder
    // re-attaches the marker, so the copy inside the text must not survive.
    const doc: ExportDocument = {
      ...makeDoc(),
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [
            // Still pending: the primary text falls back to the source.
            block({
              id: 'pending',
              order: 0,
              kind: 'list',
              listMarker: '•',
              sourceText: '• First point',
              translatedText: '',
              status: 'pending',
            }),
            block({
              id: 'translated',
              order: 1,
              kind: 'list',
              listMarker: '•',
              sourceText: '• Second point',
              translatedText: 'ဒုတိယ အချက်',
              status: 'translated',
            }),
            // A model that ignored prompt rule 3 and kept the bullet.
            block({
              id: 'kept',
              order: 2,
              kind: 'list',
              listMarker: '•',
              sourceText: '• Third point',
              translatedText: '• တတိယ အချက်',
              status: 'translated',
            }),
          ],
        },
      ],
    }
    const out = buildMarkdown(doc, {
      title: 'T',
      includeOriginal: false,
      includePageHeadings: false,
    })
    expect(out).not.toContain('• •')
    expect(out).toContain('• First point')
    expect(out).toContain('• ဒုတိယ အချက်')
    expect(out).toContain('• တတိယ အချက်')
    // One bullet per list block.
    expect(out.match(/•/g)).toHaveLength(3)
  })

  it('keeps skipped and locked blocks because their text matters', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: false,
      includePageHeadings: true,
    })
    expect(out).toContain('Locked line')
    expect(out).toContain('Untranslated line')
  })

  it('separates blocks and pages with exactly one blank line', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: true,
      includePageHeadings: true,
    })
    expect(out.includes('\n\n\n')).toBe(false)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  it('writes RTL and Myanmar text as-is', () => {
    const out = buildMarkdown(makeDoc(), {
      title: 'Sample',
      includeOriginal: false,
      includePageHeadings: false,
    })
    expect(out).toContain('မြန်မာစာ')
    expect(out).toContain('مرحبا بالعالم')
  })
})

describe('heading hierarchy', () => {
  function headingDoc(levels: Array<number | null>): ExportDocument {
    return {
      ...makeDoc(),
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: levels.map((headingLevel, index) =>
            block({
              id: `h${index}`,
              order: index,
              kind: 'heading',
              headingLevel,
              sourceText: `Section ${index}`,
              translatedText: `အချက် ${index}`,
              status: 'translated',
            }),
          ),
        },
      ],
    }
  }

  const opts = (includePageHeadings: boolean) => ({
    title: 'Sample',
    includeOriginal: false,
    includePageHeadings,
  })

  it('sits below the title, never on the title’s own level', () => {
    const out = buildMarkdown(headingDoc([1, 2, 3]), opts(false))
    expect(out).toContain('## အချက် 0')
    expect(out).toContain('### အချက် 1')
    expect(out).toContain('#### အချက် 2')
    expect(out.startsWith('# Sample\n')).toBe(true)
    expect(out.split('\n').some((line) => line.startsWith('# အချက်'))).toBe(false)
  })

  it('drops another level when the page headings take one', () => {
    const withPages = buildMarkdown(headingDoc([1]), opts(true))
    expect(withPages).toContain('## Page 1\n\n### အချက် 0')

    const withoutPages = buildMarkdown(headingDoc([1]), opts(false))
    expect(withoutPages).toContain('## အချက် 0')
  })

  it('clamps at six hashes, the deepest Markdown renders', () => {
    const out = buildMarkdown(headingDoc([4, 5, 6]), opts(true))
    expect(out).not.toContain('#######')
    expect(out.match(/###### /g)).toHaveLength(3)
  })

  it('leaves a block with no level alone, whatever its kind says', () => {
    const out = buildMarkdown(headingDoc([null]), opts(false))
    expect(out).toContain('အချက် 0')
    expect(out.split('\n').some((line) => line.startsWith('# အချက်'))).toBe(false)
  })
})
