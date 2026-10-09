import { describe, expect, it } from 'vitest'
import {
  MAX_HEADING_LEVEL,
  headingLevelFor,
  headingTiers,
  pageHeadingSizes,
  sizeLadder,
} from './headings'
import type { GroupedLine, LineStyle } from './lineGrouping'
import { lineId, type BBox } from './stableId'

const BODY: LineStyle = {
  fontFamily: 'Helvetica',
  fontSize: 11,
  bold: false,
  italic: false,
  color: '#000000',
  rotation: 0,
}

function line(text: string, y: number, size = 11, overrides: Partial<LineStyle> = {}): GroupedLine {
  const bbox: BBox = { x: 72, y, w: 300, h: size }
  return {
    id: lineId(0, bbox, text),
    text,
    bbox,
    style: { ...BODY, ...overrides, fontSize: size },
    itemIndexes: [],
  }
}

/** A page of body copy with one heading line of `size` sitting above it. */
function page(headingSize: number, headingText = 'Chapter One', bodyLines = 6): GroupedLine[] {
  const lines = [line(headingText, 640, headingSize, { bold: true })]
  for (let index = 0; index < bodyLines; index += 1) {
    lines.push(line(`Body sentence number ${index} of the paragraph.`, 600 - index * 16))
  }
  return lines
}

describe('pageHeadingSizes', () => {
  it('reports the sizes above the page median and ignores long lines', () => {
    const lines = [
      line(
        'A very large line of running body copy that fills the whole measure of the column and keeps going for a good long while before it wraps onto the next line.',
        600,
        24,
      ),
      line('Chapter One', 640, 24, { bold: true }),
      ...Array.from({ length: 8 }, (_, index) => line(`Body ${index}.`, 580 - index * 16)),
    ]
    // The long 24pt line is body text set large and must not be mistaken for a
    // title; the short one of the same size is one.
    expect(pageHeadingSizes(lines)).toEqual([24])
  })

  it('returns nothing for a page with no size contrast', () => {
    expect(pageHeadingSizes(page(11))).toEqual([])
    expect(pageHeadingSizes([])).toEqual([])
  })
})

describe('headingTiers', () => {
  it('collects sizes across pages, largest first', () => {
    expect(headingTiers([page(30), page(24), page(18)])).toEqual([30, 24, 18])
  })

  it('treats sizes that agree to within 5% as one level', () => {
    // A converter hands back 30.2 on one page and 30.0 on the next; spending a
    // level on the difference would push every real level below it down one.
    expect(headingTiers([page(30.2), page(30)])).toEqual([30.2])
  })

  it('never reports more rungs than a format can render', () => {
    const pages = [240, 220, 200, 180, 160, 140, 120, 100, 80].map((size) => page(size))
    const tiers = headingTiers(pages)
    expect(tiers).toHaveLength(MAX_HEADING_LEVEL)
    expect(tiers[0]).toBe(240)
  })

  it('is empty when no page has a heading', () => {
    expect(headingTiers([page(11), page(11)])).toEqual([])
    expect(headingTiers([])).toEqual([])
  })
})

describe('headingLevelFor', () => {
  it('picks the closest rung', () => {
    const tiers = [26, 18, 14]
    expect(headingLevelFor(26, tiers)).toBe(1)
    expect(headingLevelFor(18, tiers)).toBe(2)
    expect(headingLevelFor(14, tiers)).toBe(3)
    // Between two rungs, the nearer one wins.
    expect(headingLevelFor(19, tiers)).toBe(2)
    expect(headingLevelFor(15, tiers)).toBe(3)
    // Larger than anything the probe saw is still a top-level heading, not a
    // size the ladder has no room for.
    expect(headingLevelFor(48, tiers)).toBe(1)
  })

  it('keeps the shallower level on an exact tie', () => {
    expect(headingLevelFor(22, [26, 18])).toBe(1)
  })

  it('is level 1 when there is no ladder at all', () => {
    expect(headingLevelFor(12, [])).toBe(1)
  })
})

describe('sizeLadder', () => {
  it('collapses duplicates and sorts largest first', () => {
    expect(sizeLadder([14, 22, 14.04, 18, 0, Number.NaN])).toEqual([22, 18, 14])
  })
})
