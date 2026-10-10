/**
 * Where the images on a page are, and how big they are.
 *
 * pdf.js has no public API for this: `getOperatorList()` is the only place a
 * page's graphics are handed over, and an image operator carries an object id
 * rather than a rectangle. The rectangle is in the *current transformation
 * matrix* — `q … cm … Do … Q` — so it has to be reconstructed by walking the
 * stream the way the renderer does, keeping a stack of graphics states and
 * composing every `cm` into the matrix in force when the image is painted.
 *
 * Everything here is pure (numbers in, boxes out) so it can be tested against
 * literal operator lists; `pdfExtract.test.ts` checks the reconstruction
 * against the boxes the generated fixtures actually paint.
 */
import { OPS, type OpList } from './pdfOps'
import type { BBox } from './stableId'

/** `a b c d e f`, the six numbers of a PDF matrix (row-vector convention). */
type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/**
 * Composes two matrices: `compose(m, n)` applied to a point applies `m` and
 * then `n`.
 *
 * The walk below always puts the *newest* transform on the left —
 * `CTM' = M × CTM`, the spec's concatenation rule — because a `cm` extends the
 * matrix a point is transformed by first. The other order applies the page
 * frame before the one written inside it, which mirrors every nested form
 * about its own setup.
 */
function compose(m: Matrix, n: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m
  const [a2, b2, c2, d2, e2, f2] = n
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ]
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Coerces whatever an operator handed us to a matrix, or null. */
function asMatrix(value: unknown): Matrix | null {
  if (!Array.isArray(value) || value.length !== 6) return null
  for (const entry of value) if (typeof entry !== 'number' || !Number.isFinite(entry)) return null
  return value as unknown as Matrix
}

/** A positive finite number, or null — image dimensions are never negative. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Image dimensions as an operator reported them, when it reported any. */
function sizeOf(args: readonly unknown[]): { w: number | null; h: number | null } {
  const first = args[0]
  if (first && typeof first === 'object') {
    const shape = first as { width?: unknown; height?: unknown }
    return { w: numberOf(shape.width), h: numberOf(shape.height) }
  }
  return { w: numberOf(args[1]), h: numberOf(args[2]) }
}

/** One painted image, in the page's own top-left-origin coordinates. */
export interface ImagePlacement {
  /** Rectangle in page space (top-left origin), clipped to the page. */
  bbox: BBox
  /** pdf.js's object id for the pixels, when the operator named one. */
  objId: string | null
  /** Native raster size in pixels, when the operator reported it. */
  pixelWidth: number | null
  pixelHeight: number | null
}

/** How deep `q` nesting the walk will honour before it stops pushing. */
const MAX_STACK = 128
/** A page cannot usefully hold more placements than this; a tiled pattern can. */
const MAX_PLACEMENTS = 400

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Walks an operator list and reports every image rectangle.
 *
 * `view` is `page.view` — `[llx, lly, urx, ury]`. Subtracting `view[0]` and
 * flipping through `view[3]` puts a placement in exactly the coordinate system
 * pdf.js measures text in (the transform `groupItemsIntoLines` reads), which
 * is what every block bbox already uses — so a figure and a paragraph can be
 * compared without a conversion anywhere.
 *
 * Deliberately *not* reported: `paintSolidColorImageMask`, which pdf.js also
 * emits for stroked and filled text rendering modes — counting it would make
 * every ordinary text page look like a page of stencilled logos, the same
 * reason `pdfOps.countImages` excludes it.
 */
