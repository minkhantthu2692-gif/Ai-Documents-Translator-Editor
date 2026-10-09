import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type { TextMeasurer } from './autofit'
import { autoFitEnabled, translationLayoutPatch, type LayoutBlock } from './layout'

/** ~0.5 em average advance — deterministic, no canvas needed. */
const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize * 0.5

/** `n` space-separated words: `wrapLines` cannot break a single long token. */
function words(n: number): string {
  return Array.from({ length: n }, () => 'word').join(' ')
}

function block(overrides: Partial<LayoutBlock> = {}): LayoutBlock {
  return {
    width: 200,
    height: 40,
    fontFamily: 'Noto Sans',
    bold: false,
    italic: false,
    lineHeight: 1.6,
    fontSize: 12,
    originalFontSize: 12,
    fontSizeMode: 'original',
    overflow: false,
    ...overrides,
  }
}

/** Applies a patch the way the write path does, so a re-fit can be re-run. */
function after(base: LayoutBlock, patch: Record<string, unknown> | null): LayoutBlock {
  return { ...base, ...(patch ?? {}) } as LayoutBlock
}

describe('translationLayoutPatch', () => {
  it('leaves a translation that already fits completely alone', () => {
    expect(translationLayoutPatch(block(), words(6), measure)).toBeNull()
  })

  it('steps the size down until the grown translation fits the original box', () => {
    // Fourteen words need three lines at 12pt (57.6pt) inside a 40pt box.
    const patch = translationLayoutPatch(block(), words(14), measure)
    expect(patch?.fontSizeMode).toBe('auto')
    expect(patch?.fontSize).toBeLessThan(12)
    expect(patch?.fontSize).toBeGreaterThanOrEqual(6)
    expect(after(block(), patch).overflow).toBe(false)
  })

  it('gives the size back when a later translation is shorter again', () => {
    const shrunk = block({ fontSize: 8, fontSizeMode: 'auto' })
    expect(translationLayoutPatch(shrunk, words(6), measure)).toMatchObject({
      fontSize: 12,
      fontSizeMode: 'auto',
    })
  })

  it('never shrinks past the floor — it keeps the document size and flags it', () => {
    // 40×12pt at lineHeight 2 holds one 6pt line; six words need two.
    const tooSmall = block({
      width: 40,
      height: 12,
      lineHeight: 2,
      fontSize: 8,
      originalFontSize: 40,
      fontSizeMode: 'auto',
    })
    const patch = translationLayoutPatch(tooSmall, words(6), measure)
    expect(patch?.fontSize).toBe(40)
    expect(patch?.overflow).toBe(true)
  })

  it('flags the overflow without touching the size it cannot improve', () => {
    const tooSmall = block({ width: 40, height: 12, lineHeight: 2 })
    expect(translationLayoutPatch(tooSmall, words(6), measure)).toEqual({ overflow: true })
  })

  it('never resizes a size the reader pinned, only re-checks the warning', () => {
    const pinned = block({ fontSize: 18, fontSizeMode: 'custom' })
    const patch = translationLayoutPatch(pinned, words(14), measure)
    expect(patch).toEqual({ overflow: true })
    // …and nothing at all when the warning was already right.
    expect(translationLayoutPatch({ ...pinned, overflow: true }, words(14), measure)).toBeNull()
  })

  it('clears a warning left behind by text that has since been emptied', () => {
    expect(translationLayoutPatch(block({ overflow: true }), '', measure)).toEqual({
      overflow: false,
    })
    expect(translationLayoutPatch(block(), '', measure)).toBeNull()
  })

  it('ignores a block that has no box to fit into', () => {
    expect(translationLayoutPatch(block({ width: 0, height: 0 }), words(6), measure)).toBeNull()
    expect(translationLayoutPatch(block({ originalFontSize: 0 }), words(6), measure)).toBeNull()
  })

  it('is idempotent, so a retry of the same batch writes nothing', () => {
    const base = block()
    const first = translationLayoutPatch(base, words(14), measure)
    expect(first).not.toBeNull()
    const applied = after(base, first)
    expect(translationLayoutPatch(applied, words(14), measure)).toBeNull()
  })
})

describe('autoFitEnabled', () => {
  it('defaults to on and follows the switch', async () => {
    expect(await autoFitEnabled()).toBe(true)
    await settingsRepo.set(SETTING_KEYS.autoFit, false, 'layout')
    expect(await autoFitEnabled()).toBe(false)
    await settingsRepo.remove(SETTING_KEYS.autoFit)
    expect(await autoFitEnabled()).toBe(true)
  })
})
