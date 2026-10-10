/**
 * OSD orientation trials and the frame mapping back.
 *
 * Three invariants carry the feature, and each one fails silently if broken:
 *
 *  1. the trial policy never costs a confident page its first pass (and never
 *     ships a worse attempt than the one it started with);
 *  2. `mapBoxBack` inverts exactly the transform `rotateImage` draws — the
 *     round trip is asserted against the *real* matrix, not a re-derivation;
 *  3. a rotation that cannot happen (no `OffscreenCanvas`, an undecodable
 *     source) degrades to today's behaviour instead of failing the page.
 *
 * The confidence numbers pinned here are the ones `scripts/osd-probe.mjs`
 * measured against synthetic rotated/skewed fixtures.
 */
import { describe, expect, it } from 'vitest'
import type { OcrBBox, OcrBlock, OcrPageData } from './ocrTypes'
import {
  OSD_ACCEPT_CONFIDENCE,
  mapBoxBack,
  mapBlocksBack,
  needsOrientationTrials,
  orientationTransform,
  recognizeWithOrientation,
  selectAttempt,
  type OcrImage,
  type OcrImageSize,
  type OrientationAttempt,
  type RecognitionData,
  type RecognizeOne,
  type RotateImage,
} from './orientation'

function data(confidence: number, text = 'text'): RecognitionData {
  return { text, confidence, blocks: null, skewRadians: 0 }
}

function corners(box: OcrBBox): Array<[number, number]> {
  return [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x0, box.y1],
    [box.x1, box.y1],
  ]
}

