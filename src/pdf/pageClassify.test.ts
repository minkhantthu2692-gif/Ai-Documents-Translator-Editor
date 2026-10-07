import { describe, expect, it } from 'vitest'
import {
  MIN_TEXT_CHARS,
  MIN_TEXT_COVERAGE,
  classifyPage,
  coverageOf,
  emptyTally,
  hasTextLayer,
  pagesNeedingOcr,
  tallyPages,
} from './pageClassify'

describe('coverageOf', () => {
  it('sums item rectangles against the page area', () => {
    const items = [
      { width: 100, height: 10 },
      { width: 50, height: 10 },
    ]
    // 1000 + 500 square points of ink on a 100×100 page.
    expect(coverageOf(items, 10_000)).toBeCloseTo(0.15, 5)
  })

  it('caps at 1 when rectangles overlap the page', () => {
    expect(coverageOf([{ width: 200, height: 200 }], 100)).toBe(1)
  })

  it('is 0 for a degenerate page or non-finite sizes', () => {
    expect(coverageOf([{ width: 10, height: 10 }], 0)).toBe(0)
    expect(coverageOf([{ width: Number.NaN, height: 10 }], 100)).toBe(0)
    expect(coverageOf([{ width: -5, height: -5 }], 100)).toBe(0)
  })
})

describe('hasTextLayer', () => {
  it('rejects pages that only carry a page label', () => {
    // "Page 7" is 5 non-space characters below the coverage bar.
    expect(hasTextLayer({ charCount: 5, textCoverage: 0.0005, imageCount: 0 })).toBe(false)
  })

  it('accepts a page with real body text', () => {
    expect(hasTextLayer({ charCount: 1200, textCoverage: 0.18, imageCount: 0 })).toBe(true)
  })

  it('needs both the character and the coverage bar', () => {
    expect(
      hasTextLayer({ charCount: 5000, textCoverage: MIN_TEXT_COVERAGE / 2, imageCount: 0 }),
    ).toBe(false)
    expect(hasTextLayer({ charCount: MIN_TEXT_CHARS - 1, textCoverage: 0.5, imageCount: 0 })).toBe(
      false,
    )
  })
})

describe('classifyPage', () => {
  it('marks image-only pages as scanned', () => {
    expect(classifyPage({ charCount: 0, textCoverage: 0, imageCount: 3 })).toBe('scanned')
  })

  it('marks a page with neither text nor images as empty', () => {
    expect(classifyPage({ charCount: 0, textCoverage: 0, imageCount: 0 })).toBe('empty')
  })

  it('marks plain text pages as text', () => {
    expect(classifyPage({ charCount: 900, textCoverage: 0.2, imageCount: 0 })).toBe('text')
  })

  it('marks pages that combine a text layer and images as mixed', () => {
    expect(classifyPage({ charCount: 900, textCoverage: 0.05, imageCount: 2 })).toBe('mixed')
  })

  it('treats stray characters without an image as text', () => {
    expect(classifyPage({ charCount: 2, textCoverage: 0, imageCount: 0 })).toBe('text')
  })

  it('keeps the thresholds exported for the UI copy', () => {
    expect(MIN_TEXT_CHARS).toBeGreaterThan(0)
    expect(MIN_TEXT_COVERAGE).toBeGreaterThan(0)
    expect(MIN_TEXT_COVERAGE).toBeLessThan(1)
  })
})

describe('tallyPages', () => {
  it('counts every class and reports the OCR workload', () => {
    const tally = tallyPages(['text', 'scanned', 'scanned', 'mixed', 'empty', 'text'])
    expect(tally).toEqual({ text: 2, scanned: 2, mixed: 1, empty: 1 })
    expect(pagesNeedingOcr(tally)).toBe(2)
    expect(emptyTally()).toEqual({ text: 0, scanned: 0, mixed: 0, empty: 0 })
  })
})
