import { describe, expect, it } from 'vitest'
import type { FigureRef } from '@/pdf/structure'
import { buildMarkdown } from './markdown'
import type { ExportBlock, ExportDocument } from './types'

/** A traced figure for a page-space box, at the 2× the fixtures were rendered at. */
function ref(bbox: { x: number; y: number; w: number; h: number }): FigureRef {
  return { bbox, pixelWidth: bbox.w * 2, pixelHeight: bbox.h * 2 }
}

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

describe('links', () => {
  const opts = { title: 'Sample', includeOriginal: false, includePageHeadings: false }

  function linkedDoc(
    links: ExportBlock['links'],
    text = 'See the pricing page for details.',
    translated = text,
  ): ExportDocument {
    return {
      ...makeDoc(),
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ links, sourceText: text, translatedText: translated })],
        },
      ],
    }
  }

  it('writes a Markdown link around the words the annotation covered', () => {
    const out = buildMarkdown(
      linkedDoc([{ text: 'pricing page', url: 'https://example.com/pricing' }]),
      opts,
    )
    expect(out).toContain('See the [pricing page](https://example.com/pricing) for details.')
  })

  it('falls back to the URL when the words are gone', () => {
    const out = buildMarkdown(
      linkedDoc(
        [{ text: 'pricing page', url: 'https://example.com/pricing' }],
        'Read https://example.com/pricing today',
      ),
      opts,
    )
    expect(out).toContain('[https://example.com/pricing](https://example.com/pricing)')
  })

  it('escapes the brackets a label would otherwise break on', () => {
    const out = buildMarkdown(
      linkedDoc([{ text: '[new]', url: 'https://example.com/new' }], 'Try [new] today'),
      opts,
    )
    expect(out).toContain('Try [\\[new\\]](https://example.com/new) today')
  })

  it('drops a link whose URL would not be safe to navigate', () => {
    const out = buildMarkdown(
      linkedDoc([{ text: 'Click me', url: 'javascript:alert(1)' }], 'Click me now'),
      opts,
    )
    expect(out).not.toContain('javascript:')
    expect(out).toContain('Click me now')
  })

  it('links the blockquote that carries the source text too', () => {
    const out = buildMarkdown(
      linkedDoc(
        [{ text: 'pricing page', url: 'https://example.com/pricing' }],
        'See the pricing page for details.',
        'စျေးနှုန်းကို ကြည့်ပါ',
      ),
      { ...opts, includeOriginal: true },
    )
    expect(out).toContain('> See the [pricing page](https://example.com/pricing) for details.')
    expect(out).toContain('စျေးနှုန်းကို ကြည့်ပါ')
  })
})

describe('code blocks', () => {
  const opts = { title: 'Sample', includeOriginal: false, includePageHeadings: false }

  function codeDoc(overrides: Partial<ExportBlock>): ExportDocument {
    return {
      ...makeDoc(),
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
              sourceText: 'const a = 1;\nif (a) {\n  b = 2;\n}',
              ...overrides,
            }),
          ],
        },
      ],
    }
  }

  it('fences the snippet instead of running it into the prose', () => {
    const out = buildMarkdown(codeDoc({}), opts)
    expect(out).toContain('```\nconst a = 1;\nif (a) {\n  b = 2;\n}\n```')
  })

  it('writes the body literally — no escaping, no marker, no heading', () => {
    const out = buildMarkdown(
      codeDoc({
        sourceText: 'a_b = [1] * 2;\n# not a heading',
        listMarker: '1.',
        headingLevel: 2,
      }),
      opts,
    )
    expect(out).toContain('a_b = [1] * 2;\n# not a heading')
    expect(out).not.toContain('\\_')
    expect(out).not.toContain('1. a_b')
    expect(out).not.toContain('## ')
  })

  it('widens the fence past the longest backtick run inside', () => {
    const out = buildMarkdown(codeDoc({ sourceText: 'const fence = ```;' }), opts)
    expect(out).toContain('````\nconst fence = ```;\n````')
  })

  it('leaves a URL inside a snippet as data, not as an anchor', () => {
    const out = buildMarkdown(
      codeDoc({
        sourceText: 'fetch("https://example.com")',
        links: [{ text: 'https://example.com', url: 'https://example.com' }],
      }),
      opts,
    )
    expect(out).toContain('fetch("https://example.com")')
    expect(out).not.toContain('](https://example.com)')
  })

  it('still quotes the source above the snippet when includeOriginal is on', () => {
    const out = buildMarkdown(codeDoc({ sourceText: 'const a = 1;', translatedText: 'မ' }), {
      ...opts,
      includeOriginal: true,
    })
    expect(out).toContain('> const a = 1;')
    expect(out).toContain('```\nမ\n```')
  })
})

