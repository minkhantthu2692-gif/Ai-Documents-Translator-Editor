import { describe, expect, it } from 'vitest'
import type { FigureRef } from '@/pdf/structure'
import {
  MAX_FIGURE_WIDTH_PT,
  figureAlt,
  figureArtMap,
  figureGoesBefore,
  figureKey,
  figurePages,
  figureSize,
  figureTargets,
  loadFigureArt,
} from './figureArt'
import type { ExportBlock, ExportDocument } from './types'

/** A traced figure for a page-space box, at the 2× the fixtures were rendered at. */
function ref(bbox: { x: number; y: number; w: number; h: number }): FigureRef {
  return { bbox, pixelWidth: bbox.w * 2, pixelHeight: bbox.h * 2 }
}

/** A 1×1 transparent PNG, for the tests that need real bytes. */
const PNG_1x1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
)

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
    y: 200,
    width: 400,
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
    sourceText: 'The pipeline runs in four stages.',
    translatedText: 'စက်ကိရိယာသည် အဆင့်လေးဆင့်ဖြင့် လည်ပတ်သည်။',
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

function docWith(blocks: ExportBlock[]): ExportDocument {
  return {
    schema: 1,
    projectId: 'p1',
    title: 'Sample',
    sourceFileName: 'sample.pdf',
    sourceLang: 'en',
    targetLang: 'my',
    pageCount: 1,
    exportedAt: 1700000000000,
    templateId: null,
    pages: [{ index: 0, width: 612, height: 792, rotation: 0, contentClass: 'mixed', blocks }],
  }
}

describe('figureKey', () => {
  it('names one figure on one block and distinguishes neighbours', () => {
    expect(figureKey('p0:abc:1', 0)).toBe('p0:abc:1#0')
    expect(figureKey('p0:abc:1', 1)).not.toBe(figureKey('p0:abc:1', 0))
    expect(figureKey('p0:abc:1', 0)).not.toBe(figureKey('p0:abc:2', 0))
  })
})

describe('figureTargets', () => {
  it('walks pages then blocks and keys every figure', () => {
    const doc: ExportDocument = {
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
          contentClass: 'mixed',
          blocks: [
            block({
              id: 'b1',
              figures: [
                { bbox: { x: 20, y: 40, w: 300, h: 140 }, pixelWidth: 600, pixelHeight: 280 },
                { bbox: { x: 40, y: 200, w: 120, h: 90 }, pixelWidth: 240, pixelHeight: 180 },
              ],
            }),
            block({ id: 'b2', figures: [ref({ x: 60, y: 80, w: 200, h: 200 })] }),
          ],
        },
        {
          index: 1,
          width: 612,
          height: 792,
          rotation: 0,
          contentClass: 'mixed',
          blocks: [
            block({
              id: 'b3',
              figures: [ref({ x: 72, y: 72, w: 240, h: 160 })],
            }),
          ],
        },
      ],
    }
    // Page order first, then block order, then figure order.
    expect(figureTargets(doc).map((target) => target.key)).toEqual(['b1#0', 'b1#1', 'b2#0', 'b3#0'])
    expect(figureTargets(doc).map((target) => target.pageIndex)).toEqual([0, 0, 0, 1])
    expect(figureTargets(doc)[3].bbox).toEqual({ x: 72, y: 72, w: 240, h: 160 })
  })

  it('is empty for a document with no figures', () => {
    expect(figureTargets(docWith([block({})]))).toEqual([])
  })
})

describe('figurePages', () => {
  it('lists the pages that carry a picture, ascending and without repeats', () => {
    const doc = docWith([
      block({ id: 'a', figures: [ref({ x: 0, y: 0, w: 10, h: 10 })] }),
      block({ id: 'b' }),
    ])
    doc.pages.push({
      index: 2,
      width: 612,
      height: 792,
      rotation: 0,
      contentClass: 'mixed',
      blocks: [
        block({ id: 'c', figures: [ref({ x: 0, y: 0, w: 10, h: 10 })] }),
        block({ id: 'd', figures: [ref({ x: 0, y: 20, w: 10, h: 10 })] }),
      ],
    })
    expect(figurePages(doc)).toEqual([0, 2])
  })
})

