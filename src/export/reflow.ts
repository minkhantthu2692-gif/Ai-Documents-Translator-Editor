/**
 * Vertical reflow for an absolutely-positioned page (phase (d) — export height
 * handling, and the editor canvas that has to agree with it).
 *
 * Auto-fit (`src/editor/autofit.ts`) is shrink-only and stops at a readable
 * 6pt, so a page can still hold a block whose Burmese is taller than the box
 * cut for its English. Absolutely positioning every block at the `y` the PDF
 * gave it meant the text simply painted over whatever came below.
 *
 * This pass makes room instead. It is a *push-down*, not a re-layout: a block
 * that still fits keeps its extracted position and height to the point, so a
 * document whose text all grew no more than its boxes can hold comes back
 * byte-identical, and only the surplus is spent.
 *
 * Two rules keep the push honest about the page it is working on:
 *
 *  - **Only the block above you can move you.** Two blocks that shared a row
 *    in the source — a second column, or a full-width band with the columns it
 *    sits on — are never treated as cause and effect, so growth in column one
 *    leaves column two alone. "Above" is judged on the *extracted* boxes, not
 *    the grown ones, so a band that grew still pushes both columns under it.
 *  - **The page cannot grow.** The page box is fixed, so a push stops at the
 *    bottom edge rather than printing half a block onto the next sheet. A
 *    block too tall to fit anywhere is left exactly where it was.
 *
 * The function is generic over the geometry it needs, so the editor's
 * `BlockRecord` and the export's `ExportBlock` go through the same pass and
 * cannot drift. Every caller decides what a block will actually print; pass
 * that text through `textOf` and the measurement cannot drift from the render.
 */

import { measureBlock, type TextMeasurer } from '@/editor/autofit'

/** Sub-point slack: two boxes that merely touch do not overlap. */
const EPSILON = 0.5

/** The geometry a block must carry for reflow to consider it. */
export interface ReflowBlock {
  id: string
  order: number
  /** Geometry in PDF points relative to the page. */
  x: number
  y: number
  width: number
  height: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  bold: boolean
  italic: boolean
}

export interface ReflowOptions<T extends ReflowBlock> {
  /** Width of a rendered glyph run in points (canvas, or the fallback). */
  measure: TextMeasurer
  /** Exactly the text the caller will print for a block. */
  textOf: (block: T) => string
  /**
   * Height of the page box in points. `0` (or less) disables the clamp, which
   * is what a surface without a fixed page would want.
   */
  pageHeight: number
}

/** Same-column test: the horizontal ranges must share most of the narrower one. */
function overlapsInX(a: ReflowBlock, b: ReflowBlock): boolean {
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  return overlap > Math.max(1, Math.min(a.width, b.width)) * 0.5
}

/**
 * How much vertical room the block needs once it holds `text`.
 *
 * The extracted height stays a floor: a block that still fits keeps exactly the
 * box the PDF gave it, so the original rhythm of the page survives — and a
 * block that *is* pushed carries its whole box, not just the line inside it.
 */
function heightFor<T extends ReflowBlock>(
  block: T,
  text: string,
  options: ReflowOptions<T>,
): number {
  if (text.trim().length === 0) return block.height
  // No bbox and no extracted size means there is nothing to measure against;
  // `block.height` is what the caller will render for it anyway.
  if (!(block.width > 0) || !(block.fontSize > 0)) return block.height
  const measured = measureBlock(
    text,
    { width: block.width, height: block.height },
    block.fontSize,
    block.lineHeight,
    options.measure,
    { fontFamily: block.fontFamily, bold: block.bold, italic: block.italic },
  )
  return Math.max(block.height, measured.height)
}

interface Placed<T extends ReflowBlock> {
  block: T
  bottom: number
}

/** Returns `blocks` with the ones that outgrew their neighbours moved down. */
export function reflowBlocks<T extends ReflowBlock>(blocks: T[], options: ReflowOptions<T>): T[] {
  const heights = new Map<string, number>()
  for (const block of blocks) {
    heights.set(block.id, heightFor(block, options.textOf(block), options))
  }

  // Top to bottom, so every block is only ever pushed by one already placed.
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order)
  const tops = new Map<string, number>()
  const placed: Placed<T>[] = []

  for (const block of sorted) {
    const need = heights.get(block.id) ?? block.height
    let top = block.y

    for (const other of placed) {
      if (!overlapsInX(other.block, block)) continue
      // A block that reached this far down in the source was beside us, not
      // above us — a neighbouring column, or a band the columns sit under.
      if (other.block.y + other.block.height > block.y + EPSILON) continue
      top = Math.max(top, other.bottom)
    }

    if (options.pageHeight > 0 && top > options.pageHeight - need) {
      // Park the block as low as it still fits; never move one up.
      top = Math.max(block.y, options.pageHeight - need)
    }

    tops.set(block.id, top)
    placed.push({ block, bottom: top + need })
  }

  return blocks.map((block) => {
    // `top` is either the block's own `y` or a value taken from another
    // block's bottom, so an untouched block is *identically* its own y — no
    // tolerance here, because sub-point moves are real and accumulate down a
    // chain of pushes.
    const top = tops.get(block.id)
    return top !== undefined && top !== block.y ? { ...block, y: top } : block
  })
}
