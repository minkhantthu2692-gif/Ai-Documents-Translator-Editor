/**
 * Raster layout adjustment (`ExportOptions.adjustLayout`).
 *
 * The composite module's other half — turning a page into pixels — needs an
 * `OffscreenCanvas`, so what is pinned down here is the decision it makes
 * before it paints: which blocks are handed to `drawBlock`, and where they sit.
 * The measurer is injected, so the whole pass runs without a DOM.
 */

import { describe, expect, it } from 'vitest'
import type { TextMeasurer } from '@/editor/autofit'
import { layoutBlocks } from './composite'
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
