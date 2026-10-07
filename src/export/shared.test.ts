import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_STACK,
  documentStats,
  escapeHtml,
  cssFontName,
  fileNameFor,
  fontStackFor,
  isDocumentEmpty,
  langTag,
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
