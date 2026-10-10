import { describe, expect, it } from 'vitest'
import { buildJsonDocument, parseJsonDocument } from './json'
import { EXPORT_SCHEMA, type ExportBlock, type ExportDocument } from './types'

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

/** Two content pages with Latin, Myanmar, RTL and untranslated blocks. */
function makeDoc(): ExportDocument {
  return {
    schema: EXPORT_SCHEMA,
    projectId: 'p1',
    title: 'Sample',
    sourceFileName: 'sample.pdf',
    sourceLang: 'en',
    targetLang: 'my',
    pageCount: 2,
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
            x: 12,
            y: 34,
            width: 240,
            height: 30,
            fontSize: 24,
          }),
          block({
            id: 'b2',
            order: 1,
            listMarker: '•',
            sourceText: 'Hello world',
            translatedText: 'Good morning',
            x: 12.5,
            y: 72.25,
            width: 200,
            height: 18,
          }),
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
            id: 'b3',
            order: 0,
            sourceText: 'Welcome',
            translatedText: 'مرحبا بالعالم',
            direction: 'rtl',
            x: 48,
            y: 100,
            width: 150,
            height: 20,
          }),
          block({
            id: 'b4',
            order: 1,
            sourceText: 'Locked line',
            translatedText: '',
            status: 'locked',
            x: 48,
            y: 130,
            width: 150,
            height: 20,
          }),
        ],
      },
    ],
  }
}

describe('buildJsonDocument', () => {
  it('writes a self-describing envelope', () => {
    const doc = makeDoc()
    const envelope = JSON.parse(buildJsonDocument(doc, { pretty: false, includeGeometry: true }))
    expect(envelope.schema).toBe(EXPORT_SCHEMA)
    expect(envelope.format).toBe('json')
    expect(envelope.exportedAt).toBe(doc.exportedAt)
    expect(envelope.document.title).toBe('Sample')
    expect(envelope.document.pages).toHaveLength(2)
  })

  it('indents pretty output with two spaces', () => {
    const out = buildJsonDocument(makeDoc(), { pretty: true, includeGeometry: true })
    expect(out).toContain('\n  "schema":')
    expect(out.split('\n').length).toBeGreaterThan(10)
  })

  it('emits a single line for compact output', () => {
    const out = buildJsonDocument(makeDoc(), { pretty: false, includeGeometry: false })
    expect(out).not.toContain('\n')
  })

  it('round-trips pretty documents with geometry', () => {
    const doc = makeDoc()
    const parsed = parseJsonDocument(
      buildJsonDocument(doc, { pretty: true, includeGeometry: true }),
    )
    expect(parsed).toEqual(doc)
  })

  it('round-trips compact documents with geometry', () => {
    const doc = makeDoc()
    const parsed = parseJsonDocument(
      buildJsonDocument(doc, { pretty: false, includeGeometry: true }),
    )
    expect(parsed).toEqual(doc)
  })

  it('keeps block geometry when includeGeometry is on', () => {
    const parsed = parseJsonDocument(
      buildJsonDocument(makeDoc(), { pretty: false, includeGeometry: true }),
    )
    expect(parsed.pages[0].blocks[0]).toMatchObject({
      x: 12,
      y: 34,
      width: 240,
      height: 30,
      fontSize: 24,
    })
  })

  it('strips only x/y/width/height from blocks when includeGeometry is off', () => {
    const parsed = parseJsonDocument(
      buildJsonDocument(makeDoc(), { pretty: true, includeGeometry: false }),
    )
    const stripped = parsed.pages[0].blocks[0]
    expect(stripped).not.toHaveProperty('x')
    expect(stripped).not.toHaveProperty('y')
    expect(stripped).not.toHaveProperty('width')
    expect(stripped).not.toHaveProperty('height')
    // Everything else — including fontSize — survives.
    expect(stripped).toHaveProperty('fontSize', 24)
    expect(stripped).toHaveProperty('id', 'b1')
    expect(stripped.translatedText).toBe('မြန်မာစာ')
    expect(parsed.pages[0].width).toBe(612)
    expect(parsed.pages[0].blocks[1].listMarker).toBe('•')
  })

  it('carries links with or without geometry, and back unchanged', () => {
    const links = [
      { text: 'pricing page', url: 'https://example.com/pricing' },
      { text: 'www.example.org', url: 'https://www.example.org/' },
    ]
    const doc: ExportDocument = {
      ...makeDoc(),
      pages: [
        {
          index: 0,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'text',
          blocks: [block({ id: 'linked', links, sourceText: 'See the pricing page' })],
        },
      ],
    }

    for (const includeGeometry of [true, false]) {
      const parsed = parseJsonDocument(buildJsonDocument(doc, { pretty: false, includeGeometry }))
      expect(parsed.pages[0].blocks[0].links).toEqual(links)
    }
  })

  it('writes an empty array rather than omitting a block with no links', () => {
    const parsed = parseJsonDocument(
      buildJsonDocument(makeDoc(), { pretty: false, includeGeometry: true }),
    )
    expect(parsed.pages[0].blocks[0].links).toEqual([])
  })

  it('carries a table grid with or without geometry, and back unchanged', () => {
    const tableCells = [
      ['Name', 'Value'],
      ['Alpha', '12'],
    ]
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
            block({
              id: 'tbl',
              kind: 'table',
              tableCells,
              sourceText: 'Name \t Value\nAlpha \t 12',
            }),
          ],
        },
      ],
    }

    for (const includeGeometry of [true, false]) {
      const parsed = parseJsonDocument(buildJsonDocument(doc, { pretty: false, includeGeometry }))
      expect(parsed.pages[0].blocks[0].tableCells).toEqual(tableCells)
    }
  })

  it('carries the column spans beside the grid, and back unchanged', () => {
    const tableCells = [
      ['Region', 'First half 2026', ''],
      ['North', '120', '150'],
    ]
    const tableSpans = [
      [1, 2, 0],
      [1, 1, 1],
    ]
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
            block({
              id: 'tbl',
              kind: 'table',
              tableCells,
              tableSpans,
              sourceText: 'Region \t First half 2026 \t \nNorth \t 120 \t 150',
            }),
          ],
        },
      ],
    }

    for (const includeGeometry of [true, false]) {
      const parsed = parseJsonDocument(buildJsonDocument(doc, { pretty: false, includeGeometry }))
      expect(parsed.pages[0].blocks[0].tableSpans).toEqual(tableSpans)
    }
  })

  it('carries the continuation flag beside the grid, and back unchanged', () => {
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
            block({
              id: 'over',
              kind: 'table',
              tableContinuation: true,
              tableCells: [['West', '200', '210']],
              sourceText: 'West \t 200 \t 210',
              translatedText: 'West \t 200 \t 210',
            }),
          ],
        },
      ],
    }

    for (const includeGeometry of [true, false]) {
      const parsed = parseJsonDocument(buildJsonDocument(doc, { pretty: false, includeGeometry }))
      expect(parsed.pages[0].blocks[0].tableContinuation).toBe(true)
    }
  })

  it('writes no continuation flag for a table that stands alone', () => {
    const parsed = parseJsonDocument(
      buildJsonDocument(makeDoc(), { pretty: false, includeGeometry: true }),
    )
    expect(parsed.pages[0].blocks[0].tableContinuation).toBeUndefined()
  })

  it('writes null rather than omitting a block with no cells', () => {
    const parsed = parseJsonDocument(
      buildJsonDocument(makeDoc(), { pretty: false, includeGeometry: true }),
    )
    expect(parsed.pages[0].blocks[0].tableCells).toBeNull()
  })
})