describe('figureSize', () => {
  it('keeps the printed size of a figure that already fits the column', () => {
    expect(figureSize({ x: 0, y: 0, w: 300, h: 140 })).toEqual({
      widthPt: 300,
      heightPt: 140,
      widthPx: 400,
      heightPx: 187,
    })
  })

  it('shrinks an over-wide figure proportionally', () => {
    expect(figureSize({ x: 0, y: 0, w: 600, h: 300 })).toEqual({
      widthPt: 480,
      heightPt: 240,
      widthPx: 640,
      heightPx: 320,
    })
  })

  it('honours an explicit column width', () => {
    expect(figureSize({ x: 0, y: 0, w: 600, h: 300 }, 240).widthPt).toBe(240)
    expect(figureSize({ x: 0, y: 0, w: 600, h: 300 }, 240).heightPt).toBe(120)
  })

  it('never returns a zero or negative size for a degenerate box', () => {
    const size = figureSize({ x: 0, y: 0, w: 0, h: 0 })
    expect(size.widthPx).toBeGreaterThan(0)
    expect(size.heightPx).toBeGreaterThan(0)
    expect(Number.isFinite(size.widthPt)).toBe(true)
  })

  it('exports the default column width as a sane print measure', () => {
    expect(MAX_FIGURE_WIDTH_PT).toBeGreaterThan(300)
    expect(MAX_FIGURE_WIDTH_PT).toBeLessThan(612)
  })
})

describe('figureGoesBefore', () => {
  const caption = block({ id: 'c', x: 12, y: 200, width: 400, height: 18 })

  it('puts a figure painted above its block before it', () => {
    expect(figureGoesBefore(caption, { x: 20, y: 40, w: 300, h: 140 })).toBe(true)
  })

  it('puts a figure painted below its block after it', () => {
    expect(figureGoesBefore(caption, { x: 20, y: 240, w: 300, h: 140 })).toBe(false)
  })

  it('breaks a straddling figure on its midpoint', () => {
    // A title printed straight through a chart still reads as "above".
    expect(figureGoesBefore(caption, { x: 20, y: 0, w: 300, h: 400 })).toBe(true)
    expect(figureGoesBefore(caption, { x: 20, y: 30, w: 300, h: 400 })).toBe(false)
  })
})

describe('figureAlt', () => {
  it('reuses the caption that owns the figure', () => {
    expect(figureAlt(block({ sourceText: 'Figure 1 — Stages of the pipeline' }))).toBe(
      'Figure 1 — Stages of the pipeline',
    )
  })

  it('stays empty for a figure anchored to ordinary prose', () => {
    expect(figureAlt(block({ sourceText: 'The pipeline runs in four stages.' }))).toBe('')
  })

  it('truncates a very long caption instead of carrying the whole paragraph', () => {
    const long = `Figure 1 ${'a'.repeat(400)}`
    expect(figureAlt(block({ sourceText: long }))).toHaveLength(180)
  })
})

describe('figureArtMap', () => {
  it('indexes the art it is given and tolerates nothing', () => {
    expect(figureArtMap(undefined).size).toBe(0)
    expect(figureArtMap([]).size).toBe(0)
    const map = figureArtMap([
      { key: 'a#0', bytes: new Uint8Array([1]), dataUrl: 'data:image/png;base64,AQ==' },
    ])
    expect(map.get('a#0')?.bytes).toEqual(new Uint8Array([1]))
  })
})

describe('loadFigureArt', () => {
  it('turns a crop into bytes and a data URI', async () => {
    const art = await loadFigureArt([{ key: 'b1#0', blob: new Blob([PNG_1x1]) }])
    expect(art).toHaveLength(1)
    expect(art[0].key).toBe('b1#0')
    expect(art[0].bytes.byteLength).toBe(PNG_1x1.byteLength)
    expect(art[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('drops an empty crop rather than embedding a zero-byte file', async () => {
    const art = await loadFigureArt([
      { key: 'b1#0', blob: new Blob([]) },
      { key: 'b2#0', blob: new Blob([PNG_1x1]) },
    ])
    expect(art.map((entry) => entry.key)).toEqual(['b2#0'])
  })
})
