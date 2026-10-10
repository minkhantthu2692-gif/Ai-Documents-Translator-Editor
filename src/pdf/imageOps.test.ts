/**
 * The image walk, against literal operator lists.
 *
 * The rectangles come from `q … cm … Do … Q`, so what is really under test is
 * the matrix bookkeeping: composition order, the save/restore stack, and the
 * flip from PDF's bottom-left origin into the top-left space every block bbox
 * already uses. `pdfExtract.test.ts` checks the same reconstruction against
 * boxes a real PDF paints.
 */
import { describe, expect, it } from 'vitest'
import { OPS, type OpList } from './pdfOps'
import { traceImagePlacements } from './imageOps'

const PAGE = [0, 0, 612, 792]

function ops(...entries: Array<[number, unknown[]]>): OpList {
  return {
    fnArray: entries.map(([fn]) => fn),
    argsArray: entries.map(([, args]) => args),
  }
}

/** `q … cm … Do … Q`, the shape every real PDF uses to place an image. */
function place(a: number, b: number, c: number, d: number, e: number, f: number): OpList {
  return ops(
    [OPS.save, []],
    [OPS.transform, [a, b, c, d, e, f]],
    [OPS.paintImageXObject, ['img_1', 90, 110]],
    [OPS.restore, []],
  )
}

