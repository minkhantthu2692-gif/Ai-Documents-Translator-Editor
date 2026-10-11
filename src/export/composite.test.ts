/**
 * Raster layout adjustment (`ExportOptions.adjustLayout`).
 *
 * The composite module's other half — turning a page into pixels — needs an
 * `OffscreenCanvas`, so what is pinned down here is the decision it makes
 * before it paints: which blocks are handed to `drawBlock`, and where they sit.
 * The measurer is injected, so the whole pass runs without a DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextMeasurer } from '@/editor/autofit'
import { compositePage, layoutBlocks, workerMeasurer } from './composite'
import type { ExportBlock, ExportPage } from './types'

/** ~0.5 em average advance — deterministic, no canvas needed. */
const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize * 0.5

/** `n` space-separated words: `wrapLines` cannot break a single long token. */
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

function block(overrides: Partial<ExportBlock> = {}): ExportBlock {
  return {
    id: 'blk_1',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 72,
    y: 72,
    width: 468,
    height: 14,
    fontFamily: 'Noto Sans',
    fontSize: 11,
    lineHeight: 1.7,
    color: '#111827',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    links: [],
    figures: [],
    tableCells: null,
    tableSpans: null,
    sourceText: 'Source line',
    translatedText: 'မြန်မာစာ',
    characterCount: 11,
    skipRule: null,
    placeholders: [],
    direction: 'ltr',
    fittedFontSize: null,
    overflow: false,
    hasSuggestion: false,
    ...overrides,
  }
}

function page(blocks: ExportBlock[], height = 792): ExportPage {
  return { index: 0, width: 612, height, rotation: 0, contentClass: 'text', blocks }
}

const OPTIONS = { scale: 2, fontStack: '' }

describe('raster layout adjustment', () => {
  it('is off unless the reader asked for it, and then nothing moves', () => {
    // Forty words are two lines even at the 6pt floor — the paint would put
    // them over the block below, but the sheet's promise is source geometry.
    const blocks = [
      block({ id: 'a', translatedText: words(40) }),
      block({ id: 'b', y: 86, order: 1 }),
    ]
    const out = layoutBlocks(page(blocks), OPTIONS, measure)
    expect(out.map((entry) => entry.y)).toEqual([72, 86])
    // The very same objects: no copy is made when there is no pass to run.
    expect(out[0]).toBe(blocks[0])
    expect(out[1]).toBe(blocks[1])
  })

  it('never reports a block when it did not reflow', () => {
    const clipped: string[] = []
    layoutBlocks(
      page([block({ id: 'a', translatedText: words(40) }), block({ id: 'b', y: 86, order: 1 })]),
      { ...OPTIONS, onOverlap: (id) => clipped.push(id) },
      measure,
    )
    expect(clipped).toEqual([])
  })

  it('pushes the block below when the translation will not fit even shrunk', () => {
    // Auto-fit takes `a` down to the 6pt floor and it still needs two lines
    // (20.4pt) in a 14pt box, so `b` is moved by exactly that surplus.
    const out = layoutBlocks(
      page([block({ id: 'a', translatedText: words(40) }), block({ id: 'b', y: 86, order: 1 })]),
      { ...OPTIONS, adjustLayout: true },
      measure,
    )
    expect(out[0].y).toBe(72)
    expect(out[1].y).toBeCloseTo(92.4, 5)
    // Shrunk to the floor, which is what made it two lines rather than three.
    expect(out[0].fontSize).toBe(6)
  })

  it('spends no push on a translation that fits once it has shrunk', () => {
    // Twenty words fit at ~8pt, inside the 14pt box: `b` keeps the y the PDF
    // gave it, and `a` keeps its own y too — a page whose text merely got
    // smaller is byte-identical.
    const out = layoutBlocks(
      page([block({ id: 'a', translatedText: words(20) }), block({ id: 'b', y: 86, order: 1 })]),
      { ...OPTIONS, adjustLayout: true },
      measure,
    )
    expect(out[0].y).toBe(72)
    expect(out[0].fontSize).toBeLessThan(11)
    expect(out[1].y).toBe(86)
  })

  it('names the blocks the page edge stopped it from clearing', () => {
    // `a` grows at the foot of the page; the push lands `b` past 792pt, so `b`
    // is parked at its own y — still under `a`. Worth a name, because the
    // reader is looking at an overlap and silence would be the wrong default.
    const clipped: string[] = []
    layoutBlocks(
      page([
        block({ id: 'a', y: 750, translatedText: words(40) }),
        block({ id: 'b', y: 765, order: 1, height: 60 }),
      ]),
      { ...OPTIONS, adjustLayout: true, onOverlap: (id) => clipped.push(id) },
      measure,
    )
    expect(clipped).toEqual(['b'])
  })

  it('reports nothing when every block clears', () => {
    const clipped: string[] = []
    layoutBlocks(
      page([block({ id: 'a', translatedText: words(40) }), block({ id: 'b', y: 95, order: 1 })]),
      { ...OPTIONS, adjustLayout: true, onOverlap: (id) => clipped.push(id) },
      measure,
    )
    expect(clipped).toEqual([])
  })

  it('keeps the list marker in the room a block is given', () => {
    // Narrow column: at the 6pt floor the unmarked text is three lines, and
    // the two characters the marker adds push it to four — so the block below
    // has to make room for the marker too, not just the words.
    const below = block({ id: 'b', y: 86, order: 1 })
    const plain = layoutBlocks(
      page([block({ id: 'a', width: 150, translatedText: words(30) }), below]),
      { ...OPTIONS, adjustLayout: true },
      measure,
    )
    const marked = layoutBlocks(
      page([block({ id: 'a', width: 150, translatedText: words(30), listMarker: '•' }), below]),
      { ...OPTIONS, adjustLayout: true },
      measure,
    )
    expect(plain[1].y).toBeCloseTo(102.6, 5)
    expect(marked[1].y).toBeCloseTo(112.8, 5)
  })

  it('falls back to source geometry when the measuring pass cannot finish', () => {
    // Reflow is an option, not the export: a measurer that throws leaves the
    // page where the PDF put it instead of taking the sheet down with it.
    const clipped: string[] = []
    const out = layoutBlocks(
      page([block({ id: 'a', translatedText: words(40) }), block({ id: 'b', y: 86, order: 1 })]),
      { ...OPTIONS, adjustLayout: true, onOverlap: (id) => clipped.push(id) },
      () => {
        throw new Error('no canvas')
      },
    )
    expect(out.map((entry) => entry.y)).toEqual([72, 86])
    expect(clipped).toEqual([])
  })

  it('skips blocks with no text at all', () => {
    const blank = block({ id: 'blank', translatedText: '   ', sourceText: '   ' })
    const out = layoutBlocks(page([blank]), { ...OPTIONS, adjustLayout: true }, measure)
    expect(out).toEqual([])
  })
})