describe('tables', () => {
  const opts = { title: 'Sample', includeOriginal: false, includePageHeadings: false }

  function tableDoc(overrides: Partial<ExportBlock> = {}): ExportDocument {
    return {
      ...makeDoc(),
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
              sourceText: 'Name \t Value\nAlpha \t 12',
              translatedText: 'Name \t Value\nAlpha \t 12',
              tableCells: [
                ['Name', 'Value'],
                ['Alpha', '12'],
              ],
              ...overrides,
            }),
          ],
        },
      ],
    }
  }

  it('emits a pipe table, promoting row 0 to the header the syntax demands', () => {
    const out = buildMarkdown(tableDoc(), opts)
    expect(out).toContain('| Name | Value |\n| --- | --- |\n| Alpha | 12 |')
  })

  it('escapes a pipe inside a cell, which would otherwise add a column', () => {
    const out = buildMarkdown(
      tableDoc({ sourceText: 'a|b \t c', translatedText: 'a|b \t c' }),
      opts,
    )
    expect(out).toContain('| a\\|b | c |')
  })

  it('keeps every column of a merged row, because Markdown cannot merge them', () => {
    // The grammar has no colspan: the covered cell still has to be *printed*,
    // empty, or the row would come out one column short of its neighbours and
    // every cell after it would land under the wrong heading.
    const out = buildMarkdown(
      tableDoc({
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
      }),
      opts,
    )
    expect(out).toContain('| Name | First half 2026 |  |')
    expect(out).toContain('| Alpha |  | 12 |')
  })

  it('quotes the source above the translation as a table too', () => {
    const out = buildMarkdown(
      tableDoc({ sourceText: 'Name \t Value', translatedText: 'Ner \t Taya' }),
      { ...opts, includeOriginal: true },
    )
    expect(out).toContain('> | Name | Value |')
    expect(out).toContain('| Ner | Taya |')
  })

  it('falls back to a paragraph when the printed text has no cells left', () => {
    const out = buildMarkdown(tableDoc({ translatedText: 'The figures were summarised.' }), opts)
    expect(out).not.toContain('| --- |')
    expect(out).toContain('The figures were summarised.')
  })
})

