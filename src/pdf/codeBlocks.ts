/**
 * Code-block detection (PDF types 13 and 24).
 *
 * A technical manual sets its examples in a face the body text never uses and
 * nests them by column position. Both signals survive extraction: `style`
 * carries the family pdf.js resolved, and every line keeps the bounding box it
 * was drawn at. What does *not* survive is the indentation itself —
 * `groupItemsIntoLines` collapses whitespace and trims, because prose does not
 * care where a word began — so this module puts it back from the geometry that
 * is still on the line.
 *
 * Three things happen once a block is called code:
 *
 *  - `structure.ts` gives it `kind: 'code'` and stamps `skipRule: 'code'`, so
 *    the translator never rewrites a program;
 *  - the exporters fence it (Markdown), keep its line breaks (HTML, EPUB) and
 *    set it in a monospace face (DOCX, HTML, EPUB);
 *  - the editor draws it the way it will be exported.
 *
 * The per-line test is `looksLikeCodeFragment`, shared with `skipRules`: the
 * lines a block skips and the block an exporter fences are decided by the same
 * function, so the two can never disagree.
 *
 * Pure geometry and strings — no DOM, no worker state, safe in Vitest.
 */

import { looksLikeCodeFragment } from './skipRules'

/**
 * A whole line that is nothing but structural delimiters: `}`, `);`, `{`.
 * Prose never consists of these alone, and `looksLikeCodeFragment` needs Latin
 * letters behind its punctuation, so the closing brace of a block would
 * otherwise be the one line that votes "not code".
 */
const DELETERS_ONLY = /^[{}()[\];,]+$/

/**
 * Faces that put every character on the same advance width. Matched on the
 * family name because that is all pdf.js hands back; pdf.js' six-letter subset
 * prefix (`ABCDEF+Courier`) is simply matched through.
 */
const MONOSPACE_HINT =
  /mono|courier|consolas|menlo|monaco|inconsolata|cousine|source ?code|fira|ubuntu|andale|lucida ?console|dejavu sans mono|liberation mono|noto sans mono/i

/** Only the fields the detector reads — `GroupedLine` and `BlockLine` both fit. */
export interface CodeLineLike {
  text: string
  bbox: { x: number; w: number }
  style: { fontFamily: string }
}

/** Guard against nonsense geometry producing a paragraph of leading spaces. */
const MAX_INDENT_COLUMNS = 40

/**
 * The face a `kind: 'code'` block is drawn and exported in.
 *
 * A snippet's own family is already monospaced when the detector read it off
 * the font name — which is most of the time — so this is really the *fallback*
 * for the snippets caught by their punctuation instead, where the PDF set them
 * in the body face. Every family here puts one advance width behind a glyph,
 * so the indentation `codeBlockText` measured back off the bounding boxes
 * still lines up after rendering. The editor and every exporter share this one
 * list, so what is on screen and what is in the file never disagree.
 */
export const CODE_FONT_STACK =
  '"Courier New", Courier, "DejaVu Sans Mono", "Liberation Mono", "Nimbus Mono PS", "Lucida Console", monospace'

/** True when the family is one that sets every glyph on the same width. */
export function isMonospaceFamily(name: string): boolean {
  if (!name) return false
  return MONOSPACE_HINT.test(name)
}

/**
 * True when one line votes "code".
 *
 * Shares `looksLikeCodeFragment` with the translator's skip rule, plus the
 * delimiter-only lines that have no letters to score.
 */
export function codeLineSignal(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (DELETERS_ONLY.test(trimmed)) return true
  return looksLikeCodeFragment(trimmed)
}

/**
 * True when one line alone is unmistakably code: a monospaced face *and*
 * punctuation that reads as a statement.
 *
 * Two lines both passing this is what tells `canMerge` that a step sideways is
 * a nesting level rather than a new paragraph — and it is deliberately strict,
 * so a prose line beside a snippet still starts a block of its own.
 */
export function looksLikeCodeLine(line: CodeLineLike): boolean {
  return isMonospaceFamily(line.style.fontFamily) && codeLineSignal(line.text)
}

/**
 * True when a run of lines is a code snippet rather than prose.
 *
 * Two independent readings have to agree before a block is taken away from the
 * translator:
 *
 *  1. **Face and content** — at least 60% monospaced *and* half the lines read
 *     as code. A monospaced address block or table of contents fails the
 *     second half; a proportional snippet fails the first.
 *  2. **Face and nesting** — at least 60% monospaced, at least two lines flush
 *     with the block's left edge and at least one stepped right of them. This
 *     is what catches YAML, JSON and indented snippets, whose lines carry no
 *     punctuation to score. Requiring two lines to hold the left edge keeps a
 *     *centred* monospaced block — where every line begins at its own x — out.
 *  3. **Content alone** — a proportional face (a manual that sets examples in
 *     the body font) with at least two lines, 60% of them code, and a brace
 *     somewhere. The brace is what separates `function f() {` from prose that
 *     happens to contain a semicolon.
 */
export function looksLikeCodeBlock(lines: readonly CodeLineLike[]): boolean {
  const withText = lines.filter((line) => line.text.trim().length > 0)
  if (withText.length === 0) return false

  const monoRatio =
    withText.filter((line) => isMonospaceFamily(line.style.fontFamily)).length / withText.length
  const signalRatio = withText.filter((line) => codeLineSignal(line.text)).length / withText.length

  const minX = Math.min(...withText.map((line) => line.bbox.x))
  const flushLeft = withText.filter((line) => Math.abs(line.bbox.x - minX) <= 0.5).length
  const steppedRight = withText.some((line) => line.bbox.x > minX + 0.5)
  const hasBrace = withText.some((line) => /[{}]/.test(line.text))

  if (monoRatio >= 0.6 && signalRatio >= 0.5) return true
  if (monoRatio >= 0.6 && flushLeft >= 2 && steppedRight) return true
  if (withText.length >= 2 && signalRatio >= 0.6 && hasBrace) return true
  return false
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * The block's text with each line's leading spaces restored.
 *
 * Indentation is a *column position*, and `groupItemsIntoLines` has thrown the
 * characters away, so they are measured back off the bounding boxes: in a
 * monospaced face the advance width is one constant, which `bbox.w` divided by
 * the character count recovers exactly, and the same sum over the block gives
 * a stable enough estimate in a proportional one. `links.ts` makes the same
 * "exact for monospaced, approximate for proportional" trade in the other
 * direction, and it is the right way round to fail — a line lands a column
 * off rather than at the margin.
 *
 * The step is capped because a degenerate box would otherwise emit hundreds of
 * spaces, and a line flush with the block's own left edge contributes nothing.
 */
export function codeBlockText(lines: readonly CodeLineLike[]): string {
  const texts = lines.map((line) => line.text)
  const measurable = lines.filter((line) => line.text.length > 0 && line.bbox.w > 0)
  if (measurable.length < 2) return texts.join('\n')

  const charWidth = median(
    measurable.map((line) => line.bbox.w / line.text.length).filter((width) => width > 0),
  )
  if (!(charWidth > 0)) return texts.join('\n')

  const minX = Math.min(...measurable.map((line) => line.bbox.x))
  return lines
    .map((line) => {
      if (line.text.length === 0) return ''
      const columns = Math.round((line.bbox.x - minX) / charWidth)
      if (columns <= 0) return line.text
      return `${' '.repeat(Math.min(columns, MAX_INDENT_COLUMNS))}${line.text}`
    })
    .join('\n')
}
