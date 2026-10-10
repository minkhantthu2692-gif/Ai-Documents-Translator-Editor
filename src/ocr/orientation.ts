/**
 * OSD for scanned pages — orientation (0/90/180/270) and skew.
 *
 * Tesseract's own OSD channel is unreachable here: through tesseract.js v7 the
 * `osd` dump field stays empty whatever page-segmentation mode is set, so the
 * orientation is decided by **trial** instead. The page is recognised as
 * rendered first; if that reads poorly (confidence below
 * {@link OSD_ACCEPT_CONFIDENCE}) the raster is rotated by 90/180/270 degrees
 * and recognised again, stopping at the first trial that reads well and
 * shipping whichever attempt scored highest. `scripts/osd-probe.mjs` is the
 * fixture generator that established the numbers:
 *
 *  - upright synthetic page ......... conf 72 → accepted, no trials;
 *  - rotated 90° clockwise .......... conf 72 without a trial at all — tesseract's
 *    line finder reads a top-to-bottom vertical line, which is exactly what a
 *    clockwise-rotated Latin page presents;
 *  - rotated 90° counter-clockwise .. conf 15 → the quarter-turn trials lift it;
 *  - upside-down .................... conf 15 → the 180° trial lifts it to 74;
 *  - skewed by 2° ................... conf 41 → `rotateAuto` deskews it to 88.
 *
 * Skew rides along for free: every recognition runs with tesseract.js's
 * `rotateAuto`, which reports the correction it applied as `rotateRadians`.
 * Boxes come back in whichever frame was recognised — the rotated trial raster
 * and the deskewed one — so {@link mapBoxBack} inverts both transforms (about
 * the frame's centre; centres map to centres across a quarter-turn) and the
 * caller always sees pixel boxes in the original image's frame, the contract
 * `ocrStructure` leans on. The matrices {@link orientationTransform} returns
 * are the exact ones {@link rotateImage} draws with, so the round trip is
 * pixel-exact rather than approximate.
 *
 * Script detection is deliberately absent: the script follows from the source
 * language the reader picked, and the only signal tesseract would add comes
 * through the `osd` dump that never populates.
 */

import type { OcrBBox, OcrPageData } from './ocrTypes'

/** The source raster in any form `recognize` accepts. */
export type OcrImage = Blob | OffscreenCanvas | string

/** Pixel size of that raster (the frame boxes are reported in at the end). */
export interface OcrImageSize {
  width: number
  height: number
}

/** Quarter-turns tried when the first pass reads poorly. */
export const ORIENTATION_TRIALS = [90, 180, 270] as const

/**
 * Confidence at or above this accepts the first pass without trials. The gap
 * is wide — empirically upright pages sit near 70–90 while an inverted or
 * counter-clockwise page reads near 15 — so the threshold only decides *cost*
 * (a wrong-but-confident pass is still kept in the comparison), never quality:
 * the best attempt always ships, pass included.
 */
export const OSD_ACCEPT_CONFIDENCE = 50

/** One recognition's worth of data, before any frame is chosen. */
export interface RecognitionData {
  text: string
  /** Mean confidence 0..100 (clamped by the recogniser). */
  confidence: number
  /** Line boxes as tesseract reported them — in *its* frame, not necessarily the input's. */
  blocks: OcrPageData | null
  /** `rotateAuto`'s deskew for this run, radians (0 when the run did not deskew). */
  skewRadians: number
}

/** How the caller recognises one frame; injected so trials are unit-testable. */
export type RecognizeOne = (image: OcrImage, rotateAuto: boolean) => Promise<RecognitionData>

/** How the caller rotates a raster; `null`/failed rotation means "no trials". */
export type RotateImage = (image: OcrImage, degrees: number) => Promise<OcrImage | null>

/** One candidate frame: the recognition plus the orientation it was taken at. */
export interface OrientationAttempt extends RecognitionData {
  /** Degrees the source was rotated before this recognition (0/90/180/270). */
  orientation: number
}

/** True when a first pass is too poor to trust without trying other orientations. */
export function needsOrientationTrials(confidence: number): boolean {
  return confidence < OSD_ACCEPT_CONFIDENCE
}

/**
 * The best attempt, keeping the earliest on ties — so an acceptable first
 * pass always beats a trial that only drew even with it, and a trial that
 * reached the acceptance bar stops the search.
 */
export function selectAttempt(attempts: OrientationAttempt[]): OrientationAttempt {
  return attempts.reduce((best, candidate) =>
    candidate.confidence > best.confidence ? candidate : best,
  )
}

/**
 * Recognise `image`, trialling quarter-turn orientations when the first pass
 * reads poorly. `rotate` being `null` (or failing) is not an error: the first
 * pass simply ships, which is how a browser without `OffscreenCanvas` — or a
 * sub-region `rectangle`, whose coordinates a rotation would invalidate —
 * degrades to today's behaviour.
 */
export async function recognizeWithOrientation(
  image: OcrImage,
  recognizeOne: RecognizeOne,
  rotate: RotateImage | null,
): Promise<OrientationAttempt> {
  const first = await recognizeOne(image, rotate !== null)
  if (!rotate || !needsOrientationTrials(first.confidence)) {
    return { ...first, orientation: 0 }
  }

  const attempts: OrientationAttempt[] = [{ ...first, orientation: 0 }]
  for (const degrees of ORIENTATION_TRIALS) {
    const rotated = await rotate(image, degrees)
    if (!rotated) break
    const data = await recognizeOne(rotated, true)
    attempts.push({ ...data, orientation: degrees })
    // Anything at or above the bar cannot be beaten by a later trial and
    // cannot lose to the first pass (that is why we are here).
    if (data.confidence >= OSD_ACCEPT_CONFIDENCE) break
  }
  return selectAttempt(attempts)
}

