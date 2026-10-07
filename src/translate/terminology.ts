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

  const isOriginal = (inner: string): boolean => {
    if (!innerIsTerm(inner)) return false
    if (!options.sourceText) return false
    const needle = inner.trim().toLowerCase()
    return needle.length > 0 && sourceLower.includes(needle)
  }

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
