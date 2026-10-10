/**
 * The figure pass, against hand-built boxes.
 *
 * `pdfExtract.test.ts` checks the pairing end to end on a real PDF; this file
 * pins the rules that decide *why* — the size and coverage filters that tell a
 * figure apart from page furniture, and the staged search that decides which
 * paragraph owns it. Every box below is written out so a failing expectation
 * names the rule, not the pipeline.
 */
import { describe, expect, it } from 'vitest'
import { anchorFigures } from './figures'
import type { ImagePlacement } from './imageOps'
import type { BBox } from './stableId'
import type { PageBlock } from './structure'

const FRAME = { pageWidth: 612, pageHeight: 792 }

/** The band a running head or foot lives in: 10% of the sheet either end. */
const BAND = 79.2
/** Everything larger than this share of the sheet is background, not a figure. */
const PAGE_SHARE = 0.6 * 612 * 792

function block(overrides: Partial<PageBlock>): PageBlock {
  return {
    id: 'b0',
    kind: 'paragraph',
    region: 'body',
    order: 0,
    text: 'Body text that a figure may belong to.',
    bbox: { x: 72, y: 100, w: 400, h: 40 },
    lines: [],
    alignment: 'left',
    skipRule: null,
    placeholders: [],
    listMarker: null,
    tableCells: null,
    tableSpans: null,
    headingLevel: null,
    links: [],
    figures: [],
    lineSpacing: 1.4,
    fontFamily: 'Helvetica',
    fontSize: 11,
    bold: false,
    italic: false,
    color: '#000000',
    ...overrides,
  }
}

function placement(bbox: BBox): ImagePlacement {
  return { bbox, objId: 'img_1', pixelWidth: 120, pixelHeight: 80 }
}

/** Every figure on the page, in block order. */
function owned(blocks: PageBlock[]): PageBlock['figures'][number][] {
  return blocks.flatMap((item) => item.figures)
}

describe('anchorFigures — filters', () => {
  const caption = block({
    text: 'Figure 1. Stages of the pipeline.',
    fontSize: 9,
    bbox: { x: 156, y: 283, w: 200, h: 11 },
  })

  it('keeps a figure whose label sits directly beneath it', () => {
    const blocks = [block({ bbox: { x: 72, y: 40, w: 300, h: 30 } }), caption]
    anchorFigures(blocks, [placement({ x: 156, y: 132, w: 300, h: 140 })], FRAME)

    expect(owned(blocks)).toEqual([
      { bbox: { x: 156, y: 132, w: 300, h: 140 }, pixelWidth: 120, pixelHeight: 80 },
    ])
    expect(blocks[1].figures).toHaveLength(1)
  })

  it('drops a rule: thinner in one direction than any label could be', () => {
    const blocks = [caption, block({ bbox: { x: 72, y: 460, w: 400, h: 40 } })]
    anchorFigures(blocks, [placement({ x: 72, y: 200, w: 500, h: 4 })], FRAME)
    expect(owned(blocks)).toEqual([])
  })

  it('drops an icon: too small for anything to point at', () => {
    const blocks = [caption, block({ bbox: { x: 72, y: 460, w: 400, h: 40 } })]
    anchorFigures(blocks, [placement({ x: 400, y: 200, w: 16, h: 16 })], FRAME)
    expect(owned(blocks)).toEqual([])
  })

  it('drops a full-bleed wash: it is the page, not a picture on it', () => {
    const blocks = [caption, block({ bbox: { x: 72, y: 460, w: 400, h: 40 } })]
    expect(PAGE_SHARE).toBeLessThan(612 * 792)
    anchorFigures(blocks, [placement({ x: 0, y: 0, w: 612, h: 792 })], FRAME)
    expect(owned(blocks)).toEqual([])
  })

  it('drops a letterhead logo, which lives in the running-head band', () => {
    const blocks = [caption, block({ bbox: { x: 72, y: 460, w: 400, h: 40 } })]
    // Its centre is 32pt from the top edge: a running head, not a figure.
    expect(12 + 40 / 2).toBeLessThan(BAND)
    anchorFigures(blocks, [placement({ x: 72, y: 12, w: 40, h: 40 })], FRAME)
    expect(owned(blocks)).toEqual([])

    // The same 40 × 40 square, once it is inside the body, is a figure.
    anchorFigures(blocks, [placement({ x: 72, y: 520, w: 40, h: 40 })], FRAME)
    expect(owned(blocks)).toHaveLength(1)
  })

  it('drops a texture the paragraph is printed on', () => {
    const cover = block({ bbox: { x: 72, y: 310, w: 460, h: 130 } })
    const blocks = [cover, block({ bbox: { x: 72, y: 460, w: 400, h: 40 } })]
    anchorFigures(blocks, [placement({ x: 72, y: 300, w: 460, h: 150 })], FRAME)

    // 460 × 130 of a 460 × 150 picture is type: the picture is behind the page.
    expect(owned(blocks)).toEqual([])
  })

  it('keeps a figure a headline sits on, as long as type does not fill it', () => {
    const cover = block({ bbox: { x: 100, y: 205, w: 400, h: 140 } })
    const below = block({ bbox: { x: 100, y: 520, w: 400, h: 40 } })
    const blocks = [cover, below]
    anchorFigures(blocks, [placement({ x: 100, y: 200, w: 400, h: 300 })], FRAME)

    expect(owned(blocks)).toHaveLength(1)
    expect(below.figures).toHaveLength(1)
    expect(cover.figures).toEqual([])
  })

  it('drops a degenerate rectangle rather than emitting a zero box', () => {
    const blocks = [caption, block({ bbox: { x: 72, y: 460, w: 400, h: 40 } })]
    anchorFigures(blocks, [placement({ x: 72, y: 200, w: 0, h: 40 })], FRAME)
    expect(owned(blocks)).toEqual([])
  })
})

