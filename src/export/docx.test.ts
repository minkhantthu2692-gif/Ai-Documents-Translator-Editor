import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildDocx, type DocxOptions } from './docx'
import type { ExportBlock, ExportDocument, ExportPage } from './types'

function block(partial: Partial<ExportBlock>): ExportBlock {
  return {
    id: 'block',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 10,
    y: 20,
    width: 500,
    height: 24,
    fontFamily: 'Noto Sans',
    fontSize: 12,
    lineHeight: 1.5,
    color: '#000000',
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
    ...partial,
  }
}

function page(index: number, blocks: ExportBlock[]): ExportPage {
  return { index, width: 595, height: 842, rotation: 0, contentClass: 'text', blocks }
}

/** Two pages covering Latin, Myanmar, RTL, list, untranslated and emphasis. */
function fixtureDoc(): ExportDocument {
  return {
    schema: 1,
    projectId: 'prj_docx',
    title: 'မြန်မာစာ စာအုပ်',
    sourceFileName: 'sample.pdf',
    sourceLang: 'en',
    targetLang: 'my',
    pageCount: 2,
    exportedAt: 1_760_000_000_000,
    templateId: null,
    pages: [
      page(0, [
        block({
          id: 'latin',
          sourceText: 'Hello world',
          translatedText: 'မြန်မာစာ ကြိုဆိုပါသည်',
        }),
        block({
          id: 'arabic',
          order: 1,
          sourceText: 'Welcome',
          translatedText: 'مرحبا بالعالم',
          alignment: 'right',
        }),
        block({
          id: 'list',
          order: 2,
          listMarker: '1.',
          sourceText: 'First point',
          translatedText: 'ပထမအချက်',
        }),
        block({
          id: 'plain',
          order: 3,
          alignment: 'right',
          sourceText: 'Untranslated line',
          translatedText: '',
        }),
        block({
          id: 'emph',
          order: 4,
          bold: true,
          italic: true,
          color: '#ff0000',
          fontSize: 24,
          alignment: 'center',
          sourceText: 'Bold italic line',
          translatedText: 'ထူးခြားစာကြောင်း',
        }),
        block({ id: 'empty', order: 5, sourceText: '   ', translatedText: '' }),
        block({
          id: 'justified',
          order: 6,
          alignment: 'justified',
          sourceText: 'Justified paragraph',
          translatedText: 'ချိန်ညှိထားသောစာပိုဒ်',
        }),
      ]),
      page(1, [
        block({ id: 'p2', sourceText: 'Page two source', translatedText: 'စာမျက်နှာနှစ်' }),
      ]),
    ],
  }
}

function options(overrides: Partial<DocxOptions> = {}): DocxOptions {
  return {
    title: 'မြန်မာစာ စာအုပ်',
    includeOriginal: false,
    titleHeading: true,
    font: 'Noto Sans Myanmar',
    pageHeadings: false,
    pageBreaks: false,
    ...overrides,
  }
}

async function zipText(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file(path)
  if (!entry) throw new Error(`missing zip entry: ${path}`)
  return entry.async('string')
}

describe('buildDocx', () => {
  it('packs browser-safe DOCX bytes with the PK signature', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(1000)
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)

    const zip = await JSZip.loadAsync(bytes)
    const parts = [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'docProps/core.xml',
    ]
    for (const part of parts) {
      expect(zip.file(part), part).not.toBeNull()
    }
  })

  it('writes Myanmar text verbatim and skips empty blocks', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('မြန်မာစာ')
    expect(xml).not.toContain('   ')
  })

  it('declares the export font on runs and in the document defaults', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    const styles = await zipText(bytes, 'word/styles.xml')
    expect(xml).toContain('Noto Sans Myanmar')
    expect(styles).toContain('Noto Sans Myanmar')
  })

  it('marks RTL paragraphs bidirectional and right-to-left', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('<w:bidi/>')
    expect(xml).toContain('<w:rtl/>')
    // docx swaps left/right inside a bidi paragraph, so the RTL block's
    // physical right alignment is written as `w:jc w:val="left"`.
    expect(xml).toMatch(/<w:bidi\/><w:spacing[^>]*\/><w:jc[^>]*w:val="left"/)
  })

  it('maps alignment, emphasis, colour and font size', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toMatch(/<w:jc[^>]*w:val="center"/)
    expect(xml).toMatch(/<w:jc[^>]*w:val="both"/)
    expect(xml).toMatch(/<w:b\/>/)
    expect(xml).toMatch(/<w:i\/>/)
    expect(xml).toMatch(/<w:color[^>]*w:val="FF0000"/)
    expect(xml).toMatch(/<w:sz[^>]*w:val="48"/)
  })

  it('prefixes the list marker', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('1. ပထမအချက်')
  })

  it('emits the source before the translation when includeOriginal is on', async () => {
    const bilingual = await zipText(
      await buildDocx(fixtureDoc(), options({ includeOriginal: true })),
      'word/document.xml',
    )
    expect(bilingual.indexOf('Hello world')).toBeLessThan(
      bilingual.indexOf('မြန်မာစာ ကြိုဆိုပါသည်'),
    )
    expect(bilingual.indexOf('Welcome')).toBeLessThan(bilingual.indexOf('مرحبا بالعالم'))

    const mono = await zipText(await buildDocx(fixtureDoc(), options()), 'word/document.xml')
    expect(mono).not.toContain('Hello world')
    expect(mono).toContain('မြန်မာစာ ကြိုဆိုပါသည်')
  })

  it('adds the title heading, page headings and page breaks on request', async () => {
    const bytes = await buildDocx(
      fixtureDoc(),
      options({ titleHeading: true, pageHeadings: true, pageBreaks: true }),
    )
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toContain('မြန်မာစာ စာအုပ်')
    expect(xml).toContain('Page 1')
    expect(xml).toContain('Page 2')
    expect(xml).toContain('w:type="page"')

    const plain = await zipText(await buildDocx(fixtureDoc(), options()), 'word/document.xml')
    expect(plain).not.toContain('w:type="page"')
    expect(plain).not.toContain('Page 1')
  })

  it('sizes the section from the first source page (points → twips)', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const xml = await zipText(bytes, 'word/document.xml')
    expect(xml).toMatch(/<w:pgSz[^>]*w:w="11900"/)
    expect(xml).toMatch(/<w:pgSz[^>]*w:h="16840"/)
  })

  it('sets the core properties', async () => {
    const bytes = await buildDocx(fixtureDoc(), options())
    const core = await zipText(bytes, 'docProps/core.xml')
    expect(core).toContain('မြန်မာစာ စာအုပ်')
    expect(core).toContain('AI Documents Translator')
    expect(core).toContain('en → my')
  })

  it('wraps builder failures in DOCX_FAILED', async () => {
    const broken = {
      get pages(): ExportPage[] {
        throw new Error('boom')
      },
    } as unknown as ExportDocument
    await expect(buildDocx(broken, options())).rejects.toThrow('DOCX_FAILED: boom')
  })
})
