/**
 * Batch construction: sizes, derived ids and a stable order.
 */
import { describe, expect, it } from 'vitest'
import { BATCH_DEFAULTS, buildBatches, countLines, splitBatch, splitToLines } from './batching'
import { estimateTokens } from './tokenEstimate'
import type { BatchLine } from './types'

const EPOCH = 1_700_000_000_000
/** Historic soft minimum — batches are still at least this big when they fit. */
const MIN_LINES = 15

function lines(count: number, chars = 12): BatchLine[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `blk_${index}`,
    text: 'x'.repeat(chars),
    pageIndex: 0,
    order: index,
    listMarker: null,
    placeholders: [],
  }))
}

describe('buildBatches', () => {
  it('cuts a page into batches of 15–25 lines without reordering a single line', () => {
    const source = lines(60)
    const batches = buildBatches('proj', EPOCH, 0, source)

    expect(batches.map((batch) => batch.lines.length)).toEqual([25, 25, 10])
    for (const batch of batches.slice(0, -1)) {
      expect(batch.lines.length).toBeGreaterThanOrEqual(MIN_LINES)
      expect(batch.lines.length).toBeLessThanOrEqual(BATCH_DEFAULTS.maxLines)
    }
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
    expect(countLines(batches)).toBe(60)
  })

  it('keeps every batch at or below the 1500-token budget', () => {
    // 270 chars ≈ 90 tokens a line: 16 lines would cross the budget.
    const source = lines(40, 270)
    const batches = buildBatches('proj', EPOCH, 0, source)

    for (const batch of batches) {
      expect(batch.tokens).toBeLessThanOrEqual(BATCH_DEFAULTS.maxTokens)
      expect(batch.lines.length).toBeLessThanOrEqual(BATCH_DEFAULTS.maxLines)
    }
    expect(batches.slice(0, -1).every((batch) => batch.lines.length >= MIN_LINES)).toBe(true)
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
  })

  it('lets the token budget win over the line floor for long lines', () => {
    // Before the budget was enforced unconditionally, a batch could only flush
    // on tokens once it held `MIN_LINES` lines — so 14 long lines shipped as
    // one oversized request. Now the budget cuts first.
    const longLines = 200
    const source = lines(30, longLines * 3)
    const perLine = estimateTokens('x'.repeat(longLines * 3))
    const maxTokens = perLine * 5 // five long lines per request, no more
    const batches = buildBatches('proj', EPOCH, 0, source, { maxTokens })

    for (const batch of batches) {
      expect(batch.lines.length).toBeLessThanOrEqual(5)
      if (batch.lines.length > 1) expect(batch.tokens).toBeLessThanOrEqual(maxTokens)
    }
    expect(batches[0].lines.length).toBe(5)
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
  })

  it('still sends a single line that alone exceeds the budget', () => {
    const source = lines(3, 9_000) // ~3000 tokens a line
    const batches = buildBatches('proj', EPOCH, 0, source, { maxTokens: 500 })

    expect(batches.map((batch) => batch.lines.length)).toEqual([1, 1, 1])
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
  })

  it('derives ids as project#epoch#page#index — never random', () => {
    const source = lines(60)
    const first = buildBatches('proj', EPOCH, 7, source)
    const second = buildBatches('proj', EPOCH, 7, source)

    expect(first.map((batch) => batch.id)).toEqual([
      `proj#${EPOCH}#7#0`,
      `proj#${EPOCH}#7#1`,
      `proj#${EPOCH}#7#2`,
    ])
    expect(first.map((batch) => batch.id)).toEqual(second.map((batch) => batch.id))
    expect(first.map((batch) => batch.index)).toEqual([0, 1, 2])
    expect(first.every((batch) => batch.pageIndex === 7)).toBe(true)

    const otherPage = buildBatches('proj', EPOCH, 8, source)
    expect(otherPage[0].id).toBe(`proj#${EPOCH}#8#0`)
  })

  it('leaves a short page as a single batch', () => {
    const batches = buildBatches('proj', EPOCH, 0, lines(9))
    expect(batches).toHaveLength(1)
    expect(batches[0].id).toBe(`proj#${EPOCH}#0#0`)
  })
})

describe('splitBatch (the first ladder step)', () => {
  it('halves a batch, keeping both halves in input order', () => {
    const [batch] = buildBatches('proj', EPOCH, 0, lines(9))
    const halves = splitBatch(batch)

    expect(halves).toHaveLength(2)
    expect(halves[0].id).toBe(`${batch.id}#0`)
    expect(halves[1].id).toBe(`${batch.id}#1`)
    expect(halves[0].lines.map((line) => line.id)).toEqual([
      'blk_0',
      'blk_1',
      'blk_2',
      'blk_3',
      'blk_4',
    ])
    expect(halves[1].lines.map((line) => line.id)).toEqual(['blk_5', 'blk_6', 'blk_7', 'blk_8'])
    expect([...halves[0].lines, ...halves[1].lines].map((line) => line.id)).toEqual(
      batch.lines.map((line) => line.id),
    )
    expect(halves[0].tokens + halves[1].tokens).toBe(batch.tokens)
  })

  it('cannot halve a single line', () => {
    const [batch] = buildBatches('proj', EPOCH, 0, lines(1))
    expect(splitBatch(batch)).toEqual([])
  })
})

describe('splitToLines (the last ladder step)', () => {
  it('produces exactly one line per request with derived ids, in input order', () => {
    const [batch] = buildBatches('proj', EPOCH, 0, lines(4))
    const singles = splitToLines(batch)

    expect(singles.map((single) => single.id)).toEqual([
      `${batch.id}#l0`,
      `${batch.id}#l1`,
      `${batch.id}#l2`,
      `${batch.id}#l3`,
    ])
    expect(singles.every((single) => single.lines.length === 1)).toBe(true)
    expect(singles.map((single) => single.lines[0].id)).toEqual(batch.lines.map((line) => line.id))
    expect(singles.map((single) => single.pageIndex)).toEqual([0, 0, 0, 0])
  })
})

describe('countLines', () => {
  it('totals lines across a set of batches (progress reporting)', () => {
    const batches = buildBatches('proj', EPOCH, 0, lines(40))
    expect(countLines(batches)).toBe(40)
    expect(countLines([])).toBe(0)
  })
})