describe('anchorFigures — pairing', () => {
  const figure = { x: 72, y: 100, w: 300, h: 200 }

  it('falls back to the nearest paragraph below when nothing labels it', () => {
    const near = block({ bbox: { x: 72, y: 340, w: 300, h: 60 } })
    const blocks = [block({ bbox: { x: 72, y: 40, w: 300, h: 30 } }), near]
    anchorFigures(blocks, [placement(figure)], FRAME)

    expect(near.figures).toHaveLength(1)
    expect(blocks[0].figures).toEqual([])
  })

  it('falls back to the nearest paragraph above when that is closer', () => {
    const above = block({ bbox: { x: 72, y: 40, w: 300, h: 40 } })
    const blocks = [above, block({ bbox: { x: 72, y: 700, w: 300, h: 40 } })]
    anchorFigures(blocks, [placement(figure)], FRAME)

    expect(above.figures).toHaveLength(1)
    expect(blocks[1].figures).toEqual([])
  })

  it('prefers a caption over a nearer paragraph that says nothing', () => {
    const above = block({ bbox: { x: 72, y: 40, w: 300, h: 40 } })
    const caption = block({
      text: 'Figure 2. The four stages.',
      fontSize: 9,
      bbox: { x: 72, y: 310, w: 220, h: 11 },
    })
    const blocks = [above, caption]
    anchorFigures(blocks, [placement(figure)], FRAME)

    expect(caption.figures).toHaveLength(1)
    expect(above.figures).toEqual([])
  })

  it('treats a caption too far away as just another neighbour', () => {
    const near = block({ bbox: { x: 72, y: 340, w: 300, h: 60 } })
    const far = block({
      text: 'Figure 3. Written a whole paragraph later.',
      fontSize: 9,
      bbox: { x: 72, y: 400, w: 220, h: 11 },
    })
    const blocks = [near, far]
    anchorFigures(blocks, [placement(figure)], FRAME)

    // 100pt is past 4 × the caption's own 9pt, so the label carries no weight;
    // proximity alone decides, and the nearer block wins.
    expect(near.figures).toHaveLength(1)
    expect(far.figures).toEqual([])
  })

  it('drops a figure with nothing but running heads and feet near it', () => {
    const blocks = [
      block({ region: 'header', bbox: { x: 72, y: 40, w: 300, h: 20 } }),
      block({ region: 'footer', bbox: { x: 72, y: 740, w: 300, h: 20 } }),
    ]
    anchorFigures(blocks, [placement(figure)], FRAME)
    expect(owned(blocks)).toEqual([])
  })

  it('drops a figure whose only neighbour is more than half a page away', () => {
    const blocks = [block({ bbox: { x: 72, y: 760, w: 300, h: 20 } })]
    anchorFigures(blocks, [placement(figure)], FRAME)

    // The figure's bottom is 300; the block starts at 760, which is 460pt on —
    // past 0.5 × 792, so it cannot be said to belong to anything.
    expect(owned(blocks)).toEqual([])
  })

  it('requires the two to share a column', () => {
    const blocks = [block({ bbox: { x: 460, y: 340, w: 80, h: 60 } })]
    anchorFigures(blocks, [placement(figure)], FRAME)
    expect(owned(blocks)).toEqual([])
  })

  it('resets first, so a second pass does not double every picture', () => {
    const owner = block({ bbox: { x: 72, y: 340, w: 300, h: 60 } })
    const blocks = [owner]
    const placements = [placement(figure), placement({ x: 72, y: 60, w: 100, h: 60 })]

    anchorFigures(blocks, placements, FRAME)
    expect(owner.figures).toHaveLength(2)
    anchorFigures(blocks, placements, FRAME)
    expect(owner.figures).toHaveLength(2)
  })

  it('orders a block’s figures top to bottom, whatever order they were painted', () => {
    const owner = block({ bbox: { x: 72, y: 600, w: 300, h: 40 } })
    const blocks = [owner]
    anchorFigures(
      blocks,
      [placement({ x: 100, y: 500, w: 100, h: 60 }), placement({ x: 100, y: 300, w: 100, h: 60 })],
      FRAME,
    )

    expect(owner.figures.map((item) => item.bbox.y)).toEqual([300, 500])
  })

  it('caps how many pictures one paragraph may carry', () => {
    const owner = block({ bbox: { x: 72, y: 520, w: 300, h: 40 } })
    const tiled = Array.from({ length: 13 }, (_unused, index) =>
      placement({ x: 72, y: 100 + index * 30, w: 300, h: 30 }),
    )
    anchorFigures([owner], tiled, FRAME)

    // A tiled pattern would otherwise pile every tile onto one paragraph and
    // hand an exporter a hundred pictures for one caption.
    expect(owner.figures).toHaveLength(12)
  })

  it('is a no-op on a page with no images, and on one with no text', () => {
    const blocks = [block({ bbox: { x: 72, y: 340, w: 300, h: 60 } })]
    expect(() => anchorFigures(blocks, [], FRAME)).not.toThrow()
    expect(owned(blocks)).toEqual([])

    expect(() =>
      anchorFigures([], [placement({ x: 72, y: 100, w: 300, h: 200 })], FRAME),
    ).not.toThrow()
  })
})
