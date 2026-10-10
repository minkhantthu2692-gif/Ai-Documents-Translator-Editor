/**
 * Table detection acceptance tests.
 *
 * Two things are being pinned here, and they pull in opposite directions:
 *
 *  - the block builder must turn a real table — cells as separate positioned
 *    show-text operators — into one rectangular grid, which only geometry can
 *    do because `groupItemsIntoLines` has already flattened the layout out of
 *    `line.text`;
 *  - the reading-order pass must keep cutting a row fused across a column
 *    gutter, which only the text form can tell apart from a table row, since
 *    the two fixtures in `readingOrder.test.ts` differ in no measurable way
 *    except that one was written with a double space.
 *
 * `fixtures/table.pdf` is the end of this: it is built cell by cell, exactly
 * as a document processor writes a table, and neither of its pages can be
 * reached by any test that constructs a line by hand.
 */
import { describe, expect, it } from 'vitest'
import {
  cellBoundaries,
  cellGapThreshold,
  looksLikeTableRow,
  rowCells,
  tableForLines,
  type TableContinuation,
} from './rowSplit'
import type { GroupedLine, LineRun, LineStyle } from './lineGrouping'
import { lineId, type BBox } from './stableId'

const BASE_STYLE: LineStyle = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  color: '#000000',
  rotation: 0,
}

/** A line with per-run geometry — the shape a real PDF produces. */
function row(y: number, cells: Array<[text: string, x: number, w: number]>): GroupedLine {
  const runs: LineRun[] = cells.map(([text, x, w]) => ({ x, w, text }))
  const left = Math.min(...runs.map((run) => run.x))
  const right = Math.max(...runs.map((run) => run.x + run.w))
  const bbox: BBox = { x: left, y, w: right - left, h: 14 }
  const text = cells.map(([value]) => value).join(' ')
  return { id: lineId(0, bbox, text), text, bbox, style: { ...BASE_STYLE }, itemIndexes: [], runs }
}

/** A line with no sub-line geometry: hand-built fixtures and OCR output. */
function plain(text: string, y = 100): GroupedLine {
  const bbox: BBox = { x: 72, y, w: 200, h: 14 }
  return { id: lineId(0, bbox, text), text, bbox, style: { ...BASE_STYLE }, itemIndexes: [] }
}

describe('cellGapThreshold', () => {
  it('is one em, and never smaller than four points', () => {
    expect(cellGapThreshold(12)).toBe(12)
    expect(cellGapThreshold(3)).toBe(4)
  })

  it('sits well above any word space', () => {
    // Proportional faces set 0.2-0.5 em for a space, so a gap of a full em
    // cannot be typography — it is layout, and layout on a baseline is a cell.
    expect(cellGapThreshold(11)).toBeGreaterThan(11 * 0.5)
  })
})

describe('cellBoundaries', () => {
  it('marks the left edge of every run preceded by a cell-sized gap', () => {
    expect(
      cellBoundaries(
        row(100, [
          ['Region', 72, 35],
          ['Q1', 260, 15],
          ['Q2', 430, 15],
        ]),
      ),
    ).toEqual([260, 430])
  })

  it('finds nothing when every gap is a word space', () => {
    expect(
      cellBoundaries(
        row(100, [
          ['Name', 72, 30],
          ['Value', 110, 35],
        ]),
      ),
    ).toEqual([])
  })

  it('finds nothing in a line made of one run', () => {
    expect(cellBoundaries(row(100, [['A single sentence.', 72, 120]]))).toEqual([])
  })

  it('finds nothing in a line with no geometry at all', () => {
    expect(cellBoundaries(plain('Name    Value'))).toEqual([])
  })
})

describe('rowCells', () => {
  it('splits a line on its own runs', () => {
    expect(
      rowCells(
        row(100, [
          ['North', 72, 30],
          ['120', 260, 18],
          ['150', 430, 18],
        ]),
      ),
    ).toEqual(['North', '120', '150'])
  })

  it('falls back to the text when the line carries no runs', () => {
    expect(rowCells(plain('Name    Value'))).toEqual(['Name', 'Value'])
  })

  it('is null for an ordinary sentence, however it arrives', () => {
    expect(rowCells(row(100, [['Revenue rose in the third quarter.', 72, 180]]))).toBeNull()
    expect(rowCells(plain('Revenue rose in the third quarter.'))).toBeNull()
  })
})