function rotateAbout(
  x: number,
  y: number,
  radians: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  const dx = x - cx
  const dy = y - cy
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

/** The recognised frame's box: through the real rotation matrix, then a deskew. */
function forwardBox(box: OcrBBox, degrees: number, size: OcrImageSize, skewRadians = 0): OcrBBox {
  // 0° is the deskew-only path: no canvas turn, identity matrix.
  const matrix = orientationTransform(degrees, size) ?? (degrees === 0 ? [1, 0, 0, 1, 0, 0] : null)
  expect(matrix).not.toBeNull()
  const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number]
  const swapped = degrees % 180 === 90
  const frameWidth = swapped ? size.height : size.width
  const frameHeight = swapped ? size.width : size.height
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of corners(box)) {
    let px = a * x + c * y + e
    let py = b * x + d * y + f
    if (skewRadians !== 0) {
      const rotated = rotateAbout(px, py, skewRadians, frameWidth / 2, frameHeight / 2)
      px = rotated.x
      py = rotated.y
    }
    xs.push(px)
    ys.push(py)
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

function expectBoxClose(actual: OcrBBox, expected: OcrBBox, eps = 1e-6): void {
  expect(actual.x0).toBeCloseTo(expected.x0, -Math.log10(eps))
  expect(actual.y0).toBeCloseTo(expected.y0, -Math.log10(eps))
  expect(actual.x1).toBeCloseTo(expected.x1, -Math.log10(eps))
  expect(actual.y1).toBeCloseTo(expected.y1, -Math.log10(eps))
}

describe('orientation trial policy', () => {
  it('accepts a confident first pass and trials anything below the bar', () => {
    expect(needsOrientationTrials(OSD_ACCEPT_CONFIDENCE)).toBe(false)
    expect(needsOrientationTrials(OSD_ACCEPT_CONFIDENCE + 1)).toBe(false)
    expect(needsOrientationTrials(OSD_ACCEPT_CONFIDENCE - 1)).toBe(true)
    expect(needsOrientationTrials(15)).toBe(true)
    expect(needsOrientationTrials(0)).toBe(true)
  })

  it('selectAttempt keeps the earliest attempt on ties', () => {
    const attempts: OrientationAttempt[] = [
      { ...data(30), orientation: 0 },
      { ...data(30), orientation: 90 },
      { ...data(30), orientation: 180 },
    ]
    expect(selectAttempt(attempts).orientation).toBe(0)
  })

  it('selectAttempt ships the highest confidence', () => {
    const attempts: OrientationAttempt[] = [
      { ...data(15, 'first'), orientation: 0 },
      { ...data(20, 'quarter'), orientation: 90 },
      { ...data(74, 'upside-down fixed'), orientation: 180 },
    ]
    const best = selectAttempt(attempts)
    expect(best.orientation).toBe(180)
    expect(best.text).toBe('upside-down fixed')
  })
})

describe('recognizeWithOrientation', () => {
  const image: OcrImage = 'page-render'

  it('a confident first pass runs once, deskewed, and never rotates', async () => {
    const calls: Array<[OcrImage, boolean]> = []
    const rotated: Array<[OcrImage, number]> = []
    const recognizeOne: RecognizeOne = async (source, rotateAuto) => {
      calls.push([source, rotateAuto])
      return data(88)
    }
    const rotate: RotateImage = async (source, degrees) => {
      rotated.push([source, degrees])
      return null
    }

    const attempt = await recognizeWithOrientation(image, recognizeOne, rotate)

    expect(calls).toEqual([[image, true]])
    expect(rotated).toEqual([])
    expect(attempt.orientation).toBe(0)
    expect(attempt.confidence).toBe(88)
  })

  it('without a rotate hook the first pass ships undisturbed, no deskew flag', async () => {
    const calls: Array<[OcrImage, boolean]> = []
    const recognizeOne: RecognizeOne = async (source, rotateAuto) => {
      calls.push([source, rotateAuto])
      return data(15)
    }

    const attempt = await recognizeWithOrientation(image, recognizeOne, null)

    expect(calls).toEqual([[image, false]])
    expect(attempt.orientation).toBe(0)
    expect(attempt.confidence).toBe(15)
  })

  it('a poor first pass stops at the first trial that reads well', async () => {
    const recognitions: OcrImage[] = []
    const trials: number[] = []
    const recognizeOne: RecognizeOne = async (source) => {
      recognitions.push(source)
      return source === image ? data(15, 'garbled') : data(81, 'upright after trial')
    }
    const rotate: RotateImage = async (_source, degrees) => {
      trials.push(degrees)
      return `rotated-${degrees}`
    }

    const attempt = await recognizeWithOrientation(image, recognizeOne, rotate)

    expect(trials).toEqual([90])
    expect(recognitions).toHaveLength(2)
    expect(attempt.orientation).toBe(90)
    expect(attempt.text).toBe('upright after trial')
  })

  it('every weak trial runs and the best one ships', async () => {
    const confidences = [15, 20, 30, 44]
    let seen = 0
    const recognizeOne: RecognizeOne = async () => data(confidences[seen++])
    const trials: number[] = []
    const rotate: RotateImage = async (_source, degrees) => {
      trials.push(degrees)
      return `rotated-${degrees}`
    }

    const attempt = await recognizeWithOrientation(image, recognizeOne, rotate)

    expect(trials).toEqual([90, 180, 270])
    expect(seen).toBe(4)
    expect(attempt.orientation).toBe(270)
    expect(attempt.confidence).toBe(44)
  })

  it('a rotation that cannot happen falls back to the first pass', async () => {
    let recognitions = 0
    const recognizeOne: RecognizeOne = async () => {
      recognitions += 1
      return data(15)
    }

    const attempt = await recognizeWithOrientation(image, recognizeOne, async () => null)

    expect(recognitions).toBe(1)
    expect(attempt.orientation).toBe(0)
    expect(attempt.confidence).toBe(15)
  })

  it('ties across trials keep the first pass', async () => {
    let seen = 0
    const recognizeOne: RecognizeOne = async () => data([30, 30, 20, 10][seen++])
    const trials: number[] = []
    const rotate: RotateImage = async (_source, degrees) => {
      trials.push(degrees)
      return `rotated-${degrees}`
    }

    const attempt = await recognizeWithOrientation(image, recognizeOne, rotate)

    expect(trials).toEqual([90, 180, 270])
    expect(attempt.orientation).toBe(0)
    expect(attempt.confidence).toBe(30)
  })
})

describe('orientationTransform', () => {
  const size: OcrImageSize = { width: 400, height: 100 }

  it('maps the source corners onto the quarter-turn frame', () => {
    // 90° clockwise: top-left lands on the top-right of the swapped canvas.
    expect(orientationTransform(90, size)).toEqual([0, 1, -1, 0, 100, 0])
    // 180°: the frame keeps its dimensions, corners swap ends.
    expect(orientationTransform(180, size)).toEqual([-1, 0, 0, -1, 400, 100])
    // 270° (counter-clockwise): top-left lands on the bottom-left.
    expect(orientationTransform(270, size)).toEqual([0, -1, 1, 0, 0, 400])
  })

  it('refuses anything that is not a quarter-turn', () => {
    expect(orientationTransform(0, size)).toBeNull()
    expect(orientationTransform(45, size)).toBeNull()
    expect(orientationTransform(-90, size)).toBeNull()
  })
})

describe('mapBoxBack', () => {
  const portrait: OcrImageSize = { width: 200, height: 720 }
  const landscape: OcrImageSize = { width: 720, height: 200 }
  const box: OcrBBox = { x0: 84, y0: 148, x1: 112, y1: 572 }

  it('is the identity when nothing was rotated', () => {
    expect(mapBoxBack(box, portrait, 0, 0)).toEqual(box)
  })

  it('round-trips every quarter-turn against the real matrix', () => {
    // Each frame needs a box that actually fits inside it: mapping back also
    // clamps to the image, so a portrait box in a landscape raster would be
    // asserting against the clamp rather than the transform.
    const cases: Array<[OcrImageSize, OcrBBox]> = [
      [portrait, box],
      [landscape, { x0: 148, y0: 84, x1: 572, y1: 112 }],
    ]
    for (const [size, original] of cases) {
      for (const degrees of [90, 180, 270]) {
        const recognised = forwardBox(original, degrees, size)
        const mapped = mapBoxBack(recognised, size, degrees, 0)
        expectBoxClose(mapped, original, 1e-6)
      }
    }
  })

  it('round-trips a deskew back onto the skewed original', () => {
    // tesseract reported -1.91° on a 2°-skewed fixture; the recognised frame
    // is the deskewed one, and mapping back must land on the skewed line.
    const skew = -0.033426184207201004
    const line: OcrBBox = { x0: 148, y0: 84, x1: 572, y1: 112 }
    const recognised = forwardBox(line, 0, landscape, skew)
    const mapped = mapBoxBack(recognised, landscape, 0, skew)
    expect(mapped.x0).toBeLessThanOrEqual(line.x0 + 1e-6)
    expect(mapped.y0).toBeLessThanOrEqual(line.y0 + 1e-6)
    expect(mapped.x1).toBeGreaterThanOrEqual(line.x1 - 1e-6)
    expect(mapped.y1).toBeGreaterThanOrEqual(line.y1 - 1e-6)
    // Two AABB passes grow each side by at most the *other* side's sin 2θ —
    // the bound, not a guess, since a skewed line's box is its own AABB.
    const growth = Math.sin(2 * Math.abs(skew))
    expect(mapped.x1 - mapped.x0).toBeLessThanOrEqual(
      line.x1 - line.x0 + (line.y1 - line.y0) * growth + 1e-6,
    )
    expect(mapped.y1 - mapped.y0).toBeLessThanOrEqual(
      line.y1 - line.y0 + (line.x1 - line.x0) * growth + 1e-6,
    )
  })

  it('round-trips a quarter-turn and a deskew together', () => {
    const skew = -0.05
    const recognised = forwardBox(box, 90, portrait, skew)
    const mapped = mapBoxBack(recognised, portrait, 90, skew)
    expect(mapped.x0).toBeLessThanOrEqual(box.x0 + 1e-6)
    expect(mapped.y0).toBeLessThanOrEqual(box.y0 + 1e-6)
    expect(mapped.x1).toBeGreaterThanOrEqual(box.x1 - 1e-6)
    expect(mapped.y1).toBeGreaterThanOrEqual(box.y1 - 1e-6)
    // The quarter-turn swaps the axes before the growth lands, so the width
    // (28) inherits the long side's sin 2θ term and the height (424) the
    // short side's — the same AABB bound as above, one swap over.
    const growth = Math.sin(2 * Math.abs(skew))
    const longSide = box.y1 - box.y0
    const shortSide = box.x1 - box.x0
    expect(mapped.x1 - mapped.x0).toBeLessThanOrEqual(shortSide + longSide * growth + 1e-6)
    expect(mapped.y1 - mapped.y0).toBeLessThanOrEqual(longSide + shortSide * growth + 1e-6)
  })

  it('clamps a box drifting off the canvas back onto it', () => {
    const drifted: OcrBBox = { x0: -0.4, y0: -0.4, x1: 200.4, y1: 720.4 }
    const mapped = mapBoxBack(drifted, portrait, 0, 0)
    expect(mapped).toEqual({ x0: 0, y0: 0, x1: 200, y1: 720 })
  })
})

describe('mapBlocksBack', () => {
  const size: OcrImageSize = { width: 200, height: 720 }

  function tree(bbox: OcrBBox | undefined): OcrPageData {
    // A block's own `confidence` is real tesseract output that never made it
    // into the declared subset — the spread must carry it through, so it
    // enters via a typed local rather than a fresh (excess-checked) literal.
    const block: OcrBlock & { confidence: number } = {
      confidence: 80,
      paragraphs: [
        // tesseract omits a line's box often enough that `ocrStructure`
        // guards for it, though the declared type cannot say so.
        { lines: [{ text: 'line', confidence: 81, bbox: bbox as OcrBBox }] },
      ],
    }
    return {
      blocks: [block],
      confidence: 80,
    }
  }

  it('passes null and a frame-neutral tree through untouched', () => {
    expect(mapBlocksBack(null, size, 90, 0)).toBeNull()
    const neutral = tree({ x0: 1, y0: 2, x1: 3, y1: 4 })
    expect(mapBlocksBack(neutral, size, 0, 0)).toBe(neutral)
  })

  it('rewrites every line box and keeps the text and extra fields', () => {
    const source = tree({ x0: 10, y0: 20, x1: 60, y1: 30 })
    const mapped = mapBlocksBack(source, size, 180, 0)

    const line = mapped?.blocks?.[0]?.paragraphs[0].lines[0]
    expect(line?.text).toBe('line')
    expect(line?.confidence).toBe(81)
    expect(mapped?.confidence).toBe(80)
    // Fields outside the declared subset — a block's own confidence — ride
    // the spread untouched.
    const mappedBlock = mapped?.blocks?.[0] as (OcrBlock & { confidence: number }) | undefined
    expect(mappedBlock?.confidence).toBe(80)
    // 180° lands the box about the 200×720 frame centre. sin π is a hair off
    // zero, so the box compares to 1e-9 rather than for identity.
    expectBoxClose(line!.bbox!, { x0: 140, y0: 690, x1: 190, y1: 700 }, 1e-9)
    // The source tree is never mutated.
    expect(source.blocks?.[0].paragraphs[0].lines[0].bbox).toEqual({
      x0: 10,
      y0: 20,
      x1: 60,
      y1: 30,
    })
  })

  it('keeps a line whose bbox never came back', () => {
    const source = tree(undefined)
    const mapped = mapBlocksBack(source, size, 90, 0)
    expect(mapped?.blocks?.[0].paragraphs[0].lines[0]).toEqual({
      text: 'line',
      confidence: 81,
      bbox: undefined,
    })
  })
})
