import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildEpub, type EpubOptions } from './epub'
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
    ...partial,
  }
}

function page(index: number, blocks: ExportBlock[]): ExportPage {
  return { index, width: 595, height: 842, rotation: 0, contentClass: 'text', blocks }
}

/** Two pages covering Latin, Myanmar, RTL, list, escaping and a raw source. */
function fixtureDoc(): ExportDocument {
  return {
    schema: 1,
    projectId: 'prj_epub',
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
          id: 'escaping',
          order: 3,
          sourceText: 'Fish & chips <b>bold</b>',
          translatedText: 'ငါးနှင့် အသုပ်',
        }),
        block({ id: 'empty', order: 4, sourceText: '', translatedText: '' }),
      ]),
      page(1, [
        block({ id: 'p2', sourceText: 'Page two source', translatedText: 'စာမျက်နှာနှစ်' }),
      ]),
    ],
  }
}

function epubOptions(overrides: Partial<EpubOptions> = {}): EpubOptions {
  return {
    title: 'မြန်မာစာ စာအုပ်',
    author: 'AI Documents Translator',
    lang: 'my',
    includeOriginal: false,
    fontStack: '"Noto Sans Myanmar", "Padauk", sans-serif',
    ...overrides,
  }
}

async function zipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path)
  if (!entry) throw new Error(`missing zip entry: ${path}`)
  return entry.async('string')
}

function expectWellFormed(xml: string, label: string): void {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml')
  const errors = Array.from(parsed.getElementsByTagName('parsererror'))
  expect(
    errors.map((error) => error.textContent),
    `${label} must be well-formed XML`,
  ).toEqual([])
}

describe('buildEpub', () => {
  it('starts with an uncompressed mimetype entry holding the exact media type', async () => {
    const bytes = await buildEpub(fixtureDoc(), epubOptions())
    expect(bytes).toBeInstanceOf(Uint8Array)

    const zip = await JSZip.loadAsync(bytes)
    expect(await zipText(zip, 'mimetype')).toBe('application/epub+zip')

    // Local file header of the first entry: signature, method, name.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(8, true)).toBe(0) // 0 = STORE
    const nameLength = view.getUint16(26, true)
    const name = String.fromCharCode(...bytes.subarray(30, 30 + nameLength))
    expect(name).toBe('mimetype')
  })

  it('points the container document at OEBPS/content.opf', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(fixtureDoc(), epubOptions()))
    const container = zip.file('META-INF/container.xml')
    expect(container).not.toBeNull()
    const xml = await zipText(zip, 'META-INF/container.xml')
    expect(xml).toContain('OEBPS/content.opf')
    expect(xml).toContain('urn:oasis:names:tc:opendocument:xmlns:container')
  })

  it('writes a package document with metadata, manifest and spine', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(fixtureDoc(), epubOptions()))
    expect(zip.file('OEBPS/content.opf')).not.toBeNull()

    const opf = await zipText(zip, 'OEBPS/content.opf')
    expect(opf).toContain('<dc:title>မြန်မာစာ စာအုပ်</dc:title>')
    expect(opf).toContain('<dc:language>my</dc:language>')
    expect(opf).toContain('<dc:creator>AI Documents Translator</dc:creator>')
    expect(opf).toMatch(
      /<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/,
    )
    expect(opf).toContain('<item ')
    expect(opf).toContain('properties="nav"')
    expect(opf).toContain('<itemref ')
  })

  it('lists every chapter in the EPUB 3 navigation document', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(fixtureDoc(), epubOptions()))
    const nav = await zipText(zip, 'OEBPS/nav.xhtml')
    expect(nav).toContain('epub="toc"')
    expect(nav).toContain('href="text/chap_1.xhtml"')
    expect(nav).toContain('Page 1')
  })

  it('renders Myanmar verbatim and RTL blocks with dir="rtl" in chapters', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(fixtureDoc(), epubOptions()))
    expect(zip.file('OEBPS/text/chap_1.xhtml')).not.toBeNull()

    const chapter = await zipText(zip, 'OEBPS/text/chap_1.xhtml')
    expect(chapter).toContain('မြန်မာစာ')
    expect(chapter).toContain('dir="rtl"')
    expect(chapter).toContain('class="block rtl"')
    expect(chapter).toContain('<h2>Page 1</h2>')
    expect(chapter).toContain('<h2>Page 2</h2>')
    expect(chapter).toContain('1. ပထမအချက်')
  })

  it('escapes user text and puts the source paragraph first with includeOriginal', async () => {
    const zip = await JSZip.loadAsync(
      await buildEpub(fixtureDoc(), epubOptions({ includeOriginal: true })),
    )
    const chapter = await zipText(zip, 'OEBPS/text/chap_1.xhtml')
    expect(chapter).toContain('Fish &amp; chips &lt;b&gt;bold&lt;/b&gt;')
    expect(chapter).toContain('class="source block"')
    expect(chapter.indexOf('Hello world')).toBeLessThan(chapter.indexOf('မြန်မာစာ ကြိုဆိုပါသည်'))

    const mono = await JSZip.loadAsync(await buildEpub(fixtureDoc(), epubOptions()))
    const monoChapter = await zipText(mono, 'OEBPS/text/chap_1.xhtml')
    expect(monoChapter).not.toContain('Hello world')
    expect(monoChapter).not.toContain('class="source')
  })

  it('groups at most 20 pages per chapter', async () => {
    const wide: ExportDocument = {
      ...fixtureDoc(),
      pageCount: 25,
      pages: Array.from({ length: 25 }, (_, index) =>
        page(index, [
          block({
            id: `p${index}`,
            sourceText: `Source ${index + 1}`,
            translatedText: `မြန်မာစာ ${index + 1}`,
          }),
        ]),
      ),
    }
    const zip = await JSZip.loadAsync(await buildEpub(wide, epubOptions()))
    expect(zip.file('OEBPS/text/chap_1.xhtml')).not.toBeNull()
    expect(zip.file('OEBPS/text/chap_2.xhtml')).not.toBeNull()
    expect(zip.file('OEBPS/text/chap_3.xhtml')).toBeNull()

    const nav = await zipText(zip, 'OEBPS/nav.xhtml')
    expect(nav).toContain('Page 1–20')
    expect(nav).toContain('Page 21–25')
  })

  it('embeds fonts as base64 @font-face rules and keeps the Myanmar stack', async () => {
    const zip = await JSZip.loadAsync(
      await buildEpub(
        fixtureDoc(),
        epubOptions({
          fonts: [{ fileName: 'Padauk Test.woff2', mimeType: 'font/woff2', base64: 'd09GMg==' }],
        }),
      ),
    )
    const css = await zipText(zip, 'OEBPS/css/main.css')
    expect(css).toContain('@font-face')
    expect(css).toContain('url(data:font/woff2;base64,d09GMg==)')
    expect(css).toContain('font-family: "Padauk Test"')
    expect(css).toContain('font-family: "Noto Sans Myanmar", "Padauk", sans-serif')
    expect(css).toContain('line-height: 1.7')
    expect(css).toContain('direction: rtl')
    expect(css).toContain('font-size: 0.9em')
  })

  it('emits well-formed XML for every textual part', async () => {
    const zip = await JSZip.loadAsync(
      await buildEpub(fixtureDoc(), epubOptions({ includeOriginal: true })),
    )
    expectWellFormed(await zipText(zip, 'META-INF/container.xml'), 'container.xml')
    expectWellFormed(await zipText(zip, 'OEBPS/content.opf'), 'content.opf')
    expectWellFormed(await zipText(zip, 'OEBPS/nav.xhtml'), 'nav.xhtml')
    expectWellFormed(await zipText(zip, 'OEBPS/text/chap_1.xhtml'), 'chap_1.xhtml')
  })

  it('nests a document heading under the per-page heading', async () => {
    const doc: ExportDocument = {
      ...fixtureDoc(),
      pages: [
        page(0, [
          block({
            id: 'sec',
            kind: 'heading',
            headingLevel: 1,
            sourceText: 'Chapter One',
            translatedText: 'အချက်တစ်ခု',
          }),
          block({ id: 'body', order: 1, sourceText: 'Body copy', translatedText: 'ကိုယ်ထည်' }),
        ]),
      ],
    }
    const zip = await JSZip.loadAsync(await buildEpub(doc, epubOptions()))
    const chapter = await zipText(zip, 'OEBPS/text/chap_1.xhtml')

    // Each page opens at h2, so the document's own hierarchy starts at h3.
    expect(chapter).toContain('<h2>Page 1</h2>')
    expect(chapter).toContain('<h3 class="block" xml:lang="my" lang="my"')
    expect(chapter).toContain('>အချက်တစ်ခု</h3>')
    // A body block is still a paragraph, and only one outline entry is added
    // per heading even though the source and the translation both exist.
    expect(chapter).toContain('<p class="block"')
    expect(chapter.match(/<h3 /g)).toHaveLength(1)
    expectWellFormed(chapter, 'chap_1.xhtml')
  })
})

