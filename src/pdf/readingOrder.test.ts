/**
 * Reading order acceptance tests.
 *
 * Each case here corresponds to a document that used to come out wrong: a
 * three-column page read as alternating left/right slivers, and — the more
 * damaging one — a two-column page with any full-width title on it, where a
 * single line bridging the gutter used to disable column detection for the
 * whole page and leave every line interleaved with its neighbour across the
 * fold.
 *
 * The invariant that matters most is the last test: whatever happens, every
 * input line comes back exactly once. These lines become blocks, blocks become
 * translations, and a dropped line is silent lost content.
 */
import { describe, expect, it } from 'vitest'
import { findBand, orderBodyLines, splitMergedLines } from './readingOrder'
import type { GroupedLine, LineStyle } from './lineGrouping'
import { lineId, type BBox } from './stableId'

const PAGE_WIDTH = 612
const BASE_STYLE: LineStyle = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  color: '#000000',
  rotation: 0,
}

function line(text: string, bbox: BBox): GroupedLine {
  return { id: lineId(0, bbox, text), text, bbox, style: { ...BASE_STYLE }, itemIndexes: [] }
}

/** A column of `count` lines starting at `startY`: `prefix0` is the top one. */
function columnAt(
  prefix: string,
  x: number,
  count: number,
  width: number,
  startY: number,
): GroupedLine[] {
  return Array.from({ length: count }, (_unused, index) =>
    line(`${prefix}${index}`, { x, y: startY + index * 20, w: width, h: 14 }),
  )
}

/** A column of `count` lines starting at the page top: `prefix0` is first. */
function column(prefix: string, x: number, count: number, width = 160): GroupedLine[] {
  return columnAt(prefix, x, count, width, 100)
}

/** Wide line crossing the gutter — a title, rule or full-width paragraph. */
function spanner(text: string, y: number): GroupedLine {
  return line(text, { x: 72, y, w: 468, h: 20 })
}

function texts(lines: GroupedLine[]): string[] {
  return lines.map((entry) => entry.text)
}

function preservedEveryLine(input: GroupedLine[], output: GroupedLine[]): void {
  const before = input.map((entry) => entry.id).sort()
  const after = output.map((entry) => entry.id).sort()
  expect(after).toEqual(before)
}