/**
 * The exact canvas matrix {@link rotateImage} draws with — exported so tests
 * invert the real transform rather than a re-derivation. Maps a point of the
 * original raster onto the rotated one: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 * Returns `null` for anything that is not a quarter-turn.
 */
export function orientationTransform(
  degrees: number,
  size: OcrImageSize,
): [number, number, number, number, number, number] | null {
  switch (degrees) {
    case 90:
      return [0, 1, -1, 0, size.height, 0]
    case 180:
      return [-1, 0, 0, -1, size.width, size.height]
    case 270:
      return [0, -1, 1, 0, 0, size.width]
    default:
      return null
  }
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

/**
 * Map one box from the frame that was recognised back into the original
 * image's frame: first undo tesseract's deskew (it rotated the raster it was
 * handed, about that raster's centre), then undo our own quarter-turn — whose
 * centre maps to the original centre across the width/height swap. The result
 * is the axis-aligned box of the four transformed corners, clamped to the
 * image so float drift never pushes a box off-canvas.
 */
export function mapBoxBack(
  box: OcrBBox,
  size: OcrImageSize,
  orientationDeg: number,
  skewRadians: number,
): OcrBBox {
  const swapped = Math.abs(orientationDeg % 180) === 90
  const frameWidth = swapped ? size.height : size.width
  const frameHeight = swapped ? size.width : size.height
  const frameCx = frameWidth / 2
  const frameCy = frameHeight / 2
  const cx = size.width / 2
  const cy = size.height / 2
  const orientationRad = (orientationDeg * Math.PI) / 180

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const corners: Array<[number, number]> = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x0, box.y1],
    [box.x1, box.y1],
  ]
  for (const [px, py] of corners) {
    const deskewed = rotateAbout(px, py, -skewRadians, frameCx, frameCy)
    const mapped = rotateAbout(deskewed.x, deskewed.y, -orientationRad, frameCx, frameCy)
    const x = mapped.x + (cx - frameCx)
    const y = mapped.y + (cy - frameCy)
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return {
    x0: Math.max(0, Math.min(size.width, x0)),
    y0: Math.max(0, Math.min(size.height, y0)),
    x1: Math.max(0, Math.min(size.width, x1)),
    y1: Math.max(0, Math.min(size.height, y1)),
  }
}

/**
 * Rebuild the block tree with every line box mapped back. Spreads each level,
 * so tesseract fields we do not declare survive untouched; `null` and a
 * frame-neutral result come back as they were.
 */
export function mapBlocksBack(
  blocks: OcrPageData | null,
  size: OcrImageSize,
  orientationDeg: number,
  skewRadians: number,
): OcrPageData | null {
  if (!blocks || !blocks.blocks) return blocks
  if (orientationDeg === 0 && skewRadians === 0) return blocks
  return {
    ...blocks,
    blocks: blocks.blocks.map((block) => ({
      ...block,
      paragraphs: (block.paragraphs ?? []).map((paragraph) => ({
        ...paragraph,
        lines: (paragraph.lines ?? []).map((line) =>
          line.bbox
            ? { ...line, bbox: mapBoxBack(line.bbox, size, orientationDeg, skewRadians) }
            : line,
        ),
      })),
    })),
  }
}

/**
 * Decode the source just far enough to draw it. `OffscreenCanvas` inputs are
 * used as they are (the caller owns them); Blobs and URLs are decoded to an
 * `ImageBitmap` we close afterwards. Anything undecodable yields `null`, which
 * simply means "no trials" — never a failed page.
 */
async function drawableFor(image: OcrImage): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  release?: () => void
} | null> {
  try {
    if (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) {
      return { source: image, width: image.width, height: image.height }
    }
    if (typeof createImageBitmap !== 'function') return null
    const blob = typeof image === 'string' ? await (await fetch(image)).blob() : image
    const bitmap = await createImageBitmap(blob)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  } catch {
    return null
  }
}

/**
 * Rotate a raster by an exact quarter-turn onto a fresh canvas. The matrix is
 * integer-valued, so pixels move without interpolation and the transform is
 * inverted by {@link mapBoxBack} to the pixel. Resolves `null` — no
 * `OffscreenCanvas`, an undecodable source, a non-quarter angle — rather than
 * throwing: orientation is an enhancement, never a reason to fail a page.
 */
export async function rotateImage(image: OcrImage, degrees: number): Promise<OcrImage | null> {
  if (typeof OffscreenCanvas === 'undefined') return null
  if (!(ORIENTATION_TRIALS as readonly number[]).includes(degrees)) return null
  const drawable = await drawableFor(image)
  if (!drawable) return null
  try {
    const swapped = degrees % 180 === 90
    const width = swapped ? drawable.height : drawable.width
    const height = swapped ? drawable.width : drawable.height
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return null
    const [a, b, c, d, e, f] = orientationTransform(degrees, {
      width: drawable.width,
      height: drawable.height,
    }) as [number, number, number, number, number, number]
    context.imageSmoothingEnabled = false
    context.setTransform(a, b, c, d, e, f)
    context.drawImage(drawable.source, 0, 0)
    context.setTransform(1, 0, 0, 1, 0, 0)
    return canvas
  } finally {
    drawable.release?.()
  }
}