describe('tables continued over a page break', () => {
  const opts = { title: 'Sample', includeOriginal: false, includePageHeadings: false }

  const ABOVE: Partial<ExportBlock> = {
    id: 'above',
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
    kind: 'table',
    tableContinuation: true,
    sourceText: 'Beta \t 34',
    translatedText: 'Beta \t 34',
    tableCells: [['Beta', '34']],
  }

  function continuedDoc(
    above: Partial<ExportBlock> = {},
    over: Partial<ExportBlock> = {},
    onPageTwo: Array<Partial<ExportBlock>> = [],
  ): ExportDocument {
    return {
      ...makeDoc(),
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ order: 0, ...ABOVE, ...above })],
        },
        {
          index: 1,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [
            block({ order: 0, ...OVER, ...over }),
            ...onPageTwo.map((b, i) => block({ order: i + 1, ...b })),
          ],
        },
      ],
    }
  }

  it('appends the rows the break moved up to the table they were cut from', () => {
    const out = buildMarkdown(continuedDoc(), opts)
    // One table, one header, one separator — the continuation's first row is
    // data, and promoting it would put a reading in the header's place.
    expect(out).toContain('| Name | Value |\n| --- | --- |\n| Alpha | 12 |\n| Beta | 34 |')
    expect(out.match(/\| --- \|/g)).toHaveLength(1)
  })

  it('keeps the page marker, printed after the rows the break moved up', () => {
    // A heading cannot sit inside a table, so the `## Page 2` marker lands
    // just after the joined rows — where the rest of that page begins.
    const out = buildMarkdown(continuedDoc({}, {}, [{ sourceText: 'After the table.' }]), {
      ...opts,
      includePageHeadings: true,
    })
    expect(out).toContain('| Beta | 34 |\n\n## Page 2\n\nAfter the table.')
  })

  it('joins both halves when the source is quoted above the translation', () => {
    const out = buildMarkdown(
      continuedDoc(
        { sourceText: 'Name \t Value\nAlpha \t 12', translatedText: 'Ner \t Taya\nAlpha \t 12' },
        { sourceText: 'Beta \t 34', translatedText: 'Bet \t 34' },
      ),
      { ...opts, includeOriginal: true },
    )
    // The quoted rows extend the quoted table (still one blockquote, still
    // one `> | --- |`), and the translations extend theirs.
    expect(out).toContain('> | Name | Value |\n> | --- | --- |\n> | Alpha | 12 |\n> | Beta | 34 |')
    expect(out.match(/>\s\| --- \|/g)).toHaveLength(1)
    expect(out).toContain('| Ner | Taya |\n| --- | --- |\n| Alpha | 12 |\n| Bet | 34 |')
  })

  it('prints a running head between the halves without breaking the join', () => {
    // A running head is margin text printed where it was on its page, not
    // content between the table and its continuation — so it must not take
    // the join away, and it prints after the rows the break moved up.
    const out = buildMarkdown(
      continuedDoc({}, { order: 1 }, [
        {
          region: 'header',
          order: 0,
          sourceText: 'Annual Report',
          translatedText: 'Annual Report',
        },
      ]),
      opts,
    )
    expect(out).toContain('| Alpha | 12 |\n| Beta | 34 |\n\nAnnual Report')
  })

  it('pads a continuation row the model answered with fewer cells', () => {
    // Alignment, not cutting: a row one cell short would pull every cell
    // after it out of line under the header, and cutting cells is data loss.
    const out = buildMarkdown(
      continuedDoc({
        sourceText: 'Name \t Value \t Qty\nAlpha \t 12 \t 7',
        translatedText: 'Name \t Value \t Qty\nAlpha \t 12 \t 7',
        tableCells: [
          ['Name', 'Value', 'Qty'],
          ['Alpha', '12', '7'],
        ],
      }),
      opts,
    )
    expect(out).toContain('| Alpha | 12 | 7 |\n| Beta | 34 |  |')
  })

  it('still promotes the first row when nothing above it continues', () => {
    // The mark is what makes a continuation a continuation; without a table
    // to join, a table is a table and Markdown wants its header.
    const out = buildMarkdown(continuedDoc({}, { tableContinuation: false }), opts)
    // Two tables, two headers: each stands alone with a separator of its own.
    expect(out.match(/\| --- \|/g)).toHaveLength(2)
    expect(out).toContain('| Name | Value |\n| --- | --- |\n| Alpha | 12 |')
    expect(out).toContain('| Beta | 34 |\n| --- | --- |')
  })

  it('leaves a lone continuation standing when the part above is prose', () => {
    // Nothing to join onto: the rows print as their own table rather than
    // being appended to a paragraph, which would make no sense at all.
    const out = buildMarkdown(
      {
        ...makeDoc(),
        pages: [
          {
            index: 0,
            width: 612,
            height: 792,
            rotation: 0,
            contentClass: 'text',
            blocks: [block({ order: 0, sourceText: 'Some prose.', translatedText: 'Some prose.' })],
          },
          {
            index: 1,
            width: 612,
            height: 792,
            rotation: 0,
            contentClass: 'text',
            blocks: [block({ order: 0, ...OVER })],
          },
        ],
      },
      opts,
    )
    expect(out).toContain('Some prose.\n\n| Beta | 34 |')
    expect(out.match(/\| --- \|/g)).toHaveLength(1)
  })
})

