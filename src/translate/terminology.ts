/**
 * Terminology post-processor.
 *
 * The prompt *asks* for `TranslatedTerm(OriginalTerm)`; this module *guarantees*
 * it:
 *
 *  - normalises the annotation to ASCII parentheses with no space before `(`:
 *      `ပန်းသီး (apple)`  → `ပန်းသီး(apple)`
 *      `ပန်းသီး（apple）` → `ပန်းသီး(apple)`
 *  - enforces the occurrence scope (first per page / first per document /
 *    every) by dropping later annotations of the same original term;
 *  - applies the glossary: a glossary term that leaked through untranslated is
 *    replaced with the required target term, anything that could not be
 *    repaired is reported as a violation;
 *  - implements "no good translation → keep the original": an empty or
 *    content-free translation falls back to the source line.
 *
 * Everything is pure and stateless apart from the `seen*` sets the caller owns
 * (one pair per page / per run), which is what makes the scope rules testable.
 */

import type { GlossarySpec, TerminologyScope } from './types'

const FULL_WIDTH_PARENS: Array<[string, string]> = [
  ['（', '('],
  ['）', ')'],
  ['［', '['],
  ['］', ']'],
]

/** Short, term-like parenthetical content (no sentences). */
const TERM_INNER = /^[\p{L}\p{N}][\p{L}\p{N} .,'’\-/+&#:]{0,60}$/u
const ANNOTATION =
  /([\p{L}\p{M}][\p{L}\p{M}\p{N}._+-]{1,40})\s*([([{])\s*([^()[\]{}]{1,64})\s*([)\]}])/gu

export interface NormalizeOptions {
  scope: TerminologyScope
  /** Terms already annotated on the current page. */
  seenPage: Set<string>
  /** Terms already annotated in the document (scope `document`). */
  seenDocument: Set<string>
  /** Source line — an annotation is "managed" when its inner text comes from it. */
  sourceText?: string
}

export interface NormalizeResult {
  text: string
  kept: string[]
  removed: string[]
}

function innerIsTerm(inner: string): boolean {
  const trimmed = inner.trim()
  if (trimmed.length < 2) return false
  if (!TERM_INNER.test(trimmed)) return false
  if (trimmed.split(/\s+/).length > 6) return false
  if (trimmed.endsWith('.')) return false
  return true
}

function keyOf(inner: string): string {
  return inner.trim().toLowerCase()
}

/**
 * True when the text inside an annotation is a term the *source* line actually
 * contains — the single predicate that decides an annotation is ours to manage
 * rather than an ordinary parenthetical. Shared by the normaliser and by the
 * two readers below, so they can never disagree about what counts.
 *
 * `sourceLower` is pre-lowered by the caller (it is called once per match).
 */
function innerIsFromSource(inner: string, sourceLower: string): boolean {
  if (!innerIsTerm(inner)) return false
  const needle = inner.trim().toLowerCase()
  return needle.length > 0 && sourceLower.includes(needle)
}

/** Replaces full-width brackets and unifies the annotation brackets. */
export function normalizeBrackets(text: string): string {
  let out = text
  for (const [from, to] of FULL_WIDTH_PARENS) out = out.split(from).join(to)
  return out
}

/**
 * Applies format + occurrence rules. `seenPage`/`seenDocument` are mutated so
 * the caller can carry them across the lines of a page (and of the document).
 */
export function normalizeTerminology(text: string, options: NormalizeOptions): NormalizeResult {
  if (!text) return { text: '', kept: [], removed: [] }
  const normalized = normalizeBrackets(text)
  const sourceLower = (options.sourceText ?? '').toLowerCase()

  const isOriginal = (inner: string): boolean => innerIsFromSource(inner, sourceLower)

  const kept: string[] = []
  const removed: string[] = []

  const out = normalized.replace(
    ANNOTATION,
    (match, before: string, _open: string, inner: string, _close: string, _offset: number) => {
      // Only source-derived annotations are managed; other parentheticals pass
      // through (after bracket normalisation).
      if (!isOriginal(inner)) return match
      // Never strip an annotation that has nothing in front of it.
      if (!before || before.trim().length === 0) return match

      const key = keyOf(inner)
      const seen =
        options.scope === 'document'
          ? options.seenDocument
          : options.scope === 'first'
            ? options.seenPage
            : null

      if (seen === null) {
        kept.push(inner.trim())
        options.seenDocument.add(key)
        options.seenPage.add(key)
        return `${before}(${inner.trim()})`
      }

      if (seen.has(key)) {
        removed.push(inner.trim())
        return before
      }
      seen.add(key)
      if (options.scope === 'document') options.seenPage.add(key)
      kept.push(inner.trim())
      return `${before}(${inner.trim()})`
    },
  )

  return { text: out, kept, removed }
}

/** One source-derived `Translated(Original)` annotation found in a line. */
interface FoundAnnotation {
  /** The translated term standing in front of the parenthesis. */
  targetTerm: string
  /** The original term inside the parenthesis. */
  sourceTerm: string
}

/**
 * Walks `text` for annotations whose inner term comes from `sourceText`.
 *
 * Read-only counterpart of `normalizeTerminology`: it applies exactly the same
 * `innerIsFromSource` predicate but changes nothing, so callers can inspect
 * what a finished translation already established.
 */
function walkAnnotations(text: string, sourceText?: string): FoundAnnotation[] {
  if (!text || !sourceText) return []
  const normalized = normalizeBrackets(text)
  const sourceLower = sourceText.toLowerCase()
  const found: FoundAnnotation[] = []

  for (const match of normalized.matchAll(ANNOTATION)) {
    const before = match[1]
    const inner = match[3]
    // An annotation with nothing in front of it is not a term annotation.
    if (!before || before.trim().length === 0) continue
    if (!innerIsFromSource(inner, sourceLower)) continue
    found.push({ targetTerm: before.trim(), sourceTerm: inner.trim() })
  }
  return found
}

/**
 * Lowercase keys of the original terms already annotated in `text`.
 *
 * This is how a resumed run **re-seeds** `seenPage`/`seenDocument`: the sets are
 * rebuilt from Dexie on every restore, so without this a document-scope run
 * restarted halfway through would annotate the same term a second time.
 */
export function annotatedTerms(text: string, sourceText?: string): string[] {
  const keys: string[] = []
  for (const { sourceTerm } of walkAnnotations(text, sourceText)) {
    const key = keyOf(sourceTerm)
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * `source → target` pairs a translation actually produced.
 *
 * Feeds the rolling glossary (Layer 6): a term the model chose and then kept
 * choosing is a term worth *enforcing* for the rest of the run. Pairs are only
 * reported when the original term really occurs in the source, so an ordinary
 * parenthetical can never be promoted into the glossary.
 */
export function extractTermPairs(
  text: string,
  sourceText?: string,
): Array<{ sourceTerm: string; targetTerm: string }> {
  const pairs: Array<{ sourceTerm: string; targetTerm: string }> = []
  for (const { sourceTerm, targetTerm } of walkAnnotations(text, sourceText)) {
    if (!targetTerm) continue
    if (pairs.some((pair) => pair.sourceTerm === sourceTerm)) continue
    pairs.push({ sourceTerm, targetTerm })
  }
  return pairs
}

export interface GlossaryOutcome {
  text: string
  /** Glossary terms that were written but had to be repaired. */
  fixes: string[]
  /** Glossary terms present in the source that could not be located. */
  misses: string[]
}

/**
 * Post-validates the glossary and repairs what it can: a source term that
 * survived into the translation is swapped for the required target term.
 */
export function enforceGlossary(
  sourceText: string,
  translated: string,
  glossary: GlossarySpec[],
): GlossaryOutcome {
  const fixes: string[] = []
  const misses: string[] = []
  let text = translated

  for (const entry of glossary) {
    if (!entry.sourceTerm) continue
    const sourceHit = entry.caseSensitive
      ? sourceText.includes(entry.sourceTerm)
      : sourceText.toLowerCase().includes(entry.sourceTerm.toLowerCase())
    if (!sourceHit) continue

    const targetPresent = entry.caseSensitive
      ? text.includes(entry.targetTerm)
      : text.toLowerCase().includes(entry.targetTerm.toLowerCase())
    if (targetPresent) continue

    const needle = entry.caseSensitive ? entry.sourceTerm : entry.sourceTerm.toLowerCase()
    const haystack = entry.caseSensitive ? text : text.toLowerCase()
    const at = haystack.indexOf(needle)
    if (at === -1) {
      misses.push(entry.sourceTerm)
      continue
    }
    text = text.slice(0, at) + entry.targetTerm + text.slice(at + entry.sourceTerm.length)
    fixes.push(entry.sourceTerm)
  }

  return { text, fixes, misses }
}

const HAS_LETTER = /[\p{L}]/u

/**
 * "No good translation → keep the original only."
 * Returns the source text when the translation carries no readable content.
 */
export function keepOriginalWhenUnusable(
  sourceText: string,
  translated: string,
): {
  text: string
  replaced: boolean
} {
  const trimmed = translated.trim()
  if (sourceText.trim().length === 0) return { text: translated, replaced: false }
  if (trimmed.length === 0) return { text: sourceText, replaced: true }
  if (sourceText.length > 12 && !HAS_LETTER.test(trimmed)) {
    return { text: sourceText, replaced: true }
  }
  // A translation that is a tiny fraction of a real sentence is usually junk.
  if (trimmed.length < 2 && sourceText.trim().length > 8) {
    return { text: sourceText, replaced: true }
  }
  return { text: translated, replaced: false }
}

/** Full post-processing pass used by the engine after validation. */
export function postProcessTranslation(
  sourceText: string,
  translated: string,
  glossary: GlossarySpec[],
  options: NormalizeOptions,
): { text: string; glossaryFixes: string[]; glossaryMisses: string[]; keptOriginal: boolean } {
  const usable = keepOriginalWhenUnusable(sourceText, translated)
  const glossaryOutcome = enforceGlossary(sourceText, usable.text, glossary)
  const normalized = normalizeTerminology(glossaryOutcome.text, options)
  return {
    text: normalized.text,
    glossaryFixes: glossaryOutcome.fixes,
    glossaryMisses: glossaryOutcome.misses,
    keptOriginal: usable.replaced,
  }
}
