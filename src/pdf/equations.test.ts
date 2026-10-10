// @vitest-environment node
/**
 * Display-equation detection (types 7 and 23): scoring, the geometry that
 * hangs a fragment off its anchor (superscripts, subscripts, fraction parts),
 * the assembly back into one readable string, and the block the structure
 * pass makes of a run.
 *
 * Geometry is synthetic — the same bboxes a TeX- or Cambria-set page produces
 * (raised marks on their own baselines, fraction parts stacked) — because the
 * point of the module is exactly to re-derive that structure from bboxes.
 */
import { describe, expect, it } from 'vitest'
import {
  attachKind,
  equationScore,
  equationText,
  floatingMark,
  markEquationRegions,
} from './equations'
import { structurePage, type StructureOptions } from './structure'
import type { GroupedLine, LineStyle } from './lineGrouping'
import { lineId, type BBox } from './stableId'

const BASE_STYLE: LineStyle = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  color: '#000000',
  rotation: 0,
}
const MATH_STYLE: Partial<LineStyle> = { fontFamily: 'ABCDEF+CMMI1' }

function line(text: string, bbox: BBox, style: Partial<LineStyle> = {}): GroupedLine {
  return {
    id: lineId(0, bbox, text),
    text,
    bbox,
    style: { ...BASE_STYLE, ...style },
    itemIndexes: [],
  }
}

function options(extra: Partial<StructureOptions> = {}): StructureOptions {
  return {
    pageIndex: 0,
    ctx: { sourceLang: 'en', targetLang: 'my' },
    pageWidth: 612,
    pageHeight: 792,
    ...extra,
  }
}

describe('equationScore', () => {
  it('calls a mathematical face maths whatever it reads', () => {
    expect(
      equationScore(line('x', { x: 72, y: 100, w: 10, h: 12 }, MATH_STYLE)),
    ).toBeGreaterThanOrEqual(2)
  })

  it('calls a glyph formula maths in the body face', () => {
    // x², y², z² are superscript glyphs in one line: ² votes twice, `+`/`=` twice over.
    expect(
      equationScore(line('x² + y² = z²', { x: 72, y: 100, w: 90, h: 12 })),
    ).toBeGreaterThanOrEqual(2)
    expect(equationScore(line('E = mc^2', { x: 72, y: 100, w: 60, h: 12 }))).toBeGreaterThanOrEqual(
      2,
    )
    expect(
      equationScore(line('x_1 + x_2 = x̄', { x: 72, y: 100, w: 90, h: 12 })),
    ).toBeGreaterThanOrEqual(2)
  })

  it('keeps prose prose', () => {
    expect(equationScore(line('Thus we obtain the result', { x: 72, y: 100, w: 150, h: 12 }))).toBe(
      0,
    )
    expect(equationScore(line('the α particle decay', { x: 72, y: 100, w: 120, h: 12 }))).toBe(0)
    expect(equationScore(line('If x = 1 then', { x: 72, y: 100, w: 80, h: 12 }))).toBe(0)
  })

  it('does not mistake an identifier line for a formula', () => {
    expect(equationScore(line('price_var = 100', { x: 72, y: 100, w: 90, h: 12 }))).toBeLessThan(2)
  })

  it('ignores the empty and the endless', () => {
    expect(equationScore(line('', { x: 72, y: 100, w: 0, h: 12 }))).toBe(0)
    expect(equationScore(line('x '.repeat(80), { x: 72, y: 100, w: 900, h: 12 }))).toBe(0)
  })
})