describe('parseJsonDocument', () => {
  it('rejects malformed JSON and non-object roots', () => {
    expect(() => parseJsonDocument('{')).toThrow()
    expect(() => parseJsonDocument('')).toThrow()
    expect(() => parseJsonDocument('null')).toThrow()
    expect(() => parseJsonDocument('[1,2]')).toThrow()
  })

  it('rejects an unsupported schema', () => {
    const bad = JSON.stringify({
      schema: 999,
      format: 'json',
      exportedAt: 1,
      document: { pages: [] },
    })
    expect(() => parseJsonDocument(bad)).toThrow(/schema/)
  })

  it('rejects an envelope without a document', () => {
    const bad = JSON.stringify({ schema: EXPORT_SCHEMA, format: 'json', exportedAt: 1 })
    expect(() => parseJsonDocument(bad)).toThrow()
  })

  it('rejects a document whose pages are not an array', () => {
    const bad = JSON.stringify({ schema: EXPORT_SCHEMA, document: { pages: {} } })
    expect(() => parseJsonDocument(bad)).toThrow(/array/)
  })

  it('rejects a page without numeric index/width/height', () => {
    const wrongType = JSON.stringify({
      schema: EXPORT_SCHEMA,
      document: { pages: [{ index: '0', width: 612, height: 792 }] },
    })
    expect(() => parseJsonDocument(wrongType)).toThrow()
    const missing = JSON.stringify({
      schema: EXPORT_SCHEMA,
      document: { pages: [{ width: 612 }] },
    })
    expect(() => parseJsonDocument(missing)).toThrow()
  })
})