describe('buildEpub links', () => {
  async function chapterOf(
    links: ExportBlock['links'],
    text = 'See the pricing page for details.',
  ) {
    const doc: ExportDocument = {
      ...fixtureDoc(),
      pages: [page(0, [block({ id: 'linked', links, sourceText: text, translatedText: text })])],
    }
    const zip = await JSZip.loadAsync(await buildEpub(doc, epubOptions()))
    return zipText(zip, 'OEBPS/text/chap_1.xhtml')
  }

  it('emits an <a> whose label and href are both escaped', async () => {
    const chapter = await chapterOf([
      { text: 'pricing page', url: 'https://example.com/pricing?x=1&y=2' },
    ])
    expect(chapter).toContain('<a href="https://example.com/pricing?x=1&amp;y=2">pricing page</a>')
    expectWellFormed(chapter, 'chap_1.xhtml')
  })

  it('keeps the chapter well-formed when the text itself needs escaping', async () => {
    const chapter = await chapterOf(
      [{ text: 'Click me', url: 'https://example.com/a?b=1&c=2' }],
      'Tom & Jerry <3 say Click me',
    )
    expect(chapter).toContain('Tom &amp; Jerry &lt;3 say ')
    expectWellFormed(chapter, 'chap_1.xhtml')
  })

  it('drops a link whose URL would not be safe to navigate', async () => {
    const chapter = await chapterOf(
      [{ text: 'Click me', url: 'javascript:alert(1)' }],
      'Click me now',
    )
    expect(chapter).not.toContain('javascript:')
    expect(chapter).toContain('Click me now')
    expectWellFormed(chapter, 'chap_1.xhtml')
  })

  it('writes no <a> at all for a block with no links', async () => {
    const chapter = await chapterOf([])
    expect(chapter).not.toContain('<a href=')
  })
})