export function traceImagePlacements(ops: OpList, view: readonly number[]): ImagePlacement[] {
  const vx1 = view[0] ?? 0
  const vy1 = view[1] ?? 0
  const vx2 = view[2] ?? 0
  const vy2 = view[3] ?? 0
  const pageWidth = Math.abs(vx2 - vx1)
  const pageHeight = Math.abs(vy2 - vy1)
  if (!(pageWidth > 0) || !(pageHeight > 0)) return []

  const out: ImagePlacement[] = []
  const stack: Matrix[] = []
  /** Frames a full stack refused to record — their `Q`s must be swallowed. */
  let dropped = 0
  let ctm: Matrix = IDENTITY

  /** Unit square through `matrix`, then into page space, clipped to the page. */
  const place = (
    matrix: Matrix,
    objId: string | null,
    w: number | null,
    h: number | null,
  ): void => {
    if (out.length >= MAX_PLACEMENTS) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const [px, py] = apply(matrix, x, y)
      if (!Number.isFinite(px) || !Number.isFinite(py)) return
      if (px < minX) minX = px
      if (py < minY) minY = py
      if (px > maxX) maxX = px
      if (py > maxY) maxY = py
    }

    const left = minX - vx1
    const right = maxX - vx1
    const top = vy2 - maxY
    const bottom = vy2 - minY
    const x = Math.max(0, left)
    const y = Math.max(0, top)
    const wBox = Math.min(pageWidth, right) - x
    const hBox = Math.min(pageHeight, bottom) - y
    if (!(wBox > 0) || !(hBox > 0)) return
    out.push({
      bbox: { x: round(x), y: round(y), w: round(wBox), h: round(hBox) },
      objId,
      pixelWidth: w,
      pixelHeight: h,
    })
  }

  const push = (matrix?: Matrix | null): void => {
    if (stack.length >= MAX_STACK) {
      dropped += 1
      return
    }
    // What the matching `Q` must restore is the state as it stood *before* this
    // frame, so the matrix is recorded first and the frame's own transform
    // applied on top of it.
    stack.push(ctm)
    if (matrix) ctm = compose(matrix, ctm)
  }
  const pop = (): void => {
    if (dropped > 0) {
      dropped -= 1
      return
    }
    const previous = stack.pop()
    if (previous) ctm = previous
  }

  const { fnArray, argsArray } = ops
  const count = Math.min(fnArray.length, argsArray.length)
  for (let index = 0; index < count && out.length < MAX_PLACEMENTS; index += 1) {
    const fn = fnArray[index]
    const args = argsArray[index] ?? []

    switch (fn) {
      case OPS.save:
        push()
        break
      case OPS.restore:
        pop()
        break
      case OPS.transform: {
        const matrix = asMatrix(args)
        if (matrix) ctm = compose(matrix, ctm)
        break
      }
      // A form XObject is a nested content stream with its own matrix, and
      // pdf.js brackets it with these two rather than with `q`/`Q`. It needs
      // its own frame on the same stack; the form's own `save`s balance out
      // inside it.
      case OPS.paintFormXObjectBegin:
        push(asMatrix(args[0]))
        break
      case OPS.paintFormXObjectEnd:
        pop()
        break
      case OPS.paintImageXObject:
        place(
          ctm,
          typeof args[0] === 'string' ? args[0] : null,
          numberOf(args[1]),
          numberOf(args[2]),
        )
        break
      case OPS.paintImageMaskXObject:
      case OPS.paintInlineImageXObject: {
        const size = sizeOf(args)
        place(ctm, null, size.w, size.h)
        break
      }
      // pdf.js fuses a repeated `q … cm … Do … Q` into one op carrying every
      // translation. Each tile is the unit square through that `cm`, exactly
      // as the display layer paints it.
      case OPS.paintImageXObjectRepeat: {
        const positions = args[3] as ArrayLike<number> | undefined
        if (!positions || typeof positions.length !== 'number') break
        const objId = typeof args[0] === 'string' ? args[0] : null
        for (let p = 0; p + 1 < positions.length; p += 2) {
          const tile = asMatrix([args[1], 0, 0, args[2], positions[p], positions[p + 1]])
          if (tile) place(compose(tile, ctm), objId, null, null)
        }
        break
      }
      case OPS.paintImageMaskXObjectRepeat: {
        const positions = args[5] as ArrayLike<number> | undefined
        if (!positions || typeof positions.length !== 'number') break
        const size = sizeOf([args[0]])
        for (let p = 0; p + 1 < positions.length; p += 2) {
          const tile = asMatrix([
            args[1],
            args[2],
            args[3],
            args[4],
            positions[p],
            positions[p + 1],
          ])
          if (tile) place(compose(tile, ctm), null, size.w, size.h)
        }
        break
      }
      // Two further fusion shapes: a list of masks that each carry their own
      // full `cm`, or one image plus a list of tiles sharing one transform.
      case OPS.paintImageMaskXObjectGroup: {
        const images = args[0]
        if (!Array.isArray(images)) break
        for (const image of images) {
          const tile = asMatrix(image?.transform)
          const size = sizeOf([image])
          if (tile) place(compose(tile, ctm), null, size.w, size.h)
        }
        break
      }
      case OPS.paintInlineImageXObjectGroup: {
        const map = args[1]
        if (!Array.isArray(map)) break
        const size = sizeOf([args[0]])
        for (const entry of map) {
          const tile = asMatrix(entry?.transform)
          if (tile) place(compose(tile, ctm), null, size.w, size.h)
        }
        break
      }
      default:
        break
    }
  }
  return out
}
