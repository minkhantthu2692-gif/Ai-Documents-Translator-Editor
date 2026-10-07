/**
 * Page content classification.
 *
 * Turns the raw signals a page produces (text layer, coverage, painted images)
 * into the coarse class the rest of the app acts on:
 *
 *   `text`    — a usable text layer, translate directly
 *   `scanned` — images only, OCR required before translation
 *   `mixed`   — text layer *and* images (figures, half-scanned pages)
 *   `empty`   — nothing on the page at all
 *
 * Pure functions so the thresholds can be unit-tested without pdf.js.
 */

import type { PageContentClass } from '@/db/types'

export interface PageSignal {
  /** Non-whitespace characters found in the text layer. */
  charCount: number
  /** Share of the page covered by text rectangles, 0..1. */
  textCoverage: number
  /** Painted image operations on the page. */
  imageCount: number
}

/**
 * A page counts as "has text" when it carries at least this many characters
 * *and* its text rectangles cover a non-trivial slice of the page. Page labels
 * alone (`Page 12`) clear the character bar but never the coverage bar.
 */
export const MIN_TEXT_CHARS = 8
export const MIN_TEXT_COVERAGE = 0.002

/** Area covered by text items / page area, capped at 1. */
export function coverageOf(
  items: Array<{ width: number; height: number }>,
  pageArea: number,
): number {
  if (pageArea <= 0) return 0
  let area = 0
  for (const item of items) {
    const width = Number.isFinite(item.width) ? Math.max(0, item.width) : 0
    const height = Number.isFinite(item.height) ? Math.max(0, item.height) : 0
    area += width * height
  }
  return Math.min(1, area / pageArea)
}

export function hasTextLayer(signal: PageSignal): boolean {
  return signal.charCount >= MIN_TEXT_CHARS && signal.textCoverage >= MIN_TEXT_COVERAGE
}

export function classifyPage(signal: PageSignal): PageContentClass {
  const text = hasTextLayer(signal)
  const images = signal.imageCount > 0

  if (text) return images ? 'mixed' : 'text'
  if (images) return 'scanned'
  // A handful of stray characters (or nothing at all) with no image.
  return signal.charCount > 0 ? 'text' : 'empty'
}

/** Aggregated counters used by the pre-flight summary. */
export interface ContentTally {
  text: number
  scanned: number
  mixed: number
  empty: number
}

export function emptyTally(): ContentTally {
  return { text: 0, scanned: 0, mixed: 0, empty: 0 }
}

export function tallyPages(classes: Iterable<PageContentClass>): ContentTally {
  const tally = emptyTally()
  for (const value of classes) tally[value] += 1
  return tally
}

/** Pages whose text layer is missing → these are the pages OCR must cover. */
export function pagesNeedingOcr(tally: ContentTally): number {
  return tally.scanned
}
