import { describe, expect, it } from 'vitest'
import { markTableContinuations } from './collect'
import type { ExportBlock, ExportPage } from './types'

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
    y: 34,
    width: 200,
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
    sourceText: 'Some prose.',
    translatedText: 'Some prose.',
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

/** One content page. The height is what the "ran past the middle" test uses. */
function page(index: number, blocks: ExportBlock[], height = 792): ExportPage {
  return { index, width: 612, height, rotation: 0, contentClass: 'text', blocks }
}

/**
 * A table of `columns` columns printed so far down the page that the break —
 * not the table — is what ended it: bottom `740` against the `435.6` the
 * half-page guard asks for on a 792pt page.
 */
function deepTable(
  order: number,
  columns: number,
  overrides: Partial<ExportBlock> = {},
): ExportBlock {
  return block({
    id: `t${order}`,
    order,
    kind: 'table',
    y: 560,
    height: 180,
    sourceText: 'Head \t Head\nCell \t Cell',
    translatedText: 'Head \t Head\nCell \t Cell',
    tableCells: [
      Array.from({ length: columns }, (_, index) => `h${index}`),
      Array.from({ length: columns }, (_, index) => `v${index}`),
    ],
    ...overrides,
  })
}

describe('markTableContinuations', () => {
  it('marks the table that opens the next page when the one above was cut by it', () => {
    const over = deepTable(0, 2)
    const pages = [
      page(0, [
        block({ id: 'p0', sourceText: 'Prose.', translatedText: 'Prose.' }),
        deepTable(1, 2),
      ]),
      page(1, [over]),
    ]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBe(true)
  })

  it('leaves a different column count alone', () => {
    // The one check that separates "the rest of this table" from "another
    // table happens to start here" — a wrong join would put another table's
    // rows under this table's header.
    const over = deepTable(0, 3)
    const pages = [page(0, [deepTable(1, 2)]), page(1, [over])]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBeUndefined()
  })

  it('leaves a table that stopped high on the page alone', () => {
    // A section end, with the sheet blank below it: it does not speak for
    // whatever table the next page happens to open with.
    const over = deepTable(0, 2)
    const pages = [page(0, [deepTable(1, 2, { y: 100, height: 40 })]), page(1, [over])]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBeUndefined()
  })

  it('leaves a page that lets prose follow the table alone', () => {
    // Nothing follows a table the break cut — if it did, the table ended
    // there and the next page's table is its own.
    const over = deepTable(0, 2)
    const pages = [page(0, [deepTable(1, 2), block({ id: 'p1', order: 2 })]), page(1, [over])]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBeUndefined()
  })

  it('leaves a page that opens with prose alone', () => {
    // The next page did not begin with the table, so something was printed
    // above it — it is a new table, not the old one's continuation.
    const over = deepTable(1, 2)
    const pages = [page(0, [deepTable(0, 2)]), page(1, [block({ id: 'p1' }), over])]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBeUndefined()
  })

  it('leaves a one-column table alone', () => {
    // One column is not a table (see `tableGrid`), and a grid of cells with
    // no separator is text whose shape says nothing about its neighbour.
    const over = deepTable(0, 1)
    const pages = [page(0, [deepTable(1, 1)]), page(1, [over])]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBeUndefined()
  })

  it('skips a page whose neighbour was left out of the export', () => {
    // An export of a page range has nothing to continue from: page 3 was
    // never read, so page 4's table cannot be the half of page 2's.
    const over = deepTable(0, 2)
    const pages = [page(0, [deepTable(1, 2)]), page(3, [over])]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBeUndefined()
  })

  it('marks past the running head and the page footer', () => {
    // Both are margin text printed where they were on their page, not content
    // between the two halves — and neither may receive the mark itself, or a
    // renderer would look for a table where there is a line of text.
    const over = deepTable(1, 2)
    const head = block({ id: 'head', order: 0, region: 'header' })
    const foot = block({ id: 'foot', order: 3, region: 'footer' })
    const pages = [page(0, [deepTable(1, 2), foot]), page(1, [head, over])]

    markTableContinuations(pages)

    expect(over.tableContinuation).toBe(true)
    expect(head.tableContinuation).toBeUndefined()
    expect(foot.tableContinuation).toBeUndefined()
  })

  it('is idempotent — a second pass changes nothing', () => {
    const over = deepTable(0, 2)
    const pages = [page(0, [deepTable(1, 2)]), page(1, [over])]

    markTableContinuations(pages)
    markTableContinuations(pages)

    expect(over.tableContinuation).toBe(true)
  })
})
