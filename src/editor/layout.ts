/**
 * Translation-time layout (phase (d) — layout auto-adjust).
 *
 * Burmese does not fit where English did: an EN→MY sentence routinely comes
 * back taller than the line it replaced, and the box it has to live in was cut
 * from the *source* PDF. Left alone, the block paints over the one below it —
 * in the editor and in every export that keeps geometry.
 *
 * The adjustment runs when a **translation** lands, never when a person types.
 * Shrinking a font under somebody's fingers as they write is worse than the
 * overflow it prevents, and the live badge already warns them while they work;
 * the model's output, on the other hand, arrives fully formed and is exactly
 * what this pass exists for.
 *
 * Three rules, in order:
 *
 *  1. **Fit inside the band.** The largest size in
 *     `[FIT_MIN_SIZE, originalFontSize]` whose wrapped text fits the original
 *     bbox. The box is sacred — this never grows it, so a page whose text all
 *     fits comes back with no size change at all.
 *  2. **A size the reader pinned is theirs.** `fontSizeMode: 'custom'` is only
 *     re-measured for the warning, never resized.
 *  3. **Never shrink into illegibility.** If the text will not fit even at the
 *     floor, keep the size the document itself used and raise `overflow`
 *     instead — a 6pt line that still spills is unreadable *and* wrong. The
 *     reflow pass (`src/export/reflow.ts`) makes room for it at export time.
 *
 * The patch is empty whenever nothing changes, so a batch of translations that
 * all fit writes no font data and leaves no history behind.
 */

import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type { BlockRecord } from '@/db/types'
import { fitBlockText, measureBlock, type TextMeasurer } from './autofit'
import type { BlockPatch } from './types'

/** The geometry and size state a fit decision needs. */
export type LayoutBlock = Pick<
  BlockRecord,
  | 'width'
  | 'height'
  | 'fontFamily'
  | 'bold'
  | 'italic'
  | 'lineHeight'
  | 'fontSize'
  | 'originalFontSize'
  | 'fontSizeMode'
  | 'overflow'
>

/** Is automatic translation-time fitting switched on? (default: on) */
export async function autoFitEnabled(): Promise<boolean> {
  return settingsRepo.get<boolean>(SETTING_KEYS.autoFit, true)
}

/**
 * The size/overflow fields `block` should carry once it holds `text`.
 * `null` when it already carries them — no write, no undo entry.
 */
export function translationLayoutPatch(
  block: LayoutBlock,
  text: string,
  measure: TextMeasurer,
): BlockPatch | null {
  if (text.trim().length === 0) {
    return block.overflow ? { overflow: false } : null
  }

  // Nothing to fit *into*: a block that was never given a bbox (an imported
  // row, a fixture, a page whose text layer produced no geometry) has no
  // layout to adjust, and a `0` here would only manufacture a warning.
  if (!(block.width > 0) || !(block.height > 0) || !(block.originalFontSize > 0)) return null

  const box = { width: block.width, height: block.height }
  const font = { fontFamily: block.fontFamily, bold: block.bold, italic: block.italic }

  // Rule 2: the reader's own size stands; only the warning follows the text.
  if (block.fontSizeMode === 'custom') {
    const measured = measureBlock(text, box, block.fontSize, block.lineHeight, measure, font)
    const overflow = measured.width > box.width + 0.5 || measured.height > box.height + 0.5
    return overflow === block.overflow ? null : { overflow }
  }

  const fitted = fitBlockText({
    text,
    box,
    ...font,
    originalSize: block.originalFontSize,
    lineHeight: block.lineHeight,
    measure,
  })

  // Rule 1 fits it inside the band; rule 3 falls back to the document's own
  // size when even the floor is too small, handing the problem to reflow.
  const fontSize = fitted.fits ? fitted.fontSize : block.originalFontSize
  const overflow = !fitted.fits

  const patch: BlockPatch = {}
  if (fontSize !== block.fontSize) {
    patch.fontSize = fontSize
    patch.fontSizeMode = 'auto'
  }
  if (overflow !== block.overflow) patch.overflow = overflow
  return Object.keys(patch).length === 0 ? null : patch
}
