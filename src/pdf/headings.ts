/**
 * Heading hierarchy.
 *
 * `structurePage` decides *whether* a block is a heading — larger than the
 * page's body median and short enough to be a title rather than a paragraph
 * set big. This module decides *how deep* it is, and a depth is only
 * meaningful against the other headings around it.
 *
 * Those others are mostly on other pages: a chapter title appears once, and
 * every page after it carries only the sections beneath it. Ranking the sizes
 * of a single page therefore turns `3.2 Methods` into a level-1 heading on
 * every page that does not also hold its chapter. The ladder is built
 * document-wide instead, during the probe — the same channel running heads and
 * feet already travel down (`ProbeSummary` → `ProjectAnalysis` → the extract
 * request) — and a page with no ladder falls back to its own headings, which
 * is what keeps `structurePage` a pure function a test can call on literals.
 *
 * Two sizes that agree to within 5% are one level. A PDF that has been through
 * a converter hands back 14.0 on one page and 14.2 on the next, and spending a
 * level on the difference would push every real level below it down one.
 */

import { medianFontSize, type GroupedLine } from './lineGrouping'

/** Deepest heading any format can render (`<h6>`, `HeadingLevel.HEADING_6`). */
export const MAX_HEADING_LEVEL = 6

/** Longer than this and a large line is body text, not a title. */
const HEADING_MAX_CHARS = 140

/** Matches the `sizeRatio >= 1.05` arm of the heading rule in `structurePage`. */
const HEADING_MIN_RATIO = 1.05

/** Sizes are compared at 0.1pt — finer than any font size a PDF reports. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** One line of a page, judged against that page's own body size. */
function isHeadingLine(line: GroupedLine, medianSize: number): boolean {
  if (medianSize <= 0 || line.style.fontSize <= 0) return false
  if (line.style.fontSize / medianSize < HEADING_MIN_RATIO) return false
  return line.text.replace(/\s+/g, ' ').trim().length <= HEADING_MAX_CHARS
}

/**
 * Font sizes that look like headings on one page.
 *
 * The reference is this page's own median, because body text differs between
 * documents (10pt in one, 18pt in a slide deck) and the ladder has to be built
 * from *relative* prominence before it can be compared absolutely.
 */
export function pageHeadingSizes(lines: readonly GroupedLine[]): number[] {
  if (lines.length === 0) return []
  const median = medianFontSize([...lines])
  const sizes: number[] = []
  for (const line of lines) {
    if (isHeadingLine(line, median)) sizes.push(round1(line.style.fontSize))
  }
  return sizes
}

/**
 * The document's heading sizes, largest first: index 0 is level 1.
 *
 * Returns `[]` when nothing on any page looked like a heading, which is the
 * signal for `structurePage` to rank the page it has in front of it instead.
 */
export function headingTiers(pages: readonly (readonly GroupedLine[])[]): number[] {
  const sizes: number[] = []
  for (const lines of pages) sizes.push(...pageHeadingSizes(lines))
  if (sizes.length === 0) return []
  sizes.sort((a, b) => b - a)

  const tiers: number[] = []
  for (const size of sizes) {
    if (size <= 0) continue
    const top = tiers[tiers.length - 1]
    if (top !== undefined && Math.abs(top - size) <= Math.max(0.5, top * 0.05)) continue
    tiers.push(size)
    if (tiers.length >= MAX_HEADING_LEVEL) break
  }
  return tiers
}

/**
 * Level for one heading size: the closest rung of the ladder.
 *
 * Nearest rather than "the largest rung at or below it" so a size the probe
 * never saw — a page parsed before the ladder existed, an OCR line, a tier
 * table sampled from part of the document — still lands where it belongs
 * instead of jumping to the top. The ladder is descending, so a tie keeps the
 * shallower level.
 */
export function headingLevelFor(fontSize: number, tiers: readonly number[]): number {
  if (tiers.length === 0) return 1
  let best = 0
  let bestDistance = Math.abs(tiers[0] - fontSize)
  for (let index = 1; index < tiers.length; index += 1) {
    const distance = Math.abs(tiers[index] - fontSize)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return best + 1
}

/** Distinct positive sizes, largest first — the per-page fallback ladder. */
export function sizeLadder(sizes: readonly number[]): number[] {
  const distinct = new Set<number>()
  for (const size of sizes) {
    if (size > 0 && Number.isFinite(size)) distinct.add(round1(size))
  }
  return [...distinct].sort((a, b) => b - a)
}