describe('traceImagePlacements', () => {
  it('turns the unit square through the current transform into a page box', () => {
    // cm 300 0 0 300 280 60 — the generated mixed.pdf places its figure here.
    const [image] = traceImagePlacements(place(300, 0, 0, 300, 280, 60), PAGE)
    expect(image.bbox).toEqual({ x: 280, y: 432, w: 300, h: 300 })
    expect(image.objId).toBe('img_1')
    expect(image.pixelWidth).toBe(90)
    expect(image.pixelHeight).toBe(110)
  })

  it('flips y through the view, so top-down and text coordinates agree', () => {
    // The image's PDF-space top edge is 750pt up from the bottom of the sheet;
    // in page space that must read as 42pt down from the top, the same frame a
    // `TextItemLike` transform is measured in.
    const [image] = traceImagePlacements(place(100, 0, 0, 100, 10, 650), PAGE)
    expect(image.bbox).toEqual({ x: 10, y: 42, w: 100, h: 100 })
  })

  it('reads a cropped view rather than assuming the sheet origin', () => {
    const view = [50, 50, 562, 742]
    const [image] = traceImagePlacements(place(300, 0, 0, 300, 100, 100), view)
    expect(image.bbox).toEqual({ x: 50, y: 342, w: 300, h: 300 })
  })

  it('applies the newest transform first', () => {
    // A frame offset by 50pt, then a 100pt square drawn *inside* that frame.
    // The square therefore starts at 50, not at 5000 — the page frame is what
    // a point passes through last, never first.
    const list = ops(
      [OPS.save, []],
      [OPS.transform, [1, 0, 0, 1, 50, 0]],
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ['img_1', 100, 100]],
      [OPS.restore, []],
    )
    const [image] = traceImagePlacements(list, PAGE)
    expect(image.bbox).toEqual({ x: 50, y: 692, w: 100, h: 100 })
  })

  it('restores the matrix a save recorded, not the one since', () => {
    const list = ops(
      [OPS.save, []],
      [OPS.transform, [300, 0, 0, 300, 280, 60]],
      [OPS.restore, []],
      [OPS.paintImageXObject, ['img_1', 90, 110]],
    )
    // No transform left in force — the unit square sits in the page's corner.
    const [image] = traceImagePlacements(list, PAGE)
    expect(image.bbox).toEqual({ x: 0, y: 791, w: 1, h: 1 })
  })

  it('reports two images under one save/restore in stream order', () => {
    const list = ops(
      [OPS.save, []],
      [OPS.transform, [100, 0, 0, 100, 0, 692]],
      [OPS.paintImageXObject, ['a', 10, 10]],
      [OPS.restore, []],
      [OPS.save, []],
      [OPS.transform, [100, 0, 0, 100, 512, 692]],
      [OPS.paintImageXObject, ['b', 10, 10]],
      [OPS.restore, []],
    )
    const images = traceImagePlacements(list, PAGE)
    expect(images.map((image) => image.bbox)).toEqual([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 512, y: 0, w: 100, h: 100 },
    ])
  })

  it('takes the axis-aligned bounds of a rotated image', () => {
    // cm 0 100 -100 0 300 300 — a quarter turn; the box is 100 × 100 either way.
    const [image] = traceImagePlacements(place(0, 100, -100, 0, 300, 300), PAGE)
    expect(image.bbox).toEqual({ x: 200, y: 392, w: 100, h: 100 })
  })

  it('clips a figure that runs off the sheet', () => {
    const [image] = traceImagePlacements(place(300, 0, 0, 300, -150, -100), PAGE)
    expect(image.bbox).toEqual({ x: 0, y: 592, w: 150, h: 200 })
  })

  it('drops an image entirely outside the page', () => {
    expect(traceImagePlacements(place(100, 0, 0, 100, 1000, 1000), PAGE)).toEqual([])
  })

  it('drops a degenerate or overflowing transform instead of emitting NaN', () => {
    // Zero height: the unit square collapses to a line.
    expect(traceImagePlacements(place(1, 0, 0, 0, 0, 0), PAGE)).toEqual([])
    // Two scales that overflow to Infinity between them.
    const overflow = ops(
      [OPS.transform, [1e200, 0, 0, 1e200, 0, 0]],
      [OPS.transform, [1e200, 0, 0, 1e200, 0, 0]],
      [OPS.paintImageXObject, ['img_1', 1, 1]],
    )
    expect(traceImagePlacements(overflow, PAGE)).toEqual([])
    // A matrix that is not finite at all is refused and leaves the frame alone.
    expect(traceImagePlacements(place(NaN, 0, 0, 10, 0, 0), PAGE)).toEqual([
      { bbox: { x: 0, y: 791, w: 1, h: 1 }, objId: 'img_1', pixelWidth: 90, pixelHeight: 110 },
    ])
  })

  it('treats a missing view as a whole sheet of nothing', () => {
    expect(traceImagePlacements(place(300, 0, 0, 300, 0, 0), [])).toEqual([])
  })

  it('gives a form XObject its own frame and takes it back', () => {
    const list = ops(
      [
        OPS.paintFormXObjectBegin,
        [
          [1, 0, 0, 1, 50, 0],
          [0, 0, 612, 792],
        ],
      ],
      [OPS.transform, [300, 0, 0, 300, 156, 460]],
      [OPS.paintImageXObject, ['img_1', 90, 110]],
      [OPS.paintFormXObjectEnd, []],
      [OPS.paintImageXObject, ['img_2', 90, 110]],
    )
    const images = traceImagePlacements(list, PAGE)
    // Inside the form the image sits at (156, 460); the form's own 50pt offset
    // is in page space, so it lands at 206 — added after the scale, not before.
    expect(images).toHaveLength(2)
    expect(images[0].bbox).toEqual({ x: 206, y: 32, w: 300, h: 300 })
    // The frame is gone again once the form ends: this is the bare unit square.
    expect(images[1].bbox).toEqual({ x: 0, y: 791, w: 1, h: 1 })
  })

  it('counts every tile of a fused repeat', () => {
    const list = ops([OPS.paintImageXObjectRepeat, ['img_1', 50, 50, [0, 742, 50, 742, 0, 692]]])
    const images = traceImagePlacements(list, PAGE)
    expect(images.map((image) => image.bbox)).toEqual([
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 50, y: 0, w: 50, h: 50 },
      { x: 0, y: 50, w: 50, h: 50 },
    ])
    expect(images[0].objId).toBe('img_1')
  })

  it('gives a fused mask group one box per entry', () => {
    const list = ops([
      OPS.paintImageMaskXObjectGroup,
      [
        [
          { width: 20, height: 10, transform: [20, 0, 0, 10, 72, 692] },
          { width: 20, height: 10, transform: [20, 0, 0, 10, 100, 692] },
        ],
      ],
    ])
    const images = traceImagePlacements(list, PAGE)
    expect(images.map((image) => image.bbox)).toEqual([
      { x: 72, y: 90, w: 20, h: 10 },
      { x: 100, y: 90, w: 20, h: 10 },
    ])
    expect(images[0].pixelWidth).toBe(20)
    expect(images[0].pixelHeight).toBe(10)
    expect(images[0].objId).toBeNull()
  })

  it('reads an inline image, which reports its size on the image itself', () => {
    const list = ops(
      [OPS.save, []],
      [OPS.transform, [40, 0, 0, 20, 100, 400]],
      [OPS.paintInlineImageXObject, [{ width: 40, height: 20, data: [] }]],
      [OPS.restore, []],
    )
    const [image] = traceImagePlacements(list, PAGE)
    expect(image.bbox).toEqual({ x: 100, y: 372, w: 40, h: 20 })
    expect(image.pixelWidth).toBe(40)
    expect(image.pixelHeight).toBe(20)
  })

  it('ignores a text stencil, which is type rather than a figure', () => {
    const list = ops(
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintSolidColorImageMask, [{ width: 8, height: 8 }]],
    )
    expect(traceImagePlacements(list, PAGE)).toEqual([])
  })

  it('keeps walking when a save is never restored', () => {
    const list = ops(
      [OPS.restore, []],
      [OPS.transform, [300, 0, 0, 300, 280, 60]],
      [OPS.paintImageXObject, ['img_1', 90, 110]],
    )
    const [image] = traceImagePlacements(list, PAGE)
    expect(image.bbox).toEqual({ x: 280, y: 432, w: 300, h: 300 })
  })

  it('caps the number of placements a tiled pattern can produce', () => {
    const tiles: number[] = []
    for (let index = 0; index < 1000; index += 1) tiles.push(0, index % 700)
    const list = ops([OPS.paintImageXObjectRepeat, ['img_1', 1, 1, tiles]])
    expect(traceImagePlacements(list, PAGE).length).toBeLessThanOrEqual(400)
  })

  it('survives an operator list whose args ran out', () => {
    const list: OpList = { fnArray: [OPS.paintImageXObject, OPS.save], argsArray: [[]] }
    expect(() => traceImagePlacements(list, PAGE)).not.toThrow()
  })
})
