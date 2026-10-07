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
