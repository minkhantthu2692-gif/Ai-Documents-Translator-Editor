/**
 * Display-equation detection (PDF types 7 and 23).
 *
 * An inline formula already survives translation — `placeholders.ts` swaps
 * `$x+y$`, `(a/b)` and bare `1 + 1 = 2` for `{{n}}` tokens before the model
 * sees the line. What does not survive is the **display equation**: the
 * formula *is* the line, and worse, the formula is usually several lines.
 * TeX and its relatives set a superscript on its own baseline and a fraction
 * as three (numerator, rule, denominator), so `groupItemsIntoLines` hands the
 * structure pass `x`, then `2` above and to the right — and every one of
 * those fragments is individually unremarkable: a letter, a number, a lone
 * `n`. Reading order interleaves them with the prose around them, and the
 * translator dutifully rewrites `where` into Myanmar and leaves the maths in
 * English, or the reverse.
 *
 * This module does two things the rest of the pipeline cannot:
 *
 *  - **marks** the lines that belong to a display equation, on the ordered
 *    body before any merging — a line that scores as maths (mathematical
 *    face, mathematical glyphs, operators between short tokens) opens a run,
 *    and the fragments that hang off it by geometry (superscripts,
 *    subscripts, fraction parts, stacked continuations) are absorbed whatever
 *    they read as alone;
 *  - **assembles** the run back into one readable string — `x` + raised `2`
 *    becomes `x^2`, a fraction's parts stay on their own lines — so the
 *    block exports as something a reader can follow instead of four
 *    fragments the page never separated.
 *
 * `structure.ts` then gives the run `kind: 'equation'` and stamps
 * `skipRule: 'formula'`, so it is never handed to the model: the source text
 * stands as its own translation, in every format, exactly like code.
 *
 * Pure geometry and strings — no DOM, no worker state, safe in Vitest.
 */

import type { GroupedLine } from './lineGrouping'

/** Only the fields the detector reads — `GroupedLine` fits. */
export interface EquationLineLike {
  text: string
  bbox: { x: number; y: number; w: number; h: number }
  style: { fontFamily: string; fontSize: number }
}

/**
 * Faces that set mathematics. Matched on the family name because that is all
 * pdf.js hands back (its six-letter subset prefix, `ABCDEF+CMMI1`, matches
 * through). Computer Modern *Roman* is deliberately absent: that is TeX's
 * body face, and every prose line of a TeX document wears it.
 */
const MATH_FACE =
  /math|cmmi|cmsy|cmex|msam|msbm|mt-?(?:italic|symbol|extra|script)|symbol|stix|euclid/i

/** Glyphs that only ever set mathematics — operators, and the Greek maths borrows. */
const MATH_GLYPH = /[≈≠≤≥√∑∫∏∐∞∂∇±×÷⋅∘→↦∈∉⊂⊃⊆⊇∪∩⇒⇔±°∆∆λμσπφθωαβγδεζηκρτυχψΩΘΛΠΣΦΨΞ⁰¹²³⁴⁵⁶⁷⁸⁹]/

/** Operators between short tokens. Plain `-` is excluded (prose hyphens). */
const OPERATOR = /[=+<>≈≠±×÷√∑∫]/g

/** A five-letter word is prose's business; maths keeps its tokens short. */
const LONG_WORD = /[A-Za-zÀ-ɏ]{5,}/g

/** A run opens at this score. One math face or one math glyph is not enough. */
const EQUATION_SCORE = 2

/**
 * How a line reads as maths rather than prose. Zero is a definite no — the
 * score only ever decides "does a run start here", never "is this word
 * translatable".
 */
export function equationScore(line: EquationLineLike): number {
  const text = line.text.trim()
  if (!text || text.length > 120) return 0
  // Two five-letter words is a sentence, whatever symbols it carries: the
  // guard that keeps "the α particle decay" and "where x = 1 holds" prose.
  const longWords = text.match(LONG_WORD)
  if (longWords && longWords.length >= 2) return 0

  let score = 0
  if (MATH_FACE.test(line.style.fontFamily)) score += 3
  if (MATH_GLYPH.test(text)) score += 2
  const operators = text.match(OPERATOR)?.length ?? 0
  if (operators >= 2) score += 1
  // A caret is unambiguous ASCII maths wherever it sits. An underscore is
  // not — `price_var = 100` is an identifier — so it only counts beside an
  // operator, and only as one vote: `x_1 + x_2 = x̄` collects it, a data
  // line does not reach the threshold.
  if (text.includes('^')) score += 2
  else if (operators >= 1 && text.includes('_')) score += 1
  return score
}

function baseline(line: EquationLineLike): number {
  return line.bbox.y + line.bbox.h
}

/**
 * Whether `next` hangs off `prev` by geometry: a superscript (raised, small,
 * starting where the previous text ended), a subscript (dropped below the
 * baseline the same way) or a stack (a fraction part or an aligned
 * continuation — near, but not to the right).
 */
