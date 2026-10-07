/**
 * Font controls (Phase 4).
 *
 * The Font Family / Font Size dropdowns and the style buttons all write one
 * undoable `edit-style` command. Two details make this more than a field
 * setter:
 *
 *  - **Original / Auto-fit / a number** are three different things. The size
 *    extracted from the PDF is kept in `originalFontSize`, so "Original" can
 *    always come back after an auto-fit or a manual override.
 *  - Every write re-measures the text against the original bbox, so an
 *    overflow is detected at the moment it is introduced — that is what the
 *    warning badges are made of.
 */

import { BUNDLED_FAMILIES } from '@/fonts'
import { createCanvasMeasurer, fitBlockText, measureBlock, type TextMeasurer } from './autofit'
import { idsForScope, loadEditorBlocks, patchTargets } from './blocks'
import { commandFrom, commitCommand, type IndexedBlock } from './commands'
import type { BlockPatch, EditScope, FontFamilyChoice, FontSizeChoice } from './types'

/** Sizes offered by the Font Size dropdown. */
export const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 72]

/** Families offered by the Font Family dropdown (all shipped with the app). */
export const FONT_FAMILY_CHOICES = [...BUNDLED_FAMILIES]

function textOf(block: IndexedBlock): string {
  return block.translatedText.length > 0 ? block.translatedText : block.sourceText
}

function boxOf(block: IndexedBlock): { width: number; height: number } {
  return { width: Math.max(1, block.width), height: Math.max(1, block.height) }
}

function fontOf(block: IndexedBlock): { fontFamily: string; bold: boolean; italic: boolean } {
  return { fontFamily: block.fontFamily, bold: block.bold, italic: block.italic }
}

/** Resolves a dropdown family choice onto this block's concrete family. */
export function resolveFamily(block: IndexedBlock, choice: FontFamilyChoice): string {
  return choice === 'original' ? block.originalFontFamily : choice
}

/**
 * The patch a size choice produces for one block — `null` when the block
 * already has that exact state (so a no-op apply writes nothing).
 * `fontFamily` overrides the block's own family (the dropdown may change both).
 */
export function sizePatch(
  block: IndexedBlock,
  choice: FontSizeChoice,
  measure: TextMeasurer,
  fontFamily = block.fontFamily,
): BlockPatch | null {
  const text = textOf(block)
  if (text.trim().length === 0) return null

  if (choice === 'original') {
    if (block.fontSizeMode === 'original' && block.fontSize === block.originalFontSize) return null
    return { fontSize: block.originalFontSize, fontSizeMode: 'original', overflow: false }
  }

  if (choice === 'auto') {
    const fitted = fitBlockText({
      text,
      box: boxOf(block),
      fontFamily,
      bold: block.bold,
      italic: block.italic,
      originalSize: block.originalFontSize,
      lineHeight: block.lineHeight,
      measure,
    })
    if (
      block.fontSizeMode === 'auto' &&
      block.fontSize === fitted.fontSize &&
      block.overflow === !fitted.fits
    ) {
      return null
    }
    return { fontSize: fitted.fontSize, fontSizeMode: 'auto', overflow: !fitted.fits }
  }

  const size = Math.max(1, Number(choice))
  const measured = measureBlock(text, boxOf(block), size, block.lineHeight, measure, {
    fontFamily,
    bold: block.bold,
    italic: block.italic,
  })
  const overflow = measured.width > block.width + 0.5 || measured.height > block.height + 0.5
  if (block.fontSizeMode === 'custom' && block.fontSize === size && block.overflow === overflow) {
    return null
  }
  return { fontSize: size, fontSizeMode: 'custom', overflow }
}

/** Does `block` measure outside its bbox when rendered with this family? */
function overflowFor(block: IndexedBlock, fontFamily: string, measure: TextMeasurer): boolean {
  const text = textOf(block)
  if (text.trim().length === 0) return block.overflow
  const measured = measureBlock(text, boxOf(block), block.fontSize, block.lineHeight, measure, {
    fontFamily,
    bold: block.bold,
    italic: block.italic,
  })
  return measured.width > block.width + 0.5 || measured.height > block.height + 0.5
}

export interface ApplyStyleOptions {
  projectId: string
  scope: EditScope
  selection?: string[] | undefined
  activePage?: number | null | undefined
  /** Static fields to write (colour, weight, alignment, line height). */
  patch?: BlockPatch | undefined
  /** Font Family dropdown — `'original'` restores the extracted family. */
  family?: FontFamilyChoice | undefined
  /** Font Size dropdown; omitted when the action does not touch the size. */
  size?: FontSizeChoice | undefined
  /** Test seam. */
  measure?: TextMeasurer | undefined
  labelKey?: string | undefined
}

export interface ApplyStyleResult {
  /** Blocks whose state actually changed. */
  changed: number
  /** Blocks that now measure outside their original bbox. */
  overflowed: number
}

/** Applies a style to the blocks the scope selects, as one undoable command. */
export async function applyBlockStyle(options: ApplyStyleOptions): Promise<ApplyStyleResult> {
  const measure = options.measure ?? createCanvasMeasurer()
  const blocks = await loadEditorBlocks(options.projectId)
  const ids = idsForScope(blocks, options.scope, {
    ...(options.selection ? { selection: options.selection } : {}),
    activePage: options.activePage ?? null,
  })

  const targets = patchTargets(blocks, ids, (block) => {
    const next: BlockPatch = { ...(options.patch ?? {}) }
    let family = block.fontFamily

    if (options.family !== undefined) {
      const resolved = resolveFamily(block, options.family)
      if (resolved !== block.fontFamily) {
        next.fontFamily = resolved
        family = resolved
      }
    }

    if (options.size !== undefined) {
      const sized = sizePatch(block, options.size, measure, family)
      if (sized) Object.assign(next, sized)
    } else if (next.fontFamily && next.fontFamily !== block.fontFamily) {
      // A different face can have different metrics: re-check the bbox so an
      // overflow warning appears the moment a wider family is applied.
      next.overflow = overflowFor(block, family, measure)
    }

    return next
  })

  if (targets.length > 0) {
    await commitCommand(
      commandFrom(options.labelKey ?? 'editor.cmd.style', 'edit-style', targets, 'user'),
    )
  }

  return {
    changed: targets.length,
    overflowed: targets.filter((target) => target.patch.overflow === true).length,
  }
}

/**
 * Blocks whose text measures outside their original bbox right now — the
 * source of the warning badges and of the export's overflow count.
 */
export function findOverflowing(blocks: IndexedBlock[], measure?: TextMeasurer): string[] {
  const probe = measure ?? createCanvasMeasurer()
  const out: string[] = []
  for (const block of blocks) {
    const text = textOf(block)
    if (text.trim().length === 0) continue
    const measured = measureBlock(
      text,
      boxOf(block),
      block.fontSize,
      block.lineHeight,
      probe,
      fontOf(block),
    )
    if (measured.width > block.width + 0.5 || measured.height > block.height + 0.5) {
      out.push(block.id)
    }
  }
  return out
}
