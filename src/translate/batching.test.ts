/**
 * Batch construction: sizes, derived ids, a stable order — and the structure
 * rules that decide where a batch is allowed to end.
 */
import { describe, expect, it } from 'vitest'
import type { Placeholder } from '@/pdf/placeholders'
import {
  BATCH_DEFAULTS,
  buildBatches,
  buildUnits,
  countLines,
  splitBatch,
  splitLineForRetry,
  splitToLines,
} from './batching'
import { estimateTokens } from './tokenEstimate'
import type { BatchLine, TranslationBatch } from './types'

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
    kind: 'paragraph' as const,
    placeholders: [],
  }))
}

/** Same shape as `lines`, but with an explicit per-line structure. */
function structured(kinds: Array<BatchLine['kind']>): BatchLine[] {
  return kinds.map((kind, index) => ({
    id: `blk_${index}`,
    text: `${kind} ${index}`,
    pageIndex: 0,
    order: index,
    listMarker: kind === 'list' ? '•' : null,
    kind,
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

describe('buildUnits — where a batch is allowed to end', () => {
  it('binds a heading forward and a caption backward, everything else alone', () => {
    const units = buildUnits(
      structured(['paragraph', 'heading', 'paragraph', 'table', 'table', 'caption']),
    )

    expect(units.map((unit) => unit.map((line) => line.kind))).toEqual([
      ['paragraph'],
      ['heading', 'paragraph'],
      ['table', 'table', 'caption'],
    ])
    // Units are a regrouping, never a reorder.
    expect(units.flat().map((line) => line.id)).toEqual([
      'blk_0',
      'blk_1',
      'blk_2',
      'blk_3',
      'blk_4',
      'blk_5',
    ])
  })

  it('leaves consecutive ordinary paragraphs as their own units', () => {
    expect(buildUnits(lines(4))).toHaveLength(4)
    expect(buildUnits([])).toEqual([])
  })

  it('keeps a note with the passage it marks instead of opening a batch', () => {
    // The note is filed directly under that passage, so one request that sees
    // both translates the second in the light of the first — and it must not
    // drift onto the paragraph *after* it, which has nothing to do with it.
    const units = buildUnits(structured(['paragraph', 'annotation', 'paragraph']))
    expect(units.map((unit) => unit.map((line) => line.kind))).toEqual([
      ['paragraph', 'annotation'],
      ['paragraph'],
    ])
  })
})

describe('structure-aware packing', () => {
  it('never strands a heading at the end of a batch — it travels with its body', () => {
    // Three lines a batch: without units the heading would open batch 0 and be
    // left trailing it, so batch 1 would be translated without its section title.
    const source = structured(['paragraph', 'paragraph', 'heading', 'paragraph'])
    const batches = buildBatches('proj', EPOCH, 0, source, { maxLines: 3 })

    expect(batches.map((batch) => batch.lines.map((line) => line.kind))).toEqual([
      ['paragraph', 'paragraph'],
      ['heading', 'paragraph'],
    ])
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
  })

  it('keeps a caption with the figure it labels instead of opening a batch', () => {
    const source = structured(['paragraph', 'caption', 'paragraph'])
    const batches = buildBatches('proj', EPOCH, 0, source, { maxLines: 2 })

    expect(batches.map((batch) => batch.lines.map((line) => line.kind))).toEqual([
      ['paragraph', 'caption'],
      ['paragraph'],
    ])
  })

  it('keeps a run of table rows together, cutting only between rows', () => {
    const source = structured(['paragraph', 'table', 'table', 'table'])
    const batches = buildBatches('proj', EPOCH, 0, source, { maxLines: 2 })

    // Without units this would be [paragraph, table] / [table, table] — the run
    // cut open. Now the lone paragraph pays for keeping the table intact.
    expect(batches.map((batch) => batch.lines.map((line) => line.kind))).toEqual([
      ['paragraph'],
      ['table', 'table'],
      ['table'],
    ])
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
  })

  it('keeps list items together as one run', () => {
    const source = structured(['list', 'list', 'list', 'list'])
    const batches = buildBatches('proj', EPOCH, 0, source, { maxLines: 3 })

    expect(batches.map((batch) => batch.lines.length)).toEqual([3, 1])
    expect(batches[0].lines.every((line) => line.kind === 'list')).toBe(true)
  })

  it('subdivides a unit that cannot fit, never pushing a batch past the budget', () => {
    // Four table rows of ~500 tokens each into a 1200-token budget: the run is
    // cut between rows, and no batch overshoots.
    const source = Array.from({ length: 4 }, (_, index) => ({
      id: `row_${index}`,
      text: 'cell '.repeat(300),
      pageIndex: 0,
      order: index,
      listMarker: null,
      kind: 'table' as const,
      placeholders: [],
    }))
    const batches = buildBatches('proj', EPOCH, 0, source, { maxTokens: 1200 })

    expect(batches.map((batch) => batch.lines.length)).toEqual([2, 2])
    for (const batch of batches) {
      expect(batch.tokens).toBeLessThanOrEqual(1200)
      expect(batch.lines.every((line) => line.kind === 'table')).toBe(true)
    }
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
  })

  it('still honours the token budget for ordinary prose mixed with structure', () => {
    const source = structured([
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ])
    const perLine = estimateTokens('paragraph 1')
    const maxTokens = perLine * 2
    const batches = buildBatches('proj', EPOCH, 0, source, { maxTokens, maxLines: 25 })

    for (const batch of batches) expect(batch.tokens).toBeLessThanOrEqual(maxTokens)
    expect(batches.flatMap((batch) => batch.lines.map((line) => line.id))).toEqual(
      source.map((line) => line.id),
    )
    // The heading still leads the batch that carries its body.
    expect(batches[0].lines[0].kind).toBe('heading')
  })
})

describe('splitLineForRetry (the last resort for one line)', () => {
  function single(
    kind: BatchLine['kind'],
    text: string,
    placeholders: Placeholder[] = [],
  ): TranslationBatch {
    return {
      id: 'proj#1#0#0',
      pageIndex: 0,
      index: 0,
      tokens: estimateTokens(text),
      lines: [{ id: 'blk_0', text, pageIndex: 0, order: 0, listMarker: null, kind, placeholders }],
    }
  }

  it('cuts prose at sentence boundaries, keeping each terminator with its sentence', () => {
    const split = splitLineForRetry(single('paragraph', 'One is done. Two is done. Three is done.'))

    expect(split?.separator).toBe(' ')
    expect(split?.lines.map((entry) => entry.text)).toEqual([
      'One is done.',
      'Two is done.',
      'Three is done.',
    ])
    expect(split?.lines.map((entry) => entry.id)).toEqual(['blk_0#s0', 'blk_0#s1', 'blk_0#s2'])
    expect(split?.parent.id).toBe('blk_0')
    expect(split?.batch.id).toBe('proj#1#0#0#s')
    expect(split?.batch.lines).toHaveLength(3)
    expect(split?.lines.every((entry) => entry.kind === 'paragraph')).toBe(true)
  })

  it('splits a table at row boundaries and rejoins with a newline', () => {
    const split = splitLineForRetry(single('table', 'a | b\nc | d\ne | f'))

    expect(split?.separator).toBe('\n')
    expect(split?.lines.map((entry) => entry.text)).toEqual(['a | b', 'c | d', 'e | f'])
    expect(split?.lines.map((entry) => entry.kind)).toEqual(['table', 'table', 'table'])
  })

  it('splits a list at item boundaries', () => {
    const split = splitLineForRetry(single('list', 'first item\nsecond item'))
    expect(split?.separator).toBe('\n')
    expect(split?.lines.map((entry) => entry.text)).toEqual(['first item', 'second item'])
  })

  it('returns null for a line that has nothing to cut', () => {
    // These are the terminal cases the ladder already handled by keeping the
    // source text — the split must not change their behaviour.
    expect(splitLineForRetry(single('paragraph', 'no sentence ends here'))).toBeNull()
    expect(splitLineForRetry(single('paragraph', 'Just one sentence.'))).toBeNull()
    expect(splitLineForRetry(single('paragraph', ''))).toBeNull()
    expect(splitLineForRetry(single('table', 'only one row'))).toBeNull()
    expect(splitLineForRetry(single('list', 'only one item'))).toBeNull()
  })

  it('is rejected outright for anything but a single-line batch', () => {
    const [batch] = buildBatches('proj', EPOCH, 0, lines(3))
    expect(splitLineForRetry(batch)).toBeNull()
  })

  it('keeps only the placeholders that live in each fragment', () => {
    const placeholders: Placeholder[] = [
      { token: '{{0}}', kind: 'existing', original: 'Alpha' },
      { token: '{{1}}', kind: 'existing', original: 'Beta' },
    ]
    const split = splitLineForRetry(
      single('paragraph', 'Keep {{0}} here. Keep {{1}} there.', placeholders),
    )

    expect(split?.lines.map((entry) => entry.placeholders.map((p) => p.token))).toEqual([
      ['{{0}}'],
      ['{{1}}'],
    ])
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