describe('orderBodyLines', () => {
  it('reads a three-column page column by column, not row by row', () => {
    // Columns at x = 40 / 226 / 412, each 160pt wide: two clear 26pt gutters.
    const lines = [...column('A', 40, 6), ...column('B', 226, 6), ...column('C', 412, 6)]

    const ordered = orderBodyLines(lines, PAGE_WIDTH)

    expect(texts(ordered)).toEqual([
      ...Array.from({ length: 6 }, (_u, i) => `A${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `B${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `C${i}`),
    ])
  })

  it('puts a title spanning the gutter ahead of both columns', () => {
    // The regression: one full-width title used to make the band edge leap to
    // the right margin, so no gutter was found and the page read row by row.
    const lines = [
      spanner('Chapter Four', 40),
      ...column('A', 72, 5, 220),
      ...column('B', 320, 5, 220),
    ]

    const ordered = orderBodyLines(lines, PAGE_WIDTH)

    expect(texts(ordered)).toEqual([
      'Chapter Four',
      ...Array.from({ length: 5 }, (_u, i) => `A${i}`),
      ...Array.from({ length: 5 }, (_u, i) => `B${i}`),
    ])
  })

  it('cuts a new zone at a spanning line part-way down the page', () => {
    const below = (prefix: string, x: number): GroupedLine[] =>
      Array.from({ length: 4 }, (_unused, index) =>
        line(`${prefix}${index + 6}`, { x, y: 300 + index * 20, w: 220, h: 14 }),
      )
    const lines = [
      ...column('A', 72, 6, 220), // y 100–200
      ...column('B', 320, 6, 220), // y 100–200
      spanner('Part Two: Results', 260),
      ...below('A', 72), // y 300–360
      ...below('B', 320), // y 300–360
    ]

    const ordered = orderBodyLines(lines, PAGE_WIDTH)

    expect(texts(ordered)).toEqual([
      ...Array.from({ length: 6 }, (_u, i) => `A${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `B${i}`),
      'Part Two: Results',
      'A6',
      'A7',
      'A8',
      'A9',
      'B6',
      'B7',
      'B8',
      'B9',
    ])
  })

  it('keeps the columns whole when a line bridges only one gutter', () => {
    // A rotated watermark lying across the left fold. Its centre falls inside
    // the left cluster, so `findBand` calls it an ordinary member of that side
    // — and ordering the cluster by y then drops it between column two and
    // column three, splitting the body of the page in half.
    const watermark = line('DRAFT COPY', { x: 40, y: 400, w: 330, h: 60 })
    const lines = [...column('A', 40, 6), ...column('B', 226, 6), ...column('C', 412, 6), watermark]

    const ordered = orderBodyLines(lines, PAGE_WIDTH)

    expect(texts(ordered)).toEqual([
      ...Array.from({ length: 6 }, (_u, i) => `A${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `B${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `C${i}`),
      'DRAFT COPY',
    ])
  })

  it('cuts a zone inside a sub-group instead of falling back to row-by-row', () => {
    // Three full-width lines defeat the page-level sweep — too many crossings
    // for one band — so they are never named as page boundaries. They are only
    // seen by the split *inside* the left+middle sub-group, and giving up there
    // (which is what this used to do) interleaved columns two and three.
    const heads = Array.from({ length: 3 }, (_unused, index) =>
      line(`Head${index}`, { x: 40, y: 80 + index * 5, w: 330, h: 14 }),
    )
    const lines = [...heads, ...column('A', 40, 6), ...column('B', 226, 6), ...column('C', 412, 6)]

    const ordered = orderBodyLines(lines, PAGE_WIDTH)

    expect(texts(ordered)).toEqual([
      ...heads.map((entry) => entry.text),
      ...Array.from({ length: 6 }, (_u, i) => `A${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `B${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `C${i}`),
    ])
  })

  it('reads a single column top to bottom', () => {
    const lines = Array.from({ length: 10 }, (_u, index) =>
      line(`L${index}`, { x: 72, y: 100 + index * 20, w: 400, h: 14 }),
    )

    expect(texts(orderBodyLines(lines, PAGE_WIDTH))).toEqual(
      Array.from({ length: 10 }, (_u, i) => `L${i}`),
    )
  })

  it('keeps four columns in newspaper order', () => {
    const lines = [
      ...column('A', 30, 6, 120),
      ...column('B', 170, 6, 120),
      ...column('C', 310, 6, 120),
      ...column('D', 450, 6, 120),
    ]

    expect(
      orderBodyLines(lines, PAGE_WIDTH)
        .slice(0, 6)
        .map((e) => e.text[0]),
    ).toEqual(['A', 'A', 'A', 'A', 'A', 'A'])
    expect(texts(orderBodyLines(lines, PAGE_WIDTH))).toEqual([
      ...Array.from({ length: 6 }, (_u, i) => `A${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `B${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `C${i}`),
      ...Array.from({ length: 6 }, (_u, i) => `D${i}`),
    ])
  })

  it('falls back to plain order when the columns are too close to be real', () => {
    // Centres 72 and 120 are 48pt apart — under the fifth-of-a-page threshold.
    const lines = [...column('A', 72, 6, 40), ...column('B', 120, 6, 40)]

    const ordered = orderBodyLines(lines, PAGE_WIDTH)
    expect(ordered).toHaveLength(12)
    expect(texts(ordered)).toEqual(texts([...lines].sort((a, b) => a.bbox.y - b.bbox.y)))
  })

  it('does nothing to a page too short to carry columns', () => {
    const lines = column('A', 72, 5, 220)
    expect(orderBodyLines(lines, PAGE_WIDTH)).toHaveLength(5)
  })

  it('preserves every line exactly once across all of the above', () => {
    const scenarios: GroupedLine[][] = [
      [...column('A', 40, 6), ...column('B', 226, 6), ...column('C', 412, 6)],
      [spanner('Title', 40), ...column('A', 72, 5, 220), ...column('B', 320, 5, 220)],
      [...column('A', 72, 6, 220), spanner('Rule', 260), ...column('B', 320, 6, 220)],
      Array.from({ length: 11 }, (_u, i) =>
        line(`L${i}`, { x: 72, y: 90 + i * 18, w: 400, h: 14 }),
      ),
      [...column('A', 30, 6, 120), ...column('B', 170, 6, 120), ...column('C', 310, 6, 120)],
    ]

    for (const input of scenarios) {
      const ordered = orderBodyLines(input, PAGE_WIDTH)
      preservedEveryLine(input, ordered)
      // and the output is a permutation, not merely a same-sized multiset
      expect(new Set(ordered).size).toBe(ordered.length)
    }
  })
})

describe('findBand', () => {
  it('reports a title as spanning while keeping both columns', () => {
    const band = findBand(
      [spanner('Title', 40), ...column('A', 72, 5, 220), ...column('B', 320, 5, 220)],
      PAGE_WIDTH,
    )

    expect(band).not.toBeNull()
    expect(band!.spanning.map((entry) => entry.text)).toEqual(['Title'])
    expect(band!.left).toHaveLength(5)
    expect(band!.right).toHaveLength(5)
  })

  it('finds no spanning lines on a plain two-column page', () => {
    const band = findBand([...column('A', 72, 6, 220), ...column('B', 320, 6, 220)], PAGE_WIDTH)

    expect(band).not.toBeNull()
    expect(band!.spanning).toHaveLength(0)
    expect(band!.left).toHaveLength(6)
    expect(band!.right).toHaveLength(6)
  })

  it('treats a middle column as a column, not as a spanning line', () => {
    // The two failure modes pull opposite ways: a title must be peeled off the
    // cluster, a genuine middle column must not be.
    const band = findBand(
      [...column('A', 40, 6), ...column('B', 226, 6), ...column('C', 412, 6)],
      PAGE_WIDTH,
    )

    expect(band).not.toBeNull()
    expect(band!.spanning).toHaveLength(0)
    expect(band!.left.map((entry) => entry.text[0])).toEqual([
      'A',
      'A',
      'A',
      'A',
      'A',
      'A',
      'B',
      'B',
      'B',
      'B',
      'B',
      'B',
    ])
    expect(band!.right.map((entry) => entry.text[0])).toEqual(['C', 'C', 'C', 'C', 'C', 'C'])
  })

  it('returns null for a single column', () => {
    const lines = Array.from({ length: 10 }, (_u, i) =>
      line(`L${i}`, { x: 72, y: 100 + i * 20, w: 400, h: 14 }),
    )
    expect(findBand(lines, PAGE_WIDTH)).toBeNull()
  })
})

/**
 * `splitMergedLines` exists because of a very specific arrival shape: when two
 * columns are laid out on a shared grid, every row reaches the structure pass
 * as ONE line whose bounding box spans the fold. The gutter is not merely
 * missed at that point — it is absent from the geometry, so ordering can do
 * nothing. These tests build exactly that shape.
 */
describe('splitMergedLines', () => {
  /** A two-column row that merged into a single line: one run per column. */
  function mergedRow(left: string, right: string, y: number, separator = ' '): GroupedLine {
    const text = `${left}${separator}${right}`
    const bbox: BBox = { x: 72, y, w: 468, h: 14 }
    return {
      id: lineId(0, bbox, text),
      text,
      bbox,
      style: { ...BASE_STYLE },
      itemIndexes: [0, 1],
      runs: [
        { x: 72, w: 220, text: left },
        { x: 320, w: 220, text: `${separator}${right}` },
      ],
    }
  }

  /** A three-column row spanning two gutters. */
  function mergedTriple(a: string, b: string, c: string, y: number): GroupedLine {
    const text = `${a} ${b} ${c}`
    const bbox: BBox = { x: 40, y, w: 532, h: 14 }
    return {
      id: lineId(0, bbox, text),
      text,
      bbox,
      style: { ...BASE_STYLE },
      itemIndexes: [0, 1, 2],
      runs: [
        { x: 40, w: 160, text: a },
        { x: 226, w: 160, text: ` ${b}` },
        { x: 412, w: 160, text: ` ${c}` },
      ],
    }
  }

  function rowRange(count: number): number[] {
    return Array.from({ length: count }, (_u, index) => 100 + index * 20)
  }

  it('cuts each merged row back into one line per column', () => {
    const merged = rowRange(6).map((y, index) => mergedRow(`Left ${index}`, `Right ${index}`, y))

    const split = splitMergedLines(merged, { pageWidth: PAGE_WIDTH, pageIndex: 0 })

    expect(split).toHaveLength(12)
    expect(split.filter((entry) => entry.bbox.x === 72)).toHaveLength(6)
    expect(split.filter((entry) => entry.bbox.x === 320)).toHaveLength(6)
    expect(split.filter((entry) => entry.bbox.x === 72).map((e) => e.text)).toEqual([
      'Left 0',
      'Left 1',
      'Left 2',
      'Left 3',
      'Left 4',
      'Left 5',
    ])
    expect(split.filter((entry) => entry.bbox.x === 320)[0].text).toBe('Right 0')
  })

  it('keeps every character: the parts of a row reassemble into that row', () => {
    const merged = rowRange(6).map((y, index) => mergedRow(`Alpha ${index}`, `Beta ${index}`, y))

    const split = splitMergedLines(merged, { pageWidth: PAGE_WIDTH, pageIndex: 0 })

    expect(split).toHaveLength(12)
    expect(new Set(split).size).toBe(split.length) // no line duplicated
    for (const row of merged) {
      const parts = split.filter((entry) => entry.bbox.y === row.bbox.y)
      expect(parts).toHaveLength(2)
      expect(parts.map((entry) => entry.text).join(' ')).toBe(row.text)
      // The parts must span the row's full extent, with the gutter as the only
      // gap between them — a hole here would mean content went missing.
      const covered = parts.reduce((sum, entry) => sum + entry.bbox.w, 0)
      expect(Math.min(...parts.map((entry) => entry.bbox.x))).toBeCloseTo(row.bbox.x, 6)
      expect(Math.max(...parts.map((entry) => entry.bbox.x + entry.bbox.w))).toBeCloseTo(
        row.bbox.x + row.bbox.w,
        6,
      )
      expect(row.bbox.w - covered).toBeCloseTo(28, 6) // the gutter and nothing else
    }
  })

  it('splits a three-column row at both gutters', () => {
    const merged = rowRange(6).map((y, index) =>
      mergedTriple(`A${index}`, `B${index}`, `C${index}`, y),
    )

    const split = splitMergedLines(merged, { pageWidth: PAGE_WIDTH, pageIndex: 0 })

    expect(split).toHaveLength(18)
    expect(split.filter((entry) => entry.bbox.x === 40)).toHaveLength(6)
    expect(split.filter((entry) => entry.bbox.x === 226)).toHaveLength(6)
    expect(split.filter((entry) => entry.bbox.x === 412)).toHaveLength(6)
  })

  it('leaves a table row whole — its cells are cells because they share a baseline', () => {
    // Tables rely on the very merge this function undoes. Cutting a row apart
    // would turn one table block into a stack of single-cell paragraphs.
    const rows = rowRange(6).map((y, index) => mergedRow(`Col${index}`, `${index}00`, y, '  '))
    expect(rows[0].text).toContain('  ')

    const split = splitMergedLines(rows, { pageWidth: PAGE_WIDTH, pageIndex: 0 })

    expect(split.map((entry) => entry.text)).toEqual(rows.map((entry) => entry.text))
  })

  it('leaves lines with no sub-line geometry untouched', () => {
    // OCR output and hand-built fixtures: one item per recognised line, so
    // there is no internal structure to cut and no band to cut along.
    const plain = rowRange(6).map((y, index) => line(`Row ${index}`, { x: 72, y, w: 468, h: 14 }))

    expect(splitMergedLines(plain, { pageWidth: PAGE_WIDTH, pageIndex: 0 })).toBe(plain)
  })
})