export function attachKind(
  prev: EquationLineLike,
  next: EquationLineLike,
  medianSize: number,
): 'sup' | 'sub' | 'stack' | null {
  const size = prev.style.fontSize || medianSize
  if (size <= 0 || !next.text.trim()) return null
  const prevBottom = baseline(prev)
  const nextBottom = baseline(next)
  // "Starts where the previous text ended" — a new column of a two-column
  // equation starts at the *left*, and is not a superscript of anything.
  const startsRight = next.bbox.x >= prev.bbox.x + prev.bbox.w - 0.5 * size
  // Same-point-size marks are as common as smaller ones: the raise (or the
  // drop) is what says superscript, not the glyph height. Growth still ends
  // the fold — a bigger line below-right is new text, not a mark.
  const notBigger = next.bbox.h <= prev.bbox.h + 0.1
  if (startsRight && notBigger) {
    if (nextBottom <= prevBottom - 0.2 * size) return 'sup'
    if (
      next.bbox.y >= prevBottom - 0.1 * size &&
      nextBottom >= prevBottom + 0.3 * size &&
      next.bbox.y <= prevBottom + 1.2 * size
    ) {
      return 'sub'
    }
  }
  // Near vertically and not to the right: a fraction part, or the next line
  // of an equation that was set on several baselines.
  const gap = next.bbox.y - prevBottom
  if (!startsRight && Math.abs(gap) <= 0.8 * size) return 'stack'
  return null
}

/**
 * Whether `prev` hangs off `next` the other way round — the superscript
 * *arrives first* whenever it sits entirely above the baseline, because
 * reading order is top-to-bottom.
 */
export function floatingMark(
  prev: EquationLineLike,
  next: EquationLineLike,
  medianSize: number,
): 'sup' | 'sub' | null {
  const size = next.style.fontSize || medianSize
  if (size <= 0) return null
  const text = prev.text.trim()
  if (!text || text.length > 4) return null
  // Short enough, not bigger, and inside the next line's span: a column
  // heading or a line number is neither.
  if (prev.bbox.h > next.bbox.h + 0.1) return null
  // A mark hangs over the *end* of the line it belongs to; a fraction's
  // numerator is centred over its denominator and stays a stack, however
  // raised it is.
  if (prev.bbox.x < next.bbox.x + next.bbox.w * 0.5 || prev.bbox.x > next.bbox.x + next.bbox.w) {
    return null
  }
  if (baseline(prev) <= baseline(next) - 0.25 * size) return 'sup'
  if (baseline(prev) >= baseline(next) + 0.35 * size) return 'sub'
  return null
}

/** One multi-character superscript/subscript needs braces to read right. */
function decorate(text: string): string {
  return text.length > 1 ? `{${text}}` : text
}

/**
 * Ids of the lines that belong to a display equation, in reading order.
 *
 * A scoring line opens a run; what follows is absorbed by geometry (see
 * `attachKind`) until a line hangs too far away — that is where one equation
 * ends and the next begins. A floating superscript *above* the anchor is
 * attached backwards, because it was read first.
 */
export function markEquationRegions(
  lines: GroupedLine[],
  ctx: { medianSize: number },
): Set<string> {
  const ids = new Set<string>()
  let index = 0
  while (index < lines.length) {
    if (equationScore(lines[index]) < EQUATION_SCORE) {
      index += 1
      continue
    }
    const anchor = lines[index]
    ids.add(anchor.id)
    // Backwards: the raised mark the anchor wears, read before it.
    if (index > 0) {
      const floating = floatingMark(lines[index - 1], anchor, ctx.medianSize)
      if (floating !== null) ids.add(lines[index - 1].id)
    }
    // Forwards: fragments that hang off the run, each stack part anchoring
    // the ones below it (a superscript on a denominator belongs to the
    // denominator, not to the numerator).
    let foot = anchor
    let next = index + 1
    for (; next < lines.length; next++) {
      const kind = attachKind(foot, lines[next], ctx.medianSize)
      if (kind === null) break
      // Geometry alone would drag the prose paragraph under a tight leading
      // into the formula — every one of its lines is "near and to the left".
      // A stack part has to look like maths as well: a score of its own, or
      // one short token. (Prose that itself carries maths glyphs directly
      // under a formula can still join it — both stay verbatim, so nothing
      // is lost but a translation the sentence did not strictly need.)
      if (kind === 'stack' && !looksLikeFragment(lines[next])) break
      ids.add(lines[next].id)
      if (kind !== 'sup') foot = lines[next]
    }
    index = next
  }
  return ids
}

/** A stacked fragment: scored as maths, or one short token like `n` or `c+d`. */
function looksLikeFragment(line: EquationLineLike): boolean {
  const text = line.text.trim()
  return equationScore(line) >= 2 || /^[^\s]{1,4}$/.test(text)
}

/**
 * The run assembled back into one string: `x` + raised `2` is `x^2`, a
 * dropped mark is `x_1`, and everything else keeps its own line — which is
 * how a fraction reads, numerator over denominator.
 */
export function equationText(lines: EquationLineLike[], medianSize: number): string {
  interface Folded {
    text: string
    line: EquationLineLike
  }
  const folded: Folded[] = []
  for (const line of lines) {
    const text = line.text.trim()
    if (!text) continue
    const last = folded[folded.length - 1]
    if (last) {
      const below = attachKind(last.line, line, medianSize)
      if (below === 'sup' || below === 'sub') {
        last.text += (below === 'sup' ? '^' : '_') + decorate(text)
        continue
      }
      // The mark arrived first: re-file it after the line it belongs to.
      const floating = floatingMark(last.line, line, medianSize)
      if (floating !== null) {
        folded.pop()
        folded.push({
          text: `${text}${floating === 'sup' ? '^' : '_'}${decorate(last.text)}`,
          line,
        })
        continue
      }
    }
    folded.push({ text, line })
  }
  return folded.map((entry) => entry.text).join('\n')
}
