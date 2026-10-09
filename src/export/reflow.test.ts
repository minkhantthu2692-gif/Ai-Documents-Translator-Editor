/**
 * Reflow acceptance: what the export does with a block auto-fit could not
 * shrink back into its box. Every case below is written so the arithmetic can
 * be checked by hand against the deterministic measurer — 'word ' is five
 * characters, so one token is 30pt wide at 12pt and a 468pt column holds
 * fifteen of them, which makes the wrapped line count exact.
 */
import { describe, expect, it } from 'vitest'
import type { TextMeasurer } from '@/editor/autofit'
import { listPrefix } from './shared'
import { reflowBlocks, type ReflowOptions } from './reflow'
import type { ExportBlock } from './types'

/** ~0.5 em average advance — deterministic, no canvas needed. */
const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize * 0.5

const LINE = 19.2 // 12pt × 1.6

/** `n` space-separated words: `wrapLines` cannot break a single long token. */
function words(n: number): string {
  return Array.from({ length: n }, () => 'word').join(' ')
}

function block(overrides: Partial<ExportBlock> = {}): ExportBlock {
  return {
    id: 'blk_1',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 72,
    y: 72,
    width: 468,
    height: LINE,
    fontFamily: 'Noto Sans',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#111827',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    links: [],
    sourceText: 'Source text',
    translatedText: words(4),
    characterCount: 11,
    skipRule: null,
    placeholders: [],
    direction: 'ltr',
    fittedFontSize: null,
    overflow: false,
    hasSuggestion: false,
    ...overrides,
  }
}

const options: ReflowOptions<ExportBlock> = {
  measure,
  pageHeight: 792,
  textOf: (b) => b.translatedText,
}

function topOf(blocks: ExportBlock[], id: string): number {
  const found = blocks.find((b) => b.id === id)
  if (!found) throw new Error(`no block ${id}`)
  return found.y
}

