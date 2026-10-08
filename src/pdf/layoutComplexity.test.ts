import { describe, expect, it } from 'vitest'
import { lineId, type BBox } from './stableId'
import type { GroupedLine, LineStyle, TextItemLike } from './lineGrouping'
import {
  COMPLEX_THRESHOLD,
  MAX_COLUMNS,
  OVERLAP_MIN_RATIO,
  analyzeLayout,
  countItemColumns,
  itemBoxesOf,
  overlapRatioOf,
  scoreLayout,
  type ItemBox,
} from './layoutComplexity'

const BASE_STYLE: LineStyle = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  color: '#000000',
  rotation: 0,
}

function line(text: string, bbox: BBox, style: Partial<LineStyle> = {}): GroupedLine {
  return {
    id: lineId(0, bbox, text),
    text,
    bbox,
    style: { ...BASE_STYLE, ...style },
    itemIndexes: [],
  }
}

/** Ten lines per column at the given x offsets — enough for column detection. */
function columnLines(...xs: number[]): GroupedLine[] {
  return xs.flatMap((x, columnIndex) =>
    Array.from({ length: 10 }, (_, row) =>
      line(`Column ${columnIndex + 1} line ${row + 1} of body text.`, {
        x,
        y: 500 + row * 16,
        w: 150,
        h: 14,
      }),
    ),
  )
}

describe('scoreLayout', () => {
  const plain = {
    columns: 1,
    overlapRatio: 0,
    rotatedLineRatio: 0,
    pageRotation: 0,
    tableRowCount: 0,
    sizeRatio: 1.2,
    imageCount: 1,
  }

  it('scores a single-column page as simple', () => {
    const result = scoreLayout(plain)
    expect(result.complex).toBe(false)
    expect(result.score).toBe(0)
    expect(result.reasons).toEqual([])
  })

  it('flags three or more columns as complex on their own', () => {
    const result = scoreLayout({ ...plain, columns: 3 })
    expect(result.complex).toBe(true)
    expect(result.reasons).toEqual(['columns3'])
  })

  it('treats a plain two-column page as simple (academic papers)', () => {
    const result = scoreLayout({ ...plain, columns: 2 })
    expect(result.complex).toBe(false)
    expect(result.reasons).toEqual(['multicolumn'])
  })

  it('flags overlapping text boxes as complex on their own', () => {
    const result = scoreLayout({ ...plain, overlapRatio: OVERLAP_MIN_RATIO })
    expect(result.complex).toBe(true)
    expect(result.reasons).toEqual(['overlap'])
  })

  it('needs a meaningful share of overlapping lines, not one pair', () => {
    expect(scoreLayout({ ...plain, overlapRatio: 0.05 }).complex).toBe(false)
  })

  it('scores a page-level rotation mildly, angled text strongly', () => {
    expect(scoreLayout({ ...plain, pageRotation: 90 })).toEqual({
      score: 0.1,
      reasons: ['rotation'],
      complex: false,
    })
    expect(scoreLayout({ ...plain, rotatedLineRatio: 0.3 })).toEqual({
      score: 0.3,
      reasons: ['rotation'],
      complex: false,
    })
  })

  it('keeps image- and table-heavy pages simple unless combined', () => {
    expect(scoreLayout({ ...plain, imageCount: 6 }).complex).toBe(false)
    expect(scoreLayout({ ...plain, tableRowCount: 8 }).complex).toBe(false)
    // Slide-like pages: huge headings plus a table plus figures.
    const slide = scoreLayout({
      ...plain,
      sizeRatio: 4,
      tableRowCount: 5,
      imageCount: 5,
    })
    expect(slide.reasons).toEqual(['size-spread', 'tables', 'images'])
    expect(slide.complex).toBe(false)
    // …but the same page split into two side-by-side text boxes is.
    expect(
      scoreLayout({ ...plain, columns: 2, sizeRatio: 4, tableRowCount: 5, imageCount: 5 }).score,
    ).toBeGreaterThanOrEqual(COMPLEX_THRESHOLD)
  })

  it('never exceeds a score of 1', () => {
    const everything = scoreLayout({
      columns: MAX_COLUMNS,
      overlapRatio: 1,
      rotatedLineRatio: 1,
      pageRotation: 270,
      tableRowCount: 40,
      sizeRatio: 10,
      imageCount: 30,
    })
    expect(everything.score).toBe(1)
    expect(everything.complex).toBe(true)
    expect(everything.reasons).toEqual([
      'columns3',
      'overlap',
      'rotation',
      'size-spread',
      'tables',
      'images',
    ])
  })
})