/**
 * The paint half. jsdom has no `OffscreenCanvas`, so the canvas is a fake
 * that records what the paint asked for: every `fillText`, the sheet fill,
 * the background blit and the blob options. What is pinned is the *paint
 * orchestration* — anchoring, direction, the marker on the first line, one
 * unrenderable block not failing the page — not rasterisation itself, which
 * no unit test can honestly claim.
 */
interface PaintCall {
  op: 'fillRect' | 'fillText' | 'drawImage'
  args: unknown[]
}

let painted: PaintCall[] = []
let canvases: FakeCanvas[] = []

class FakeContext {
  fillStyle = ''
  font = ''
  direction: CanvasDirection = 'ltr'
  textAlign: CanvasTextAlign = 'left'
  textBaseline: CanvasTextBaseline = 'alphabetic'

  fillRect(...args: number[]): void {
    painted.push({ op: 'fillRect', args })
  }

  fillText(text: string, x: number, y: number): void {
    painted.push({ op: 'fillText', args: [text, x, y] })
  }

  drawImage(...args: unknown[]): void {
    painted.push({ op: 'drawImage', args })
  }

  /** ~7.5pt an advance whatever the font: wide enough never to wrap here. */
  measureText(text: string): { width: number } {
    if (text.includes('💥')) throw new Error('MEASURE_FAILED')
    return { width: text.length * 10 }
  }
}

class FakeCanvas {
  readonly context = new FakeContext()
  readonly convertToBlob = vi.fn(
    async (options?: { type?: string; quality?: number }) =>
      new Blob(['pixels'], { type: options?.type ?? 'image/png' }),
  )

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    canvases.push(this)
  }

  getContext(): FakeContext {
    return this.context
  }
}

/** Replaces the globals and forgets the previous run's recordings. */
function stubCanvasGlobals(): void {
  painted = []
  canvases = []
  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ close: () => {} })),
  )
}