describe('tableForLines', () => {
  it('builds a rectangle from cut positions that recur across the rows', () => {
    const lines = [
      row(100, [
        ['Region', 72, 35],
        ['Q1', 260, 15],
        ['Q2', 430, 15],
      ]),
      row(84, [
        ['North', 72, 30],
        ['120', 260, 18],
        ['150', 430, 18],
      ]),
      row(68, [
        ['South', 72, 32],
        ['90', 260, 12],
        ['110', 430, 18],
      ]),
    ]
    expect(tableForLines(lines)?.rows).toEqual([
      ['Region', 'Q1', 'Q2'],
      ['North', '120', '150'],
      ['South', '90', '110'],
    ])
  })

  it('pads a row whose middle cell is empty back to the full width', () => {
    const lines = [
      row(100, [
        ['Product', 72, 40],
        ['Units', 300, 25],
        ['Notes', 460, 30],
      ]),
      row(84, [
        ['Widget', 72, 35],
        ['120', 300, 18],
        ['restocked', 460, 48],
      ]),
      row(68, [
        ['Gadget', 72, 36],
        ['clearance', 460, 48],
      ]),
    ]
    expect(tableForLines(lines)?.rows).toEqual([
      ['Product', 'Units', 'Notes'],
      ['Widget', '120', 'restocked'],
      ['Gadget', '', 'clearance'],
    ])
  })

  it('needs at least two lines, since one row is not an alignment', () => {
    expect(
      tableForLines([
        row(100, [
          ['North', 72, 30],
          ['120', 260, 18],
        ]),
      ]),
    ).toBeNull()
  })

  it('rejects a run of lines one of which is prose', () => {
    const lines = [
      row(100, [
        ['Region', 72, 35],
        ['Q1', 260, 15],
        ['Q2', 430, 15],
      ]),
      row(84, [
        ['North', 72, 30],
        ['120', 260, 18],
        ['150', 430, 18],
      ]),
      row(68, [['The board accepted these figures without amendment.', 72, 240]]),
    ]
    expect(tableForLines(lines)).toBeNull()
  })

  it('rejects cut positions no two rows agree on', () => {
    const lines = [
      row(100, [
        ['A', 72, 10],
        ['B', 260, 10],
      ]),
      row(84, [
        ['C', 72, 10],
        ['D', 150, 10],
      ]),
      row(68, [
        ['E', 72, 10],
        ['F', 430, 10],
      ]),
    ]
    expect(tableForLines(lines)).toBeNull()
  })

  it('falls back to the text form when the lines carry no runs', () => {
    expect(tableForLines([plain('Name    Value'), plain('Alpha   12', 84)])).toEqual({
      rows: [
        ['Name', 'Value'],
        ['Alpha', '12'],
      ],
      // No runs, no geometry, and therefore nothing that could say a cell is
      // wider than its column: the exporters are told the table is flat.
      spans: null,
    })
  })

  it('rejects hand-built lines whose text carries no cell gaps', () => {
    expect(tableForLines([plain('Name Value'), plain('Alpha 12', 84)])).toBeNull()
  })

  it('rejects text-form rows that disagree on how many columns there are', () => {
    expect(tableForLines([plain('Name    Value'), plain('Alpha   12   kg', 84)])).toBeNull()
  })

  it('reports no spans for a table where every cell is one column wide', () => {
    expect(
      tableForLines([
        row(100, [
          ['Region', 72, 35],
          ['Q1', 260, 15],
        ]),
        row(84, [
          ['North', 72, 30],
          ['120', 260, 18],
        ]),
      ])?.spans,
    ).toBeNull()
  })

  it('reads a cell drawn across a column as one merged cell', () => {
    // The header's second cell begins inside column two and runs past column
    // three's left edge — one show-text run wider than the column it starts
    // in, with no other run on the row. That is all a merged cell ever looks
    // like from here.
    //
    // Its row also holds *one* non-empty cell out of three, so this only gets
    // past the fill rule because the merge counts for the two columns it
    // covers: a header written across two of three columns is a row of the
    // table, not the line of prose beside it.
    const lines = [
      row(100, [
        ['Consolidated ', 72, 60],
        ['results', 200, 80],
      ]),
      row(84, [
        ['North', 72, 30],
        ['120', 260, 18],
        ['150', 430, 18],
      ]),
      row(68, [
        ['South', 72, 32],
        ['90', 260, 12],
        ['110', 430, 18],
      ]),
    ]
    expect(tableForLines(lines)).toEqual({
      rows: [
        ['Consolidated results', '', ''],
        ['North', '120', '150'],
        ['South', '90', '110'],
      ],
      // The merged cell keeps its text in the column it *starts* in and the
      // column it covers is left at zero; the row stays three wide, because
      // that is the rectangle the text form was built from.
      spans: [
        [2, 0, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
    })
  })

  it('draws a row flat when its merge would sit on a cell it still draws', () => {
    const lines = [
      // This run claims column two — its advance reaches past the boundary —
      // and then column two turns up again on the same baseline holding `90`.
      // Either it is overlapping text or it is a trailing space in the width;
      // both are answered the same way: this row is read as three cells, which
      // is what it was before spans existed. The *table* survives, which is
      // what refusing the row wholesale would have cost.
      row(100, [
        ['Consolidated results', 72, 250],
        ['90', 260, 12],
        ['110', 430, 18],
      ]),
      row(84, [
        ['North', 72, 30],
        ['120', 260, 18],
        ['150', 430, 18],
      ]),
      row(68, [
        ['South', 72, 32],
        ['90', 260, 12],
        ['110', 430, 18],
      ]),
    ]
    expect(tableForLines(lines)).toEqual({
      rows: [
        ['Consolidated results', '90', '110'],
        ['North', '120', '150'],
        ['South', '90', '110'],
      ],
      spans: null,
    })
  })

  it('refuses a block whose rows are mostly merged', () => {
    // Three rows out of five carry a merge, and each one is individually
    // sound — the clusters still agree on both columns, every row is full
    // enough. What makes this not a table is that *most* of it is merged: the
    // shape of prose beside a table, whose rows are its sentences running
    // across the reader's columns. Such a block keeps the reading it had
    // before spans existed.
    const lines = [
      row(100, [
        ['Region', 72, 35],
        ['Consolidated results', 260, 180],
      ]),
      row(84, [
        ['Quarter', 72, 35],
        ['Regional breakdown', 260, 180],
      ]),
      row(68, [
        ['Consolidated results', 72, 250],
        ['120', 430, 18],
      ]),
      row(52, [
        ['South', 72, 32],
        ['90', 260, 12],
        ['110', 430, 18],
      ]),
      row(36, [
        ['East', 72, 30],
        ['75', 260, 12],
        ['80', 430, 18],
      ]),
    ]
    expect(tableForLines(lines)).toBeNull()
  })

  describe('with the table the previous page ended with', () => {
    // One row on a page of its own cannot agree with anything: two cells in
    // one line are a long word space however wide, because columns are a
    // *recurring* cut and a single line recurs over nothing. The previous
    // table is the missing recurrence, and each of these cases pins one of
    // the conditions it has to satisfy before its vote counts.
    const THREE: TableContinuation = { width: 3, left: 72 }

    it('reads one line as one row of the table the page before had', () => {
      expect(
        tableForLines(
          [
            row(100, [
              ['West', 72, 30],
              ['200', 260, 18],
              ['210', 430, 18],
            ]),
          ],
          THREE,
        ),
      ).toEqual({ rows: [['West', '200', '210']], spans: null })
    })

    it('reads every line that is cut the way that table was cut', () => {
      // Two rows, each sound on its own — nothing here is a guess about
      // geometry, only the recurrence the page break took away has been
      // borrowed from the page before it.
      expect(
        tableForLines(
          [
            row(100, [
              ['West', 72, 30],
              ['200', 260, 18],
              ['210', 430, 18],
            ]),
            row(84, [
              ['Total', 72, 30],
              ['320', 260, 18],
              ['330', 430, 18],
            ]),
          ],
          THREE,
        ),
      ).toEqual({
        rows: [
          ['West', '200', '210'],
          ['Total', '320', '330'],
        ],
        spans: null,
      })
    })

    it('reads nothing without the previous table to read it against', () => {
      expect(
        tableForLines([
          row(100, [
            ['West', 72, 30],
            ['200', 260, 18],
            ['210', 430, 18],
          ]),
        ]),
      ).toBeNull()
    })

    it('refuses a line cut into a different number of cells', () => {
      // Two cells where the table had three is a different table's row, or a
      // line whose middle cell was never drawn — and padding the difference
      // would put text in a column it does not belong to.
      expect(
        tableForLines(
          [
            row(100, [
              ['West', 72, 30],
              ['210', 430, 18],
            ]),
          ],
          THREE,
        ),
      ).toBeNull()
    })

    it('refuses a line that does not start where the table started', () => {
      // A row further right belongs to a table of its own, indented under a
      // heading or set in another column: the previous table's vote is about
      // *this* margin and no other.
      expect(
        tableForLines(
          [
            row(100, [
              ['West', 120, 30],
              ['200', 260, 18],
              ['210', 430, 18],
            ]),
          ],
          THREE,
        ),
      ).toBeNull()
    })

    it('refuses a line whose runs are spans of prose rather than cells', () => {
      // Cut into the right number of cells, at the right margin — and still a
      // sentence, because a run this wide carries a clause. Width is what
      // keeps the reading-order pass and this one agreeing on what a cell is.
      expect(
        tableForLines(
          [
            row(100, [
              ['Revenue rose through the quarter and then fell back', 72, 250],
              ['120', 430, 18],
            ]),
          ],
          { width: 2, left: 72 },
        ),
      ).toBeNull()
    })

    it('refuses a line with no geometry to read cells from', () => {
      // Hand-built fixtures and OCR lines carry no runs, so there is nothing
      // to measure a margin or a cell width against.
      expect(tableForLines([plain('West 200 210')], THREE)).toBeNull()
    })

    it('leaves the ordinary reading to decide when there are enough rows', () => {
      // Two agreeing rows are already a table; the previous table is asked
      // only when that reading has failed, and its answer cannot overrule it.
      const lines = [
        row(100, [
          ['North', 72, 30],
          ['120', 260, 18],
          ['150', 430, 18],
        ]),
        row(84, [
          ['South', 72, 32],
          ['90', 260, 12],
          ['110', 430, 18],
        ]),
      ]
      const detected = tableForLines(lines)
      expect(detected?.rows).toEqual([
        ['North', '120', '150'],
        ['South', '90', '110'],
      ])
      expect(tableForLines(lines, { width: 2, left: 72 })).toEqual(detected)
    })
  })
})

describe('looksLikeTableRow', () => {
  it('protects a hand-built row whose cells are separated as text', () => {
    expect(looksLikeTableRow(plain('Col0  00'))).toBe(true)
  })

  it('leaves a hand-built three-column row to the gutters', () => {
    expect(looksLikeTableRow(plain('A0 B0 C0'))).toBe(false)
  })

  it('protects a real row whose cells are cell-sized', () => {
    expect(
      looksLikeTableRow(
        row(100, [
          ['North', 72, 30],
          ['120', 260, 18],
          ['150', 430, 18],
        ]),
      ),
    ).toBe(true)
  })

  it('leaves a span of prose crossing a gutter to the cut', () => {
    // Both gaps are wide enough to be cells, but each run is a clause rather
    // than a label — that is what makes this a column line and not a table row.
    const span = row(100, [
      ['Revenue rose across the', 72, 150],
      ['northern region last year', 330, 150],
    ])
    expect(looksLikeTableRow(span)).toBe(false)
  })

  it('never protects a line with no runs and no cell gaps', () => {
    expect(looksLikeTableRow(plain('A sentence that just runs on.'))).toBe(false)
  })
})
