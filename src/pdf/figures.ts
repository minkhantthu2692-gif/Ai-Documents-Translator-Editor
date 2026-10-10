/**
 * Anchoring figures to the text they illustrate.
 *
 * Extraction finds *where* a picture is (`imageOps.ts`); this module decides
 * whether it is a figure at all, and which paragraph it belongs to. Without
 * that pairing a translated document keeps the words and loses the picture:
 * the caption says "Figure 3" and there is nothing above it, because a picture
 * has no text to hang off and therefore never became a block.
 *
 * Two filters do the heavy lifting, and both are about telling a figure apart
 * from page furniture:
 *
 *   - **size** — a wash, a scan or a full-bleed background is bigger than the
 *     page, a rule or a bar is thinner than a caption, a dot or an icon is
 *     smaller than the smallest thing anyone labels. Tiled patterns are caught
 *     by the cap on how many figures one block may carry.
 *   - **coverage** — type sitting *on* the image means the image is behind the
 *     page's text rather than next to it. A chart's own axis labels cover a
 *     sliver of it and pass; a background texture under a paragraph does not.
 *
 * Anchoring is staged rather than scored: a labelled caption wins, then the
 * nearest body block on either side within half a page. That order is what
 * makes a `Figure 3.` line the figure's caption even when another paragraph
 * sits closer to it, and it keeps the failure mode gentle — a figure with no
 * text near it is dropped, and the HTML/PDF exports still show it as page art.
 *
 * Pure: numbers and blocks in, blocks mutated. `pdfExtract.test.ts` exercises
 * it end to end against a generated fixture.
 */
import type { ImagePlacement } from './imageOps'
import { MARGIN_BAND, type PageBlock } from './structure'
import type { BBox } from './stableId'

/** Thinner than this in either direction is a rule, a divider or a bar. */
const MIN_FIGURE_EDGE = 8
/** Below this an image is a dot, a bullet or an icon nobody labels. */
const MIN_FIGURE_AREA = 600
/** Above this share of the sheet the image *is* the page: a wash or a scan. */
const MAX_PAGE_SHARE = 0.6
/**
 * Share of a figure's own area that body text may sit on before the picture
 * reads as background. High enough to keep a photo with a headline over it,
 * low enough to drop the texture a paragraph is printed on.
 */
const MAX_TEXT_COVERAGE = 0.7
/** How much of the narrower of the two boxes must share a column. */
const MIN_CAPTION_OVERLAP = 0.5
const MIN_COLUMN_OVERLAP = 0.3
/** A caption this far into the figure is still the figure's caption. */
const CAPTION_SLACK = 1
/** Multiplier on the caption's own font size for "directly below". */
const CAPTION_GAP = 4
/** How far from a figure an uncaptioned neighbour may be and still own it. */
const NEAR_GAP_SHARE = 0.5
/** Tiled patterns would otherwise pile every tile onto one paragraph. */
const MAX_FIGURES_PER_BLOCK = 12

/**
 * Lines that name a figure: `Figure 3.`, `Fig. 2`, `Plate IV` … Numbering is
 * required, because "Diagram of the process" is a heading about a picture, not
 * its label, and anchoring to it would move the picture under the wrong text.
 */
const CAPTION_LABEL =
  /^\s*(?:figure|fig\.?|image|plate|exhibit|diagram|chart|graph|illustration|picture|photo)\s*[.:\-–—]?\s*\d/i

interface PageFrame {
  pageWidth: number
  pageHeight: number
}