describe('overlapRatioOf', () => {
  it('is 0 for normal paragraph flow', () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      line(`Line ${i}`, { x: 72, y: 100 + i * 16, w: 300, h: 14 }),
    )
    expect(overlapRatioOf(lines)).toBe(0)
  })

  it('reports stacked boxes and shrinks with fewer involved lines', () => {
    const lines = [
      line('Base paragraph', { x: 72, y: 100, w: 300, h: 14 }),
      line('On top of it', { x: 72, y: 102, w: 300, h: 14 }),
      line('Elsewhere', { x: 72, y: 300, w: 300, h: 14 }),
      line('Also elsewhere', { x: 72, y: 316, w: 300, h: 14 }),
    ]
    expect(overlapRatioOf(lines)).toBeCloseTo(0.5, 5)
  })

  it('ignores a sliver intersection below the pair share', () => {
    const lines = [
      line('Top', { x: 0, y: 0, w: 100, h: 20 }),
      // Overlaps by 1pt in y: 100 / 1000 = 10% of the smaller box.
      line('Below', { x: 0, y: 19, w: 100, h: 20 }),
    ]
    expect(overlapRatioOf(lines)).toBe(0)
  })

  it('handles empty and degenerate input', () => {
    expect(overlapRatioOf([])).toBe(0)
    expect(overlapRatioOf([line('One', { x: 0, y: 0, w: 10, h: 10 })])).toBe(0)
    expect(
      overlapRatioOf([
        line('Zero area', { x: 0, y: 0, w: 0, h: 0 }),
        line('Zero area 2', { x: 0, y: 0, w: 0, h: 0 }),
      ]),
    ).toBe(0)
  })
})

describe('analyzeLayout', () => {
  const ctx = { pageWidth: 612, pageRotation: 0, imageCount: 0 }

  it('scores a one-column body as simple', () => {
    const result = analyzeLayout(columnLines(72), ctx)
    expect(result.complex).toBe(false)
    expect(result.reasons).not.toContain('columns3')
  })

  it('detects two columns without calling the page complex', () => {
    const result = analyzeLayout(columnLines(72, 330), ctx)
    expect(result.reasons).toContain('multicolumn')
    expect(result.complex).toBe(false)
  })

  it('detects three columns and flags the page complex', () => {
    const result = analyzeLayout(columnLines(40, 226, 412), ctx)
    expect(result.reasons).toContain('columns3')
    expect(result.complex).toBe(true)
  })

  it('flags a rotated watermark crossing the columns', () => {
    const lines = [...columnLines(72), line('DRAFT COPY', { x: 60, y: 520, w: 480, h: 40 })]
    const result = analyzeLayout(lines, ctx)
    expect(result.reasons).toContain('overlap')
    expect(result.complex).toBe(true)
  })

  it('counts angled lines as rotation', () => {
    const lines = [
      ...columnLines(72),
      line('Diagonal stamp', { x: 200, y: 400, w: 120, h: 16 }, { rotation: 30 }),
      line('Diagonal stamp 2', { x: 200, y: 420, w: 120, h: 16 }, { rotation: 30 }),
      line('Diagonal stamp 3', { x: 200, y: 440, w: 120, h: 16 }, { rotation: 30 }),
      line('Diagonal stamp 4', { x: 200, y: 460, w: 120, h: 16 }, { rotation: 30 }),
      line('Diagonal stamp 5', { x: 200, y: 480, w: 120, h: 16 }, { rotation: 30 }),
      line('Diagonal stamp 6', { x: 200, y: 500, w: 120, h: 16 }, { rotation: 30 }),
      line('Diagonal stamp 7', { x: 200, y: 520, w: 120, h: 16 }, { rotation: 30 }),
      line('Diagonal stamp 8', { x: 200, y: 540, w: 120, h: 16 }, { rotation: 30 }),
    ]
    const result = analyzeLayout(lines, ctx)
    expect(result.reasons).toContain('rotation')
  })

  it('measures size spread from huge headings over small body text', () => {
    const lines = [
      ...columnLines(72),
      line('HUGE HEADING', { x: 72, y: 420, w: 400, h: 48 }, { fontSize: 44, bold: true }),
    ]
    expect(analyzeLayout(lines, ctx).reasons).toContain('size-spread')
  })

  it('is simple for an empty page', () => {
    expect(analyzeLayout([], ctx).complex).toBe(false)
  })

  it('prefers item boxes over (merged) lines for column detection', () => {
    // The lines of a real multi-column page come out merged full-width;
    // item boxes still carry the gutters.
    const mergedLines = columnLines(40, 226, 412).map((line, i) => ({
      ...line,
      bbox: { x: 40, y: 500 + i * 16, w: 500, h: 14 },
    }))
    const itemBoxes: ItemBox[] = Array.from({ length: 10 }, () => ({ x: 40, w: 150 })).concat(
      Array.from({ length: 10 }, () => ({ x: 226, w: 150 })),
      Array.from({ length: 10 }, () => ({ x: 412, w: 150 })),
    )
    expect(analyzeLayout(mergedLines, { ...ctx, itemBoxes }).complex).toBe(true)
    expect(analyzeLayout(mergedLines, { ...ctx, itemBoxes: undefined }).complex).toBe(false)
  })
})

