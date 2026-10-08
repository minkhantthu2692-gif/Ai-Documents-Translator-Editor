/**
 * Rolling glossary — Layer 6.4 of `docs/TRANSLATION_ARCHITECTURE.md`.
 *
 * A batch is only ~25 lines, so the terminology the model settles on in chunk 1
 * has nothing holding it in place by chunk 40. Translation memory fixes that
 * only for *lines that repeat verbatim*; this fixes it for *terms*.
 *
 * When a translation carries a source-derived `Translated(Original)` annotation,
 * that is the model telling us which target term it chose for which original.
 * Three consistent choices in a row and the pair is promoted into the injected
 * glossary — after which `enforceGlossary` holds every later line to it.
 *
 * A learned entry is *enforced*, so promotion is guarded four ways:
 *
 *  1. never a term the user's own glossary already owns;
 *  2. never past `GLOSSARY_CAP` entries or the token ceiling below;
 *  3. never a term the model disagreed with about (disagreement drops the
 *     evidence instead of picking a winner — an enforced guess is worse than no
 *     enforcement);
 *  4. never learned from a result we did not trust (`confidence < 0.7`).
 *
 * The ceiling is in **tokens, not entries**, because the glossary lives in the
 * system prompt. `BudgetProfile` fills only `FILL_RATIO` of the content budget,
 * so the run has `1 − FILL_RATIO` (15%) of slack; bounding learning to 10% of it
 * keeps `promptOverheadTokens + fillTargetTokens + maxOutputTokens ≤
 * contextWindow` true however much the run learns — without re-measuring the
 * system prompt or shrinking every other batch.
 */

import { GLOSSARY_CAP } from './prompts'
import { estimateTokens } from './tokenEstimate'
import { extractTermPairs } from './terminology'
import type { GlossarySpec } from './types'

/** Consistent choices required before a term becomes enforced. */
export const PROMOTE_TERM_AFTER = 3

/** Absolute token ceiling for learned glossary entries. */
export const ROLLING_GLOSSARY_TOKENS = 512

/**
 * Ceiling as a share of the content budget — must stay below
 * `1 − FILL_RATIO` (0.15) or the window invariant breaks.
 */
export const ROLLING_GLOSSARY_SHARE = 0.1

export interface RollingGlossary {
  /** Lowercased source terms the user's own glossary owns — never overridden. */
  userKeys: Set<string>
  /** Evidence gathered so far, keyed by lowercased source term. */
  votes: Map<string, { sourceTerm: string; targetTerm: string; votes: number }>
  /** Token ceiling for learned entries. */
  tokenBudget: number
  /** Tokens of learned entries already promoted. */
  spent: number
}

/** The ceiling for a run whose content budget is `contentBudgetTokens`. */
export function rollingBudgetFor(contentBudgetTokens: number): number {
  return Math.min(ROLLING_GLOSSARY_TOKENS, Math.floor(contentBudgetTokens * ROLLING_GLOSSARY_SHARE))
}

export function createRollingGlossary(
  glossary: GlossarySpec[],
  tokenBudget: number,
): RollingGlossary {
  return {
    userKeys: new Set(
      glossary.filter((entry) => entry.sourceTerm).map((entry) => entry.sourceTerm.toLowerCase()),
    ),
    votes: new Map(),
    tokenBudget,
    spent: 0,
  }
}

export interface LearnedSource {
  /** The translated line as it was written to Dexie. */
  text: string
  /** The source line it came from — what makes an annotation "ours". */
  sourceText: string
  confidence: number
}

/**
 * Promotes proven pairs into `glossary` (mutated in place) and advances the
 * state. Safe to call after every batch; a run that learns nothing is a no-op.
 */
export function promoteLearnedTerms(
  state: RollingGlossary,
  glossary: GlossarySpec[],
  entries: LearnedSource[],
): void {
  if (state.spent >= state.tokenBudget) return

  for (const entry of entries) {
    if (entry.confidence < 0.7) continue

    for (const pair of extractTermPairs(entry.text, entry.sourceText)) {
      const key = pair.sourceTerm.toLowerCase()
      if (state.userKeys.has(key)) continue
      if (glossary.some((item) => item.sourceTerm.toLowerCase() === key)) continue

      const seen = state.votes.get(key)
      if (!seen) {
        state.votes.set(key, { ...pair, votes: 1 })
        continue
      }
      if (seen.targetTerm !== pair.targetTerm) {
        // Disagreement: drop the evidence rather than pick a winner.
        state.votes.delete(key)
        continue
      }
      seen.votes += 1
      if (seen.votes < PROMOTE_TERM_AFTER) continue

      const cost = estimateTokens(`- "${pair.sourceTerm}" = "${pair.targetTerm}"`)
      // Evidence is only spent once the entry is actually written: a ceiling
      // reached leaves the vote where it is rather than making the run pay to
      // rediscover it on every later batch.
      if (state.spent + cost > state.tokenBudget) return
      if (glossary.length >= GLOSSARY_CAP) return

      glossary.push({
        sourceTerm: pair.sourceTerm,
        targetTerm: pair.targetTerm,
        caseSensitive: false,
      })
      state.spent += cost
      state.votes.delete(key)
    }
  }
}
