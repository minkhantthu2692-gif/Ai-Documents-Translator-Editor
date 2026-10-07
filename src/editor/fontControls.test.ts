import { describe, expect, it } from 'vitest'
import type { IndexedBlock } from './commands'
import { findOverflowing, sizePatch, FONT_FAMILY_CHOICES, FONT_SIZE_PRESETS } from './fontControls'
import type { TextMeasurer } from './autofit'

/** ~0.5 em average advance — deterministic, no canvas needed. */
const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize * 0.5

function block(overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  return {
    id: 'blk_1',
    projectId: 'prj_1',
    pageId: 'page_1',
    pageIndex: 0,
    order: 0,
    kind: 'paragraph',
    sourceText: 'Torque curve',
    translatedText: 'တာယာအား မှတ်တမ်း',
    x: 10,
    y: 20,
    width: 200,
    height: 40,
    fontFamily: 'Noto Sans',
    originalFontFamily: 'Noto Sans',
    fontSize: 12,
    originalFontSize: 12,
    lineHeight: 1.6,
    color: '#000000',
    bold: false,
    italic: false,
    characterCount: 20,
    region: 'body',
    alignment: 'left',
    lines: [],
    skipRule: null,
    placeholders: [],
    listMarker: null,
    translationConfidence: null,
    translationFlag: null,
    translatedAt: null,
    suggestedText: null,
    suggestedModel: null,
    suggestedAt: null,
    status: 'translated',
    fontSizeMode: 'original',
    overflow: false,
    createdAt: 0,
    updatedAt: 0,
    deviceId: 'dev',
    version: 1,
    ...overrides,
  }
}

describe('size choices', () => {
  it('returns null for "original" when nothing was ever changed', () => {
    expect(sizePatch(block(), 'original', measure)).toBeNull()
  })

  it('restores the extracted size after an auto-fit override', () => {
    const fitted = sizePatch(block({ fontSize: 8, fontSizeMode: 'auto' }), 'original', measure)
    expect(fitted).toEqual({ fontSize: 12, fontSizeMode: 'original', overflow: false })
  })

  it('auto-fit shrinks the size until the text fits the original box', () => {
    // 20 chars × size × 0.5 must fit 200pt wide / 40pt tall with lineHeight 1.6
    const patched = sizePatch(block({ fontSize: 40, originalFontSize: 40 }), 'auto', measure)
    expect(patched?.fontSizeMode).toBe('auto')
    expect(patched?.fontSize).toBeLessThan(40)
    expect(patched?.overflow).toBe(false)
  })

  it('reports overflow when even the smallest size does not fit', () => {
    const huge = block({
      width: 40,
      height: 12,
      lineHeight: 2,
      fontSize: 40,
      originalFontSize: 40,
      translatedText: 'a very long translation that cannot possibly fit in this box',
    })
    const patched = sizePatch(huge, 'auto', measure)
    expect(patched?.overflow).toBe(true)
  })

  it('marks a manual size as custom and detects its overflow', () => {
    const patched = sizePatch(block({ width: 60, height: 20 }), 48, measure)
    expect(patched).toEqual({ fontSize: 48, fontSizeMode: 'custom', overflow: true })
  })

  it('never changes a block that already has that state', () => {
    expect(sizePatch(block({ fontSize: 18, fontSizeMode: 'custom' }), 18, measure)).toBeNull()
    expect(
      sizePatch(block({ fontSize: 12, fontSizeMode: 'original' }), 'original', measure),
    ).toBeNull()
  })

  it('leaves blocks with no text alone', () => {
    expect(sizePatch(block({ translatedText: '', sourceText: ' ' }), 'auto', measure)).toBeNull()
  })
})

describe('findOverflowing', () => {
  it('flags only the blocks that measure outside their bbox', () => {
    const ok = block({ id: 'a', width: 400, height: 60 })
    const bad = block({ id: 'b', width: 40, height: 12, fontSize: 40, lineHeight: 2 })
    expect(findOverflowing([ok, bad], measure)).toEqual(['b'])
  })

  it('ignores empty blocks', () => {
    expect(findOverflowing([block({ translatedText: '', sourceText: '' })], measure)).toEqual([])
  })
})

describe('dropdown presets', () => {
  it('offers the bundled families and a sensible size ramp', () => {
    expect(FONT_FAMILY_CHOICES).toContain('Noto Sans Myanmar')
    expect(FONT_FAMILY_CHOICES).toContain('Padauk')
    expect(FONT_SIZE_PRESETS).toEqual([...FONT_SIZE_PRESETS].sort((a, b) => a - b))
    expect(FONT_SIZE_PRESETS).toContain(11)
  })
})