describe('countItemColumns', () => {
  /** Ten run boxes at each x offset (130pt wide → ≥15pt gutters). */
  const at = (...xs: number[]): ItemBox[] =>
    xs.flatMap((x) => Array.from({ length: 10 }, () => ({ x, w: 130 })))

  it('sees three columns even when a watermark bridges one gutter', () => {
    // Body: three columns of runs; plus one wide rotated watermark run
    // crossing the first gutter (the layout that broke line-based detection).
    const boxes = [...at(40, 226, 412), { x: 91, w: 213 }]
    expect(countItemColumns(boxes, 612)).toBe(3)
  })

  it('reports one column for a ragged single column of text', () => {
    const boxes = Array.from({ length: 10 }, (_, i) => ({ x: 72, w: 300 + (i % 4) * 40 }))
    expect(countItemColumns(boxes, 612)).toBe(1)
  })

  it('reports two columns when a sidebar sits apart from the body', () => {
    expect(countItemColumns(at(72, 480), 612)).toBe(2)
  })

  it('counts four columns and honours the cap', () => {
    const boxes = at(30, 175, 320, 465)
    expect(countItemColumns(boxes, 612)).toBe(4)
    expect(countItemColumns(boxes, 612, 2)).toBe(2)
    expect(countItemColumns(boxes, 612, 1)).toBe(1)
  })

  it('needs a real body of runs and a valid page width', () => {
    expect(countItemColumns(at(40, 226, 412).slice(0, 6), 612)).toBe(1)
    expect(countItemColumns([], 612)).toBe(1)
    expect(countItemColumns(at(40, 226, 412), 0)).toBe(1)
  })
})

describe('itemBoxesOf', () => {
  const item = (transform: number[], width: number, height = 12): TextItemLike => ({
    str: 'x',
    transform,
    width,
    height,
  })

  it('measures horizontal runs and skips degenerate transforms', () => {
    const boxes = itemBoxesOf([
      item([1, 0, 0, 1, 72, 700], 120),
      item([Number.NaN, 0, 0, 1, 0, 0], 10),
      item([1, 0, 0, 1, 300, 700], 0),
    ])
    expect(boxes).toEqual([{ x: 72, w: 120 }])
  })

  it('captures the x-extent of a 45°-rotated run', () => {
    const cos = Math.SQRT1_2
    const [box] = itemBoxesOf([item([cos, cos, -cos, cos, 100, 400], 100)])
    expect(box.x).toBeCloseTo(100 - 12 * cos, 5)
    expect(box.w).toBeCloseTo((100 + 12) * cos, 5)
  })
})