describe('buildMarkdown figures', () => {
  const opts = { title: 'Sample', includeOriginal: false, includePageHeadings: false }
  const ART = [{ key: 'fig#0', bytes: new Uint8Array([1]), dataUrl: 'data:image/png;base64,AQ==' }]

  function figureDoc(figure: Partial<ExportBlock>): ExportDocument {
    const doc = makeDoc()
    doc.pages = [
      {
        index: 0,
        width: 612,
        height: 792,
        rotation: 0,
        contentClass: 'mixed',
        blocks: [block({ id: 'fig', y: 200, sourceText: '', translatedText: '', ...figure })],
      },
    ]
    doc.pageCount = 1
    return doc
  }

  it('inlines the picture as a data URI', () => {
    const out = buildMarkdown(
      figureDoc({
        sourceText: 'Figure 1 — Stages',
        figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
      }),
      { ...opts, figures: ART },
    )
    expect(out).toContain('![Figure 1 — Stages](data:image/png;base64,AQ==)')
  })

  it('puts a picture painted above its caption before the caption', () => {
    const out = buildMarkdown(
      figureDoc({
        sourceText: 'Figure 2 — Stages',
        figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
      }),
      { ...opts, figures: ART },
    )
    expect(out.indexOf('![')).toBeLessThan(out.indexOf('Figure 2'))
  })

  it('puts a picture painted below its block after it', () => {
    const out = buildMarkdown(
      figureDoc({
        sourceText: 'The pipeline runs in four stages.',
        figures: [ref({ x: 100, y: 400, w: 300, h: 140 })],
      }),
      { ...opts, figures: ART },
    )
    expect(out.indexOf('![')).toBeGreaterThan(out.indexOf('The pipeline runs'))
  })

  it('reuses the caption as alt text and gives a prose figure none', () => {
    const captioned = buildMarkdown(
      figureDoc({
        sourceText: 'Figure 3 — Deployment',
        figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
      }),
      { ...opts, figures: ART },
    )
    expect(captioned).toContain('![Figure 3 — Deployment](data:')

    const unlabelled = buildMarkdown(
      figureDoc({
        sourceText: 'The pipeline runs in four stages.',
        figures: [ref({ x: 100, y: 400, w: 300, h: 140 })],
      }),
      { ...opts, figures: ART },
    )
    expect(unlabelled).toContain('![](data:image/png;base64,AQ==)')
  })

  it('escapes a bracket that would end the alt label early', () => {
    const out = buildMarkdown(
      figureDoc({
        sourceText: 'Figure 4 — [stages]',
        figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
      }),
      { ...opts, figures: ART },
    )
    expect(out).toContain('![Figure 4 — \\[stages\\]](data:')
  })

  it('skips a figure whose crop never came back', () => {
    const out = buildMarkdown(
      figureDoc({
        sourceText: 'Figure 5 — Lost',
        figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
      }),
      { ...opts, figures: [] },
    )
    expect(out).not.toContain('![')
    expect(out).toContain('Figure 5 — Lost')
  })

  it('leaves a document with no figures untouched', () => {
    const withArt = buildMarkdown(figureDoc({ sourceText: 'Plain paragraph' }), {
      ...opts,
      figures: ART,
    })
    const plain = buildMarkdown(figureDoc({ sourceText: 'Plain paragraph' }), opts)
    expect(withArt).toBe(plain)
  })

  it('keeps exactly one blank line around the picture', () => {
    const out = buildMarkdown(
      figureDoc({
        sourceText: 'Figure 6 — Stages',
        figures: [ref({ x: 100, y: 40, w: 300, h: 140 })],
      }),
      { ...opts, includePageHeadings: true, figures: ART },
    )
    const lines = out.split('\n')
    const image = lines.findIndex((line) => line.startsWith('!['))
    expect(lines[image - 1]).toBe('')
    expect(lines[image + 1]).toBe('')
  })
})