describe('attachKind', () => {
  const x = line('x', { x: 72, y: 100, w: 10, h: 12 }, MATH_STYLE)

  it('reads a raised, right-starting, smaller mark as a superscript', () => {
    expect(attachKind(x, line('2', { x: 82, y: 96, w: 6, h: 8 }, MATH_STYLE), 12)).toBe('sup')
  })

  it('reads a same-point-size raised mark too — the raise is the signal', () => {
    expect(attachKind(x, line('2', { x: 82, y: 96, w: 6, h: 12 }, MATH_STYLE), 12)).toBe('sup')
  })

  it('reads a dropped mark as a subscript', () => {
    expect(attachKind(x, line('1', { x: 82, y: 113, w: 5, h: 8 }, MATH_STYLE), 12)).toBe('sub')
  })

  it('reads a centred part below as a stack — a fraction, not a mark', () => {
    const numerator = line('∑(x−μ)', { x: 72, y: 190, w: 50, h: 14 }, MATH_STYLE)
    const denominator = line('n', { x: 93, y: 206, w: 8, h: 12 }, MATH_STYLE)
    expect(attachKind(numerator, denominator, 12)).toBe('stack')
  })

  it('stops at a line that is far away or growing', () => {
    const far = line('where x > 0', { x: 72, y: 260, w: 80, h: 12 })
    const growing = line('+ and y too', { x: 82, y: 90, w: 60, h: 20 })
    expect(attachKind(x, far, 12)).toBeNull()
    expect(attachKind(x, growing, 12)).toBeNull()
  })
})

describe('floatingMark', () => {
  it('reads a mark that arrived before its line', () => {
    const raised = line('2', { x: 82, y: 96, w: 6, h: 8 }, MATH_STYLE)
    const x = line('x', { x: 72, y: 100, w: 10, h: 12 }, MATH_STYLE)
    expect(floatingMark(raised, x, 12)).toBe('sup')
  })

  it('leaves a centred numerator a stack', () => {
    const numerator = line('12', { x: 92, y: 190, w: 12, h: 14 }, MATH_STYLE)
    const denominator = line('n', { x: 95, y: 206, w: 8, h: 12 }, MATH_STYLE)
    expect(floatingMark(numerator, denominator, 12)).toBeNull()
  })

  it('ignores a line number beside the line it is not part of', () => {
    const number = line('(4)', { x: 300, y: 100, w: 20, h: 12 })
    const text = line('the expansion', { x: 72, y: 104, w: 90, h: 12 })
    expect(floatingMark(number, text, 12)).toBeNull()
  })
})

describe('equationText', () => {
  it('folds a superscript onto its line', () => {
    const x = line('x', { x: 72, y: 100, w: 10, h: 12 }, MATH_STYLE)
    const two = line('2', { x: 82, y: 96, w: 6, h: 8 }, MATH_STYLE)
    expect(equationText([x, two], 12)).toBe('x^2')
  })

  it('braces a multi-character mark', () => {
    const x = line('x', { x: 72, y: 100, w: 10, h: 12 }, MATH_STYLE)
    const twelve = line('12', { x: 82, y: 96, w: 12, h: 8 }, MATH_STYLE)
    expect(equationText([x, twelve], 12)).toBe('x^{12}')
  })

  it('folds a subscript the same way', () => {
    const x = line('x', { x: 72, y: 100, w: 10, h: 12 }, MATH_STYLE)
    const one = line('1', { x: 82, y: 113, w: 5, h: 8 }, MATH_STYLE)
    expect(equationText([x, one], 12)).toBe('x_1')
  })

  it('re-files a mark that read first', () => {
    const raised = line('2', { x: 112, y: 190, w: 6, h: 10 }, MATH_STYLE)
    const base = line('E = mc', { x: 72, y: 196, w: 40, h: 12 }, MATH_STYLE)
    expect(equationText([raised, base], 12)).toBe('E = mc^2')
  })

  it('keeps a fraction in reading order, part over part', () => {
    const numerator = line('∑(x−μ)', { x: 72, y: 190, w: 50, h: 14 }, MATH_STYLE)
    const denominator = line('n', { x: 93, y: 206, w: 8, h: 12 }, MATH_STYLE)
    expect(equationText([numerator, denominator], 12)).toBe('∑(x−μ)\nn')
  })
})

