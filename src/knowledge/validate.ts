/**
 * Glossary re-validation (Phase 4).
 *
 * "Apply to project" means more than saving rows: every existing translation
 * is re-checked against the glossary, offending blocks get the
 * `glossary-miss` flag (which the workspace shows as a badge) and clean blocks
 * lose that flag again. The matching rules are pure functions so the exact
 * contract — including the `Target(Source)` annotation the prompt writes — is
 * unit tested rather than eyeballed.
 */

import { blockRepo, pageRepo } from '@/db/repo-content'
import { glossaryRepo } from '@/db/repo-knowledge'
import type { BlockRecord, GlossaryRecord } from '@/db/types'

export interface GlossaryTerm {
  sourceTerm: string
  targetTerm: string
  caseSensitive: boolean
}

export type ViolationKind =
  /** Source term is used but neither the target nor the annotation appears. */
  | 'missing'
  /** Translation kept the original source term untouched. */
  | 'untranslated'

export interface GlossaryViolation {
  blockId: string
  pageIndex: number
  order: number
  sourceTerm: string
  targetTerm: string
  kind: ViolationKind
  /** The offending translation (truncated for lists). */
  excerpt: string
}

export interface ValidateResult {
  /** Blocks examined. */
  checked: number
  /** Blocks that violated at least one term. */
  flagged: number
  /** Blocks whose `glossary-miss` flag was cleared again. */
  cleared: number
  violations: GlossaryViolation[]
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** Latin terms need a word boundary; Myanmar/CJK/Thai have no word spaces,
 * so those are matched as plain substrings. */
function needsBoundary(term: string): boolean {
  if (term.length === 0) return false
  for (let index = 0; index < term.length; index += 1) {
    if (term.charCodeAt(index) > 0x7f) return false
  }
  return true
}

/** Case-folded containment that still respects word boundaries for Latin terms. */
export function containsTerm(text: string, term: string, caseSensitive: boolean): boolean {
  if (term.trim().length === 0 || text.length === 0) return false
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? term : term.toLowerCase()
  const guard = needsBoundary(needle)
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    const end = at + needle.length
    const beforeOk = !guard || at === 0 || !WORD_CHAR.test(text[at - 1])
    const afterOk = !guard || end >= text.length || !WORD_CHAR.test(text[end])
    if (beforeOk && afterOk) return true
    from = at + 1
  }
}

/**
 * True when the translation satisfies a term. Accepted forms, in order:
 * the prompt's `Target(Source)` annotation, the bare target term, or the
 * source term itself when source and target are identical (a "keep as-is"
 * glossary entry).
 */
export function termIsHonoured(translation: string, term: GlossaryTerm): boolean {
  const annotated = `${term.targetTerm}(${term.sourceTerm})`
  if (containsTerm(translation, annotated, term.caseSensitive)) return true
  if (containsTerm(translation, term.targetTerm, term.caseSensitive)) return true
  if (term.sourceTerm === term.targetTerm) {
    return containsTerm(translation, term.sourceTerm, term.caseSensitive)
  }
  return false
}

/** All terms the source text uses, mapped to their expected rendering. */
export function violationsForBlock(
  block: Pick<BlockRecord, 'id' | 'sourceText' | 'translatedText'> & { pageIndex?: number },
  terms: GlossaryTerm[],
): GlossaryViolation[] {
  const translation = block.translatedText
  if (translation.trim().length === 0 || terms.length === 0) return []

  const out: GlossaryViolation[] = []
  for (const term of terms) {
    if (!containsTerm(block.sourceText, term.sourceTerm, term.caseSensitive)) continue
    if (termIsHonoured(translation, term)) continue
    const untranslated = containsTerm(translation, term.sourceTerm, term.caseSensitive)
    out.push({
      blockId: block.id,
      pageIndex: block.pageIndex ?? 0,
      order: 0,
      sourceTerm: term.sourceTerm,
      targetTerm: term.targetTerm,
      kind: untranslated ? 'untranslated' : 'missing',
      excerpt: translation.slice(0, 120),
    })
  }
  return out
}

function toTerm(row: GlossaryRecord): GlossaryTerm {
  return {
    sourceTerm: row.sourceTerm,
    targetTerm: row.targetTerm,
    caseSensitive: row.caseSensitive,
  }
}

/**
 * Re-checks every translated block in the project and persists the
 * `glossary-miss` flag. Rows are only written when the flag actually changes,
 * so a full re-validation of a 300-page document stays cheap.
 */
export async function validateProjectGlossary(
  projectId: string,
  options: { pageIndexes?: number[] } = {},
): Promise<ValidateResult> {
  const [globalRows, projectRows, blocks, pages] = await Promise.all([
    glossaryRepo.list(null),
    glossaryRepo.list(projectId),
    blockRepo.listByProject(projectId),
    pageRepo.listByProject(projectId),
  ])
  const terms = [...globalRows, ...projectRows].map(toTerm)
  const pageIndexOf = new Map(pages.map((page) => [page.id, page.index]))

  const wanted = options.pageIndexes ? new Set(options.pageIndexes) : null
  const result: ValidateResult = { checked: 0, flagged: 0, cleared: 0, violations: [] }

  for (const block of blocks) {
    const pageIndex = pageIndexOf.get(block.pageId) ?? 0
    if (wanted && !wanted.has(pageIndex)) continue
    if (block.translatedText.trim().length === 0) continue
    result.checked += 1

    const violations = violationsForBlock({ ...block, pageIndex }, terms)
    const shouldBeFlagged = violations.length > 0
    const isFlagged = block.translationFlag === 'glossary-miss'

    if (shouldBeFlagged) {
      result.flagged += 1
      result.violations.push(...violations)
      if (!isFlagged) {
        await blockRepo.update(block.id, { translationFlag: 'glossary-miss' })
      }
    } else if (isFlagged) {
      result.cleared += 1
      await blockRepo.update(block.id, { translationFlag: null })
    }
  }

  return result
}

/** Convenience wrapper for the UI: terms currently in force for a project. */
export async function activeTerms(projectId: string): Promise<GlossaryTerm[]> {
  const [globalRows, projectRows] = await Promise.all([
    glossaryRepo.list(null),
    glossaryRepo.list(projectId),
  ])
  return [...globalRows, ...projectRows].map(toTerm)
}