/** Intersection of two boxes, or a zero box when they do not meet. */
function intersection(a: BBox, b: BBox): BBox {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(a.x + a.w, b.x + b.w) - x
  const h = Math.min(a.y + a.h, b.y + b.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : { x: 0, y: 0, w: 0, h: 0 }
}

/** Share of `figure` that `rects` cover, counting overlaps only once. */
function coverage(figure: BBox, rects: readonly BBox[]): number {
  const area = figure.w * figure.h
  if (!(area > 0)) return 0
  let covered = 0
  for (const rect of rects) {
    const hit = intersection(figure, rect)
    covered += hit.w * hit.h
  }
  return Math.min(1, covered / area)
}

/** Share of the narrower box the two share horizontally, 0..1. */
function columnOverlap(figure: BBox, block: BBox): number {
  const span = Math.min(figure.w, block.w)
  if (!(span > 0)) return 0
  // Horizontal only: a caption *under* a figure never intersects it in y, so
  // asking for a rectangle would answer "no overlap" for every pairing this
  // module exists to make.
  const overlap = Math.min(figure.x + figure.w, block.x + block.w) - Math.max(figure.x, block.x)
  return overlap > 0 ? overlap / span : 0
}

/** Is this painted rectangle a figure, or is it page furniture? */
function isFigure(
  placement: ImagePlacement,
  frame: PageFrame,
  textRects: readonly BBox[],
): boolean {
  const { y, w, h } = placement.bbox
  if (!(w > 0) || !(h > 0)) return false
  if (w < MIN_FIGURE_EDGE || h < MIN_FIGURE_EDGE) return false
  if (w * h < MIN_FIGURE_AREA) return false
  if (w * h > MAX_PAGE_SHARE * frame.pageWidth * frame.pageHeight) return false
  // A letterhead logo lives in the running-head band and would otherwise be
  // injected halfway down the body of a flow export.
  const band = frame.pageHeight * MARGIN_BAND
  const centre = y + h / 2
  if (centre < band || centre > frame.pageHeight - band) return false
  return coverage(placement.bbox, textRects) <= MAX_TEXT_COVERAGE
}

/**
 * The closest block satisfying `accept`, measured by `distance`. Blocks too far
 * on the wrong side of the figure (`distance < -CAPTION_SLACK`) never compete,
 * so a caption *beside* a figure cannot claim it.
 */
function nearest(
  figure: BBox,
  candidates: readonly PageBlock[],
  distance: (block: PageBlock) => number,
  accept: (block: PageBlock, gap: number) => boolean,
  overlap: number,
): PageBlock | null {
  let best: PageBlock | null = null
  let bestGap = Infinity
  for (const block of candidates) {
    const gap = distance(block)
    if (gap < -CAPTION_SLACK) continue
    if (!accept(block, gap)) continue
    if (columnOverlap(figure, block.bbox) < overlap) continue
    if (gap < bestGap) {
      best = block
      bestGap = gap
    }
  }
  return best
}

/** Vertical gap from a box's bottom edge to a block's top edge. */
function gapBelow(figure: BBox, block: PageBlock): number {
  return block.bbox.y - (figure.y + figure.h)
}

/** Vertical gap from a box's top edge to a block's bottom edge. */
function gapAbove(figure: BBox, block: PageBlock): number {
  return figure.y - (block.bbox.y + block.bbox.h)
}

/** The block a figure belongs to: its caption if it has one, else a neighbour. */
function anchorFor(figure: BBox, body: readonly PageBlock[], frame: PageFrame): PageBlock | null {
  if (body.length === 0) return null
  const withinCaption = (block: PageBlock, gap: number): boolean =>
    gap <= CAPTION_GAP * Math.max(block.fontSize, 1)

  const captions = body.filter((block) => CAPTION_LABEL.test(block.text))
  return (
    nearest(
      figure,
      captions,
      (block) => gapBelow(figure, block),
      withinCaption,
      MIN_CAPTION_OVERLAP,
    ) ??
    nearest(
      figure,
      captions,
      (block) => gapAbove(figure, block),
      withinCaption,
      MIN_CAPTION_OVERLAP,
    ) ??
    nearest(
      figure,
      body,
      (block) => gapBelow(figure, block),
      (_block, gap) => gap <= NEAR_GAP_SHARE * frame.pageHeight,
      MIN_COLUMN_OVERLAP,
    ) ??
    nearest(
      figure,
      body,
      (block) => gapAbove(figure, block),
      (_block, gap) => gap <= NEAR_GAP_SHARE * frame.pageHeight,
      MIN_COLUMN_OVERLAP,
    )
  )
}

/**
 * Fills `block.figures` for every figure the page really has.
 *
 * The pass resets first, exactly as `attachLinks` does, so re-running it (or
 * running it over a page another producer already touched) is idempotent. A
 * sidecar page has no operator list to walk and therefore no placements: it
 * comes out with empty arrays, which is why the runtime feeds the pdf.js
 * placements to *both* engines rather than letting the fallback lose figures.
 */
export function anchorFigures(
  blocks: PageBlock[],
  placements: readonly ImagePlacement[],
  frame: PageFrame,
): void {
  for (const block of blocks) block.figures = []
  if (placements.length === 0 || blocks.length === 0) return

  const body = blocks.filter((block) => block.region === 'body')
  const textRects = blocks.map((block) => block.bbox)

  for (const placement of placements) {
    if (!isFigure(placement, frame, textRects)) continue
    const target = anchorFor(placement.bbox, body, frame)
    if (target === null || target.figures.length >= MAX_FIGURES_PER_BLOCK) continue
    target.figures.push({
      bbox: placement.bbox,
      pixelWidth: placement.pixelWidth,
      pixelHeight: placement.pixelHeight,
    })
  }

  // Stream order is drawing order, which on a scanned spread is neither top to
  // bottom nor left to right. Reading order is what every exporter assumes.
  for (const block of blocks) {
    block.figures.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  }
}