describe('markEquationRegions', () => {
  it('marks the anchor and its fragments, and nothing around them', () => {
    const prose1 = line('The mass–energy relation is famous.', { x: 72, y: 100, w: 250, h: 12 })
    const raised = line('2', { x: 112, y: 190, w: 6, h: 10 }, MATH_STYLE)
    const base = line('E = mc', { x: 72, y: 196, w: 40, h: 12 }, MATH_STYLE)
    const prose2 = line('and follows from relativity.', { x: 72, y: 280, w: 200, h: 12 })
    const ids = markEquationRegions([prose1, raised, base, prose2], { medianSize: 12 })
    expect(ids.has(prose1.id)).toBe(false)
    expect(ids.has(raised.id)).toBe(true)
    expect(ids.has(base.id)).toBe(true)
    expect(ids.has(prose2.id)).toBe(false)
  })

  it('absorbs a fraction part, but not the prose under a tight leading', () => {
    const numerator = line('∑(x−μ)', { x: 72, y: 190, w: 50, h: 14 }, MATH_STYLE)
    const denominator = line('n', { x: 93, y: 206, w: 8, h: 12 }, MATH_STYLE)
    const prose = line('where the mean stays fixed.', { x: 72, y: 222, w: 170, h: 12 })
    const ids = markEquationRegions([numerator, denominator, prose], { medianSize: 12 })
    expect(ids.has(numerator.id)).toBe(true)
    expect(ids.has(denominator.id)).toBe(true)
    // Tight leading puts the prose within stack distance — the content guard
    // is what keeps it prose.
    expect(prose.bbox.y - (denominator.bbox.y + denominator.bbox.h)).toBeLessThanOrEqual(9.6)
    expect(ids.has(prose.id)).toBe(false)
  })
})

describe('structurePage with equations', () => {
  it('makes one verbatim, skipped block of the run — and prose around it stays prose', () => {
    const prose1 = line('The mass–energy relation is famous.', { x: 72, y: 100, w: 250, h: 12 })
    const raised = line('2', { x: 112, y: 190, w: 6, h: 10 }, MATH_STYLE)
    const base = line('E = mc', { x: 72, y: 196, w: 40, h: 12 }, MATH_STYLE)
    const prose2 = line('and follows from relativity.', { x: 72, y: 280, w: 200, h: 12 })
    const blocks = structurePage([prose1, raised, base, prose2], options())
    expect(blocks).toHaveLength(3)
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'equation', 'paragraph'])
    const equation = blocks[1]
    expect(equation.text).toBe('E = mc^2')
    // Never handed to the model: the source stands as its own translation.
    expect(equation.skipRule).toBe('formula')
    expect(blocks[0].text).toBe('The mass–energy relation is famous.')
    expect(blocks[2].text).toBe('and follows from relativity.')
  })

  it('splits two formulas separated by a wide gap into two blocks', () => {
    const first = line('a + b', { x: 72, y: 100, w: 40, h: 12 }, MATH_STYLE)
    const second = line('c = d', { x: 72, y: 160, w: 40, h: 12 }, MATH_STYLE)
    const blocks = structurePage([first, second], options())
    expect(blocks.map((block) => block.kind)).toEqual(['equation', 'equation'])
    expect(blocks[0].text).toBe('a + b')
    expect(blocks[1].text).toBe('c = d')
  })

  it('keeps an equation out of the table and code readings', () => {
    // Three aligned `x = 1`-ish rows would read as a table; the math face
    // claims them first.
    const rows = ['a = 1', 'b = 2', 'c = 3'].map((text, index) =>
      line(text, { x: 72, y: 100 + index * 14, w: 40, h: 12 }, MATH_STYLE),
    )
    const blocks = structurePage(rows, options())
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('equation')
    expect(blocks[0].text).toBe('a = 1\nb = 2\nc = 3')
  })
})
