import { describe, expect, it } from 'vitest'
import { buildCsv, buildDelimited, buildTsv, escapeDelimited } from './delimited'
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
    links: [],
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

/** Two content pages, five text blocks, one block with no text at all. */
function makeDoc(): ExportDocument {
  return {
    schema: 1,
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
            sourceText: 'Hello',
            translatedText: 'Bonjour',
            status: 'translated',
          }),
          block({
            id: 'b2',
            order: 1,
            sourceText: 'a,b',
            translatedText: 'x y',
            status: 'edited',
          }),
          block({
            id: 'b3',
            order: 2,
            sourceText: 'say "hi"',
            translatedText: '',
            status: 'pending',
          }),
          // No source and no target: never gets a row.
          block({ id: 'b4', order: 3, sourceText: '', translatedText: '' }),
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
            kind: 'caption',
            sourceText: 'Locked line',
            translatedText: '',
            status: 'locked',
          }),
          block({
            id: 'b6',
            order: 1,
            kind: 'list',
            listMarker: '1.',
            sourceText: 'multi\nline',
            translatedText: 'two lines',
            status: 'translated',
          }),
        ],
      },
    ],
  }
}

describe('escapeDelimited', () => {
  it('leaves plain and empty values unquoted', () => {
    expect(escapeDelimited('plain value', ',')).toBe('plain value')
    expect(escapeDelimited('', ',')).toBe('')
    expect(escapeDelimited('a b', '\t')).toBe('a b')
  })

  it('quotes a value containing the delimiter', () => {
    expect(escapeDelimited('a,b', ',')).toBe('"a,b"')
    expect(escapeDelimited('a\tb', '\t')).toBe('"a\tb"')
    // A comma needs no quoting in a TSV, a tab needs none in a CSV.
    expect(escapeDelimited('a,b', '\t')).toBe('a,b')
    expect(escapeDelimited('a\tb', ',')).toBe('a\tb')
  })

  it('quotes embedded quotes and doubles them', () => {
    expect(escapeDelimited('say "hi"', ',')).toBe('"say ""hi"""')
    expect(escapeDelimited('"', ',')).toBe('""""')
  })

  it('quotes embedded newlines and preserves them', () => {
    expect(escapeDelimited('line1\nline2', ',')).toBe('"line1\nline2"')
  })
})

describe('buildDelimited', () => {
  it('builds a CSV with a header, CRLF rows and RFC 4180 quoting', () => {
    const out = buildCsv(makeDoc())
    const expected = [
      'page,order,source,target',
      '1,1,Hello,Bonjour',
      '1,2,"a,b",x y',
      '1,3,"say ""hi""","say ""hi"""',
      '2,1,Locked line,Locked line',
      '2,2,"multi\nline",two lines',
    ].join('\r\n')
    expect(out).toBe(expected)
  })

  it('emits one row per content block plus the header and nothing for empty blocks', () => {
    const out = buildCsv(makeDoc())
    const rows = out.split('\r\n')
    expect(rows).toHaveLength(6)
    // 5 CRLF terminators = 6 rows; the embedded \n must not count as a row.
    expect(out.match(/\r\n/g)).toHaveLength(5)
  })

  it('builds a TSV whose comma values stay unquoted', () => {
    const tsv = buildTsv(makeDoc())
    const rows = tsv.split('\r\n')
    expect(rows[0]).toBe('page\torder\tsource\ttarget')
    expect(rows[2]).toBe('1\t2\ta,b\tx y')
    expect(rows[3]).toBe('1\t3\t"say ""hi"""\t"say ""hi"""')
    expect(rows).toHaveLength(6)
  })

  it('honours header: false', () => {
    const out = buildCsv(makeDoc(), { header: false })
    expect(out.startsWith('1,1,Hello,Bonjour')).toBe(true)
    expect(out.split('\r\n')).toHaveLength(5)
  })

  it('honours a custom column list in order', () => {
    const out = buildCsv(makeDoc(), { columns: ['page', 'kind', 'status'] })
    const rows = out.split('\r\n')
    expect(rows[0]).toBe('page,kind,status')
    expect(rows[1]).toBe('1,heading,translated')
    expect(rows[4]).toBe('2,caption,locked')
  })

  it('falls back to the source when the target is empty', () => {
    const out = buildCsv(makeDoc(), { columns: ['source', 'target'] })
    expect(out).toContain('Locked line,Locked line')
    expect(out).toContain('"say ""hi""","say ""hi"""')
  })

  it('keeps the header for a document with no text blocks', () => {
    const empty: ExportDocument = {
      ...makeDoc(),
      pages: [
        { index: 0, width: 612, height: 792, rotation: 0, contentClass: 'empty', blocks: [] },
      ],
    }
    expect(buildCsv(empty)).toBe('page,order,source,target')
    expect(buildDelimited(empty, { delimiter: ',', header: false, columns: ['page'] })).toBe('')
  })
})
