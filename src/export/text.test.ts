import { describe, expect, it } from 'vitest'
import { buildPlainText, buildPlainTextDefault, wrapText, type TextOptions } from './text'
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
    tableCells: null,
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
          }),
          block({
            id: 'b2',
            order: 1,
            kind: 'list',
            listMarker: '•',
            sourceText: 'Hello world',
            translatedText: 'Good morning',
          }),
          block({
            id: 'b3',
            order: 2,
            sourceText: 'The quick brown fox jumps over the lazy dog and keeps running',
            translatedText: '',
            status: 'pending',
          }),
          // Whitespace only: must never reach the output.
          block({ id: 'b4', order: 3, sourceText: '   ', translatedText: '' }),
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
          }),
          block({
            id: 'b6',
            order: 1,
            sourceText: 'Locked line',
            translatedText: '',
            status: 'locked',
          }),
        ],
      },
      { index: 2, width: 612, height: 792, rotation: 0, contentClass: 'empty', blocks: [] },
    ],
  }
}

const defaults: TextOptions = {
  includeOriginal: false,
  wrapWidth: 0,
  pageSeparator: '\f',
  pageHeader: '',
}

describe('wrapText', () => {
  it('returns the input unchanged at width 0, trimming line ends', () => {
    expect(wrapText('plain text', 0)).toBe('plain text')
    expect(wrapText('  padded line  \nsecond ', 0)).toBe('  padded line\nsecond')
    expect(wrapText('  padded line  \nsecond ', -1)).toBe('  padded line\nsecond')
  })

  it('greedily wraps a long sentence at 20 columns', () => {
    const sentence =
      'The quick brown fox jumps over the lazy dog and keeps running through the field'
    const lines = wrapText(sentence, 20).split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
    expect(lines.join(' ')).toBe(sentence)
  })

  it('moves a whole word to the next line instead of splitting it', () => {
    expect(wrapText('supercalifragilistic word', 10)).toBe('supercalifragilistic\nword')
  })

  it('keeps an un-splittable over-long word intact on its own line', () => {
    const lines = wrapText('antidisestablishmentarianism rocks', 10).split('\n')
    expect(lines).toEqual(['antidisestablishmentarianism', 'rocks'])
    expect(lines[0].length).toBeGreaterThan(10)
  })

  it('breaks CJK text between characters without exceeding the width', () => {
    const text = '你好世界你好世界'
    const lines = wrapText(text, 3).split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(3)
    expect(lines.join('')).toBe(text)
  })

  it('breaks Myanmar text at base characters, never at a combining mark', () => {
    const text = 'မြန်မာစာသည်လှပသည်'
    const lines = wrapText(text, 4).split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(4)
    expect(lines.join('')).toBe(text)
    const marks = ['ျ', 'ြ', 'ွ', 'ှ', '်', 'း', 'ာ', 'ိ', 'ု', 'ဲ', 'ံ', '့']
    for (const line of lines) {
      expect(marks.some((mark) => line.startsWith(mark))).toBe(false)
    }
  })
})

describe('buildPlainText', () => {
  it('writes one line per block and separates pages with a form feed', () => {
    const out = buildPlainText(makeDoc(), defaults)
    const page1 = [
      'မြန်မာစာ',
      '• Good morning',
      'The quick brown fox jumps over the lazy dog and keeps running',
    ].join('\n')
    const page2 = ['مرحبا بالعالم', 'Locked line'].join('\n')
    expect(out).toBe(`${page1}\f${page2}\n`)
  })

  it('separates pages with the configured pageSeparator and ends with one newline', () => {
    const out = buildPlainTextDefault(makeDoc(), { ...defaults, pageSeparator: '\n---\n' })
    expect(out.split('\n---\n')).toHaveLength(2)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  it('substitutes the {page} token in each page header', () => {
    const out = buildPlainText(makeDoc(), { ...defaults, pageHeader: '--- Page {page} ---' })
    expect(out.startsWith('--- Page 1 ---\nမြန်မာစာ')).toBe(true)
    expect(out).toContain('\f--- Page 2 ---\nمرحبا بالعالم')
    expect(out).not.toContain('Page 3')
  })

  it('prints source above target when includeOriginal is on, once per block', () => {
    const out = buildPlainText(makeDoc(), { ...defaults, includeOriginal: true })
    expect(out).toContain('Chapter One\nမြန်မာစာ')
    expect(out).toContain('Hello world\n• Good morning')
    expect(out).toContain('Welcome\nمرحبا بالعالم')
    // Untranslated blocks stay a single line instead of repeating themselves.
    expect(out).not.toContain('Locked line\nLocked line')
    expect(out).not.toContain('running\nThe quick brown fox')
  })

  it('wraps every block at the configured width', () => {
    const out = buildPlainText(makeDoc(), { ...defaults, wrapWidth: 20 })
    const lines = out
      .split('\f')
      .join('\n')
      .split('\n')
      .filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThan(6)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
  })

  it('returns an empty string for a document without text pages', () => {
    const empty: ExportDocument = { ...makeDoc(), pages: [] }
    expect(buildPlainText(empty, defaults)).toBe('')
    expect(buildPlainTextDefault(empty, defaults)).toBe('')
  })
})
