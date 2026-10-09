/**
 * Footnote-region detection.
 *
 * A footnote is body text that is *not* body copy: a different measure, a
 * different role, and — the part that actually hurts — a note that sits close
 * enough to the paragraph above it to be swallowed by the paragraph merger.
 * Once swallowed, its marker disappears mid-sentence and the note is
 * translated as part of the wrong text; left unlabelled, it is also filed as a
 * figure `caption`, which is what small type below the body size used to
 * become. So the structure pass has to know where a footnote region begins
 * *before* it merges or classifies anything.
 *
 * Three signals, all readable from text geometry alone — the horizontal rule
 * above a footnote is a graphics path with no text, so pdf.js never hands it
 * over and this module does not pretend otherwise:
 *
 *   1. **Small type** — notes are set below the page's body size.
 *   2. **Low on the page** — a note lives *under* the text block, whereas a
 *      caption and a numbered section can be anywhere.
 *   3. **A marker** — `1`, `1)`, `*`, `[3]`, `(b)`, `၄` … the callout that ties
 *      the note to its reference in the text.
 *
 * All three must hold for the line that *opens* a note. The lines continuing
 * it only have to be small, flush with the opener and directly below: requiring
 * a marker on every line would miss every continuation, and requiring size
 * alone would turn captions and small-print sidebars into footnotes.
 *
 * Pure: `GroupedLine[]` in, the ids of the lines inside note regions out.
 */

import type { GroupedLine } from './lineGrouping'

export interface FootnoteContext {
  /** Page height in points (top-left origin). */
  pageHeight: number
  /** Median font size of the page's body text — the reference for "small". */
  medianSize: number
}

/** A note may only begin below this fraction of the page height. */
export const FOOTNOTE_ZONE_TOP = 0.55
/** A note's type must be at most this fraction of the body size. */
export const FOOTNOTE_MAX_SIZE_RATIO = 0.92
/** Vertical gap, as a multiple of the type size, that ends a note. */
export const FOOTNOTE_MAX_GAP_RATIO = 2
/** Horizontal slip, as a multiple of the type size, a continuation may show. */
export const FOOTNOTE_INDENT_RATIO = 1.5

/**
 * Leading marker forms, most distinctive first. Every one is followed by
 * whitespace, which is what keeps `1994`, `3.14` and `**bold**` from reading
 * as callouts: `1. Install…` *is* recognised, because a legal footnote
 * numbered `1.` is far more common than a small-print checklist at the foot
 * of a page — and misreading the latter only costs a label, never a block.
 *
 * The bracketed form is deliberately not a bare `[a-z]` alternation: `(did)`
 * and `(the result)` would otherwise read as `(d…)`/`(t…)` notes, so the
 * letter alternative is a single letter and the roman alternative only spells
 * values a real note would use.
 */
const SYMBOL_MARKER = /^([*†‡§¶]{1,3}|[①-⑳])\s+\S/u
const BRACKETED_MARKER = /^([([]\s*(?:\d{1,2}|[a-zA-Z]|i{1,3}|iv|ix|v|x{1,3})\s*[)\]])\s+\S/u
const PUNCTUATED_MARKER = /^(\(?\d{1,2}[.)]|[၀-၉]{1,2}[.)])\s+\S/u
const NUMBERED_MARKER = /^(\d{1,2}|[၀-၉]{1,2})\s+\S/u

/**
 * The callout at the start of a note, or `null` when the line does not begin
 * with one. Returns the marker itself so tests can pin down *which* forms are
 * recognised rather than just "something matched".
 */
export function footnoteMarker(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  for (const pattern of [SYMBOL_MARKER, BRACKETED_MARKER, PUNCTUATED_MARKER, NUMBERED_MARKER]) {
    const match = pattern.exec(trimmed)
    if (match) return match[1]
  }
  return null
}

/** True when the line sits in the lower part of the page where notes live. */
export function inFootnoteZone(line: GroupedLine, ctx: FootnoteContext): boolean {
  // An unknown page height means "cannot tell", not "everywhere". Refusing
  // keeps the detector off pages whose geometry we do not understand, instead
  // of marking half of them as notes.
  if (!(ctx.pageHeight > 0)) return false
  return line.bbox.y >= ctx.pageHeight * FOOTNOTE_ZONE_TOP
}

/** True when the line's type is set below the page's body size. */
export function isSmallType(line: GroupedLine, ctx: FootnoteContext): boolean {
  if (!(ctx.medianSize > 0)) return false
  if (!(line.style.fontSize > 0)) return false
  return line.style.fontSize <= ctx.medianSize * FOOTNOTE_MAX_SIZE_RATIO
}

/** True when the line both looks like a callout and is placed where notes go. */
export function isFootnoteStart(line: GroupedLine, ctx: FootnoteContext): boolean {
  if (footnoteMarker(line.text) === null) return false
  return inFootnoteZone(line, ctx) && isSmallType(line, ctx)
}

/**
 * Ids of every line that belongs to a footnote region.
 *
 * Lines arrive in reading order — `structurePage` passes the already-ordered
 * body — so a note's continuation lines follow its opener directly. A region
 * grows while the next line is small, in the zone and flush with the opener,
 * and stops the moment another marker appears (a new note must not be glued
 * onto the one above it), the type returns to body size, the indent jumps or
 * the vertical gap opens up.
 *
 * Every input line is returned at most once (a `Set`), and no line is marked
 * that the caller did not pass — the caller decides what a "body" line is.
 */
export function markFootnoteRegions(lines: GroupedLine[], ctx: FootnoteContext): Set<string> {
  const marked = new Set<string>()
  if (lines.length === 0) return marked

  for (let index = 0; index < lines.length; index += 1) {
    const opener = lines[index]
    if (marked.has(opener.id)) continue // already absorbed into an earlier note
    if (!isFootnoteStart(opener, ctx)) continue

    marked.add(opener.id)
    let previous = opener
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (marked.has(line.id)) break
      if (footnoteMarker(line.text) !== null) break
      if (!inFootnoteZone(line, ctx)) break
      if (!isSmallType(line, ctx)) break

      const size = line.style.fontSize > 0 ? line.style.fontSize : ctx.medianSize
      const indentSlip = Math.abs(line.bbox.x - opener.bbox.x)
      if (indentSlip > Math.max(6, size * FOOTNOTE_INDENT_RATIO)) break

      const gap = line.bbox.y - (previous.bbox.y + previous.bbox.h)
      if (gap > size * FOOTNOTE_MAX_GAP_RATIO) break
      if (gap < -size) break

      marked.add(line.id)
      previous = line
    }
  }
  return marked
}