describe('compositePage', () => {
  beforeEach(stubCanvasGlobals)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The context of the page canvas — the measurer's 1×1 canvas comes later. */
  const pageContext = (): FakeContext => canvases[0].context
  const linesPainted = (): PaintCall[] => painted.filter((call) => call.op === 'fillText')

  it('fills a white sheet, blits the background and paints one line per wrapped line', async () => {
    const blob = await compositePage(
      page([block({ translatedText: 'Hello world', width: 468 })]),
      new Blob(['artwork']),
      { scale: 1, fontStack: '' },
    )
    expect(blob.type).toBe('image/png')
    expect(painted[0]).toEqual({ op: 'fillRect', args: [0, 0, 612, 792] })
    expect(painted.some((call) => call.op === 'drawImage')).toBe(true)
    // One short line, anchored at the block's own origin, scaled by `scale`.
    expect(linesPainted()).toEqual([{ op: 'fillText', args: ['Hello world', 72, 72] }])
  })

  it('anchors right-aligned text to the block edge and carries direction and size', async () => {
    await compositePage(
      page([
        block({
          translatedText: 'שלום עולם',
          x: 100,
          y: 200,
          width: 300,
          // Tall enough for one 1.7-leading line at 12pt, so auto-fit leaves
          // the size alone and the font string below is the block's own.
          height: 24,
          fontSize: 12,
          alignment: 'right',
          direction: 'rtl',
        }),
      ]),
      null,
      { scale: 1, fontStack: '' },
    )
    const ctx = pageContext()
    expect(ctx.textAlign).toBe('right')
    expect(ctx.direction).toBe('rtl')
    expect(ctx.font).toContain('12px')
    expect(linesPainted()[0].args).toEqual(['שלום עולם', 400, 200])
  })

  it('paints the list marker on the first line only', async () => {
    await compositePage(page([block({ translatedText: 'Item one', listMarker: '•' })]), null, {
      scale: 1,
      fontStack: '',
    })
    expect(linesPainted()[0].args[0]).toBe('• Item one')
  })

  it('passes the jpeg type and quality through to the blob', async () => {
    const blob = await compositePage(page([block({ translatedText: 'Hello' })]), null, {
      scale: 1,
      fontStack: '',
      type: 'image/jpeg',
      quality: 0.5,
    })
    expect(blob.type).toBe('image/jpeg')
    expect(canvases[0].convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.5 })
  })

  it('keeps the white sheet when the background will not decode', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('BAD_BITMAP')
      }),
    )
    const blob = await compositePage(
      page([block({ translatedText: 'Still here' })]),
      new Blob(['broken']),
      { scale: 1, fontStack: '' },
    )
    expect(blob.type).toBe('image/png')
    expect(painted.some((call) => call.op === 'drawImage')).toBe(false)
    expect(linesPainted()).toHaveLength(1)
  })

  it('paints the other blocks when one of them cannot be measured', async () => {
    const blob = await compositePage(
      page([
        block({ id: 'good', order: 0, translatedText: 'Fine line' }),
        block({ id: 'poison', order: 1, y: 100, translatedText: '💥 boom' }),
      ]),
      null,
      { scale: 1, fontStack: '' },
    )
    expect(blob.type).toBe('image/png')
    expect(linesPainted()).toEqual([{ op: 'fillText', args: ['Fine line', 72, 72] }])
  })
})

describe('workerMeasurer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to estimating when the environment has no canvas, and says so', () => {
    // jsdom: `OffscreenCanvas` does not exist, which is exactly the fallback
    // path a worker without canvas access would take.
    const onFallback = vi.fn()
    const measure = workerMeasurer(onFallback)
    const width = measure({
      text: 'hello',
      fontFamily: 'Helvetica',
      fontSize: 10,
      bold: false,
      italic: false,
    })
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(width).toBe(5 * 10 * 0.52)
  })

  it('measures through the canvas when one exists', () => {
    stubCanvasGlobals()
    const onFallback = vi.fn()
    const measure = workerMeasurer(onFallback)
    const width = measure({
      text: 'hello',
      fontFamily: 'Helvetica',
      fontSize: 10,
      bold: false,
      italic: false,
    })
    expect(onFallback).not.toHaveBeenCalled()
    // The fake canvas answers ~10px an advance; the measurer reports points.
    expect(width).toBeCloseTo((5 * 10 * 72) / 96, 5)
  })
})
