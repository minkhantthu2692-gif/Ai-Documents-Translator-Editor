/**
 * Placeholder tokenisation for inline content that must not be translated.
 *
 * Inline maths (`$E=mc^2$`, `(x + y)`) and inline markup (`**bold**`, `<b>…</b>`)
 * are replaced by `{{0}}`, `{{1}}`… tokens before the text is sent to the model
 * and are restored afterwards, losslessly and in order. Tokens that already
 * exist in the input are preserved as-is so re-running the pipeline is safe.
 */

export type PlaceholderKind = 'math' | 'formatting' | 'existing'

export interface Placeholder {
  /** `{{n}}` written into the tokenised text. */
  token: string
  kind: PlaceholderKind
  /** Exact original substring the token stands for. */
  original: string
}

export interface TokenizeResult {
  /** Text with protected runs replaced by {{n}} tokens. */
  text: string
  placeholders: Placeholder[]
}

export const PLACEHOLDER_PATTERN = /\{\{(\d+)\}\}/g

/** Characters that only ever appear in maths, never in running prose. */
const MATH_ONLY = /[≈≠≤≥×÷√∑∫∏∞°±ΔπΩ]/

/** Operators we accept as "this looks like a formula". Plain `-` is excluded. */
const MATH_OPERATOR = /[=+×÷*/^≈≠≤≥<>√∑∫±π°%]/

/**
 * True when a fragment reads as a formula rather than prose.
 * Requires an operator (or a maths-only glyph) plus digits/identifiers, which
 * keeps sentences like "a = b is wrong"… while still catching `E=mc²`.
 */
export function looksLikeFormula(fragment: string): boolean {
  const trimmed = fragment.trim()
  if (!trimmed || trimmed.length > 80) return false
  if (!MATH_OPERATOR.test(trimmed) && !MATH_ONLY.test(trimmed)) return false
  if (!/\d/.test(trimmed) && !/[A-Za-z]/.test(trimmed)) return false
  // A single letter with an equals sign ("A = yes") is prose, not maths.
  if (!MATH_ONLY.test(trimmed) && !/\d/.test(trimmed) && trimmed.length > 30) return false
  return true
}

/** Standalone formula run bounded by whitespace/line edges (no $ delimiters). */
const BARE_FORMULA = /(?:^|(?<=\s))[-−]?[\w.]+(?:\s*[=+×÷*/^≈≠≤≥<>√∑∫±°%]\s*[\w.]+)+(?=\s|$)/g

const PATTERNS: Array<{ re: RegExp; kind: PlaceholderKind }> = [
  { re: /\$\$([^$]{1,400})\$\$/g, kind: 'math' },
  { re: /\$([^$\n]{1,200})\$/g, kind: 'math' },
  { re: /\(([^()\n]{1,160})\)/g, kind: 'math' },
  {
    re: /<\/?(?:b|i|u|em|strong|sup|sub|s|mark)>[^<>]{1,300}<\/?(?:b|i|u|em|strong|sup|sub|s|mark)>/g,
    kind: 'formatting',
  },
  { re: /\*\*[^*\n]{1,200}\*\*/g, kind: 'formatting' },
  { re: /__[^_\n]{1,200}__/g, kind: 'formatting' },
]

/**
 * Replaces protected runs with `{{n}}` placeholders.
 * Math delimiters must contain something formula-like, so "$5 and $6" survives
 * as ordinary text while "$x+y=12$" is protected.
 */
export function tokenizePlaceholders(input: string): TokenizeResult {
  if (!input) return { text: '', placeholders: [] }

  interface Match {
    start: number
    end: number
    original: string
    kind: PlaceholderKind
  }
  const matches: Match[] = []

  for (const { re, kind } of PATTERNS) {
    const clone = new RegExp(re.source, re.flags)
    let match: RegExpExecArray | null
    while ((match = clone.exec(input)) !== null) {
      const original = match[0]
      const inner = kind === 'math' && original.startsWith('(') ? original.slice(1, -1) : null
      if (inner !== null && !looksLikeFormula(inner)) continue
      if (kind === 'math' && original.startsWith('$') && !looksLikeFormula(original.slice(1, -1))) {
        continue
      }
      matches.push({ start: match.index, end: match.index + original.length, original, kind })
      if (clone.lastIndex === match.index) clone.lastIndex += 1
    }
  }

  // Bare formulas (no delimiters), e.g. `1 + 1 = 2` inside a sentence.
  const bare = new RegExp(BARE_FORMULA.source, BARE_FORMULA.flags)
  let bareMatch: RegExpExecArray | null
  while ((bareMatch = bare.exec(input)) !== null) {
    const original = bareMatch[0]
    if (!looksLikeFormula(original)) continue
    matches.push({
      start: bareMatch.index,
      end: bareMatch.index + original.length,
      original,
      kind: 'math',
    })
    if (bare.lastIndex === bareMatch.index) bare.lastIndex += 1
  }

  // Existing tokens are kept verbatim so repeated runs stay idempotent.
  const existing = new RegExp(PLACEHOLDER_PATTERN.source, PLACEHOLDER_PATTERN.flags)
  let existingMatch: RegExpExecArray | null
  while ((existingMatch = existing.exec(input)) !== null) {
    matches.push({
      start: existingMatch.index,
      end: existingMatch.index + existingMatch[0].length,
      original: existingMatch[0],
      kind: 'existing',
    })
  }

  // Drop overlaps: earliest start wins, then longest match.
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Match[] = []
  let cursor = -1
  for (const match of matches) {
    if (match.start < cursor) continue
    kept.push(match)
    cursor = match.end
  }

  let text = ''
  const placeholders: Placeholder[] = []
  let position = 0
  for (const match of kept) {
    if (match.start > position) text += input.slice(position, match.start)
    if (match.kind === 'existing') {
      // Token already present: keep it, do not allocate a new index.
      text += match.original
      placeholders.push({
        token: match.original,
        kind: 'existing',
        original: match.original,
      })
    } else {
      const mathIndex = placeholders.filter((p) => p.kind !== 'existing').length
      const finalToken = `{{${mathIndex}}}`
      text += finalToken
      placeholders.push({ token: finalToken, kind: match.kind, original: match.original })
    }
    position = match.end
  }
  text += input.slice(position)

  return { text, placeholders }
}

/**
 * Restores every placeholder occurrence. Idempotent: text without tokens is
 * returned unchanged, and a missing token simply leaves its original absent
 * (the caller can detect that through `missingPlaceholders`).
 */
export function restorePlaceholders(text: string, placeholders: Placeholder[]): string {
  if (!text || placeholders.length === 0) return text
  let out = text
  for (const placeholder of placeholders) {
    if (placeholder.kind === 'existing') continue
    out = out.split(placeholder.token).join(placeholder.original)
  }
  return out
}

/** Tokens that did not survive the round trip (model dropped them). */
export function missingPlaceholders(text: string, placeholders: Placeholder[]): string[] {
  const missing: string[] = []
  for (const placeholder of placeholders) {
    if (placeholder.kind === 'existing') continue
    if (!text.includes(placeholder.token)) missing.push(placeholder.token)
  }
  return missing
}

/** True when the text still contains unresolved `{{n}}` tokens. */
export function hasPlaceholders(text: string): boolean {
  return new RegExp(PLACEHOLDER_PATTERN.source).test(text)
}