describe('reflowBlocks', () => {
  it('changes nothing when every block still fits the box it was given', () => {
    const a = block({ id: 'a' })
    const b = block({ id: 'b', y: 95 })
    const out = reflowBlocks([a, b], options)
    expect(topOf(out, 'a')).toBe(72)
    expect(topOf(out, 'b')).toBe(95)
    // Untouched blocks come back as the very same objects.
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
  })

  it('pushes the block below down by exactly the growth, keeping the gap', () => {
    // Twenty words need two lines at 12pt — 38.4pt in a 19.2pt box.
    const a = block({ id: 'a', translatedText: words(20) })
    const b = block({ id: 'b', y: 95 })
    const out = reflowBlocks([a, b], options)
    expect(topOf(out, 'a')).toBe(72)
    expect(topOf(out, 'b')).toBe(110.4)
    // 95 − (72 + 19.2) = 3.8pt of original air, still there.
    expect(topOf(out, 'b') - (72 + 38.4)).toBeCloseTo(0)
  })

  it('chains: growth in one block moves everything stacked under it', () => {
    const out = reflowBlocks(
      [
        block({ id: 'a', translatedText: words(20) }),
        block({ id: 'b', y: 95, translatedText: words(20) }),
        block({ id: 'c', y: 118 }),
      ],
      options,
    )
    expect(topOf(out, 'a')).toBe(72)
    expect(topOf(out, 'b')).toBe(110.4)
    expect(topOf(out, 'c')).toBe(148.8)
  })

  it('leaves the other column alone', () => {
    const a = block({ id: 'a', translatedText: words(20) })
    const side = block({ id: 'side', x: 560, width: 40 })
    const below = block({ id: 'below', y: 95 })
    const out = reflowBlocks([a, side, below], options)
    expect(topOf(out, 'side')).toBe(72)
    expect(topOf(out, 'below')).toBe(110.4)
  })

  it('moves both columns under a full-width band that grew', () => {
    const band = block({ id: 'band', translatedText: words(20) })
    const left = block({ id: 'left', y: 100, width: 220 })
    const right = block({ id: 'right', y: 100, x: 320, width: 220 })
    const out = reflowBlocks([band, left, right], options)
    expect(topOf(out, 'left')).toBe(110.4)
    expect(topOf(out, 'right')).toBe(110.4)
  })

  it('does not let one column push the other sideways', () => {
    const band = block({ id: 'band' })
    const left = block({ id: 'left', y: 100, width: 220, translatedText: words(20) })
    const right = block({ id: 'right', y: 100, x: 320, width: 220 })
    const out = reflowBlocks([band, left, right], options)
    expect(topOf(out, 'left')).toBe(100)
    expect(topOf(out, 'right')).toBe(100)
  })

  it('stops at the page edge instead of printing half a block onto the next sheet', () => {
    // The push would land the second block at 788.4, past the 792pt page, so
    // it stays exactly where the PDF put it.
    const a = block({ id: 'a', y: 750, translatedText: words(20) })
    const b = block({ id: 'b', y: 773 })
    const out = reflowBlocks([a, b], options)
    expect(topOf(out, 'a')).toBe(750)
    expect(topOf(out, 'b')).toBe(773)
  })

  it('names the blocks the page edge stopped it from clearing', () => {
    const a = block({ id: 'a', y: 750, translatedText: words(20) })
    const b = block({ id: 'b', y: 773 })
    const c = block({ id: 'c', y: 95, order: 1 })
    const clipped: string[] = []
    reflowBlocks([a, b, c], {
      ...options,
      onOverlap: (placed) => clipped.push(placed.id),
    })
    // b is still under a, and only b: c had all the room in the world.
    expect(clipped).toEqual(['b'])
  })

  it('says nothing when every block clears', () => {
    const a = block({ id: 'a', translatedText: words(20) })
    const b = block({ id: 'b', y: 95 })
    const clipped: string[] = []
    reflowBlocks([a, b], { ...options, onOverlap: (placed) => clipped.push(placed.id) })
    expect(clipped).toEqual([])
  })

  it('does not report an overlap the source already had', () => {
    // Nothing was pushed, so nothing was "stopped" — the report is about the
    // clamp giving back room, not about the PDF's own geometry.
    const a = block({ id: 'a', height: 40, translatedText: words(20) })
    const b = block({ id: 'b', y: 105 })
    const clipped: string[] = []
    reflowBlocks([a, b], { ...options, onOverlap: (placed) => clipped.push(placed.id) })
    expect(clipped).toEqual([])
  })

  it('never moves a block up to make room', () => {
    const tall = block({ id: 'tall', y: 760, translatedText: words(20) })
    const out = reflowBlocks([tall], options)
    expect(topOf(out, 'tall')).toBe(760)
  })

  it('measures the text the builder will actually print', () => {
    const a = block({ id: 'a', translatedText: words(4) })
    const b = block({ id: 'b', y: 95 })
    const out = reflowBlocks([a, b], { ...options, textOf: () => words(20) })
    expect(topOf(out, 'b')).toBe(110.4)
  })

  it('never tries to repair an overlap the source already had', () => {
    // This box already reaches past the block below it in the PDF. Growing it
    // further is a layout question for the reader, not something a push-down
    // can silently answer — so reflow leaves both exactly where they are.
    const a = block({ id: 'a', height: 40, translatedText: words(20) })
    const b = block({ id: 'b', y: 105 })
    expect(topOf(reflowBlocks([a, b], options), 'b')).toBe(105)
  })

  it("carries a pushed block's whole box, not just the text inside it", () => {
    // b is a 40pt box holding one line; once a grows, b is pushed down and its
    // *box* — not its single line — is what the block under it has to clear.
    const a = block({ id: 'a', translatedText: words(20) })
    const b = block({ id: 'b', y: 95, height: 40, translatedText: 'word' })
    const c = block({ id: 'c', y: 150 })
    expect(topOf(reflowBlocks([a, b, c], options), 'c')).toBe(150.4)
  })

  it('counts the prefix the builder puts in front of a list item', () => {
    // Fifteen words fit a 468pt line on their own; the marker's own width is
    // what tips the last word onto a second line.
    const marked = block({ id: 'marked', listMarker: '123.', translatedText: words(15) })
    const plain = block({ id: 'plain', translatedText: words(15) })
    const withMarker: ReflowOptions<ExportBlock> = {
      ...options,
      textOf: (b) => `${listPrefix(b, b.translatedText)}${b.translatedText}`,
    }
    expect(topOf(reflowBlocks([marked, block({ id: 'below', y: 95 })], withMarker), 'below')).toBe(
      110.4,
    )
    expect(topOf(reflowBlocks([plain, block({ id: 'below', y: 95 })], withMarker), 'below')).toBe(
      95,
    )
  })

  it('ignores a block with no bbox, which has no layout to move or be moved by', () => {
    const a = block({ id: 'a', width: 0, translatedText: words(20) })
    const b = block({ id: 'b', y: 95 })
    const out = reflowBlocks([a, b], options)
    expect(topOf(out, 'b')).toBe(95)
  })

  it('returns the input untouched when there is no page to overflow', () => {
    const a = block({ id: 'a', y: 760, translatedText: words(20) })
    expect(topOf(reflowBlocks([a], { ...options, pageHeight: 0 }), 'a')).toBe(760)
  })
})
