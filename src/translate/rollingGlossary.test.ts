/**
 * Rolling glossary: what the run learns about its own terminology, and the four
 * guards on *enforcing* what it learned.
 *
 * The ceiling test is the important one — it is what keeps
 * `promptOverheadTokens + fillTargetTokens + maxOutputTokens ≤ contextWindow`
 * true no matter how much a 350-page run picks up on the way through.
 */
import { describe, expect, it } from 'vitest'
import {
  createRollingGlossary,
  promoteLearnedTerms,
  rollingBudgetFor,
  ROLLING_GLOSSARY_SHARE,
  ROLLING_GLOSSARY_TOKENS,
  PROMOTE_TERM_AFTER,
  type LearnedSource,
} from './rollingGlossary'
import type { GlossarySpec } from './types'

const SOURCE = 'Store the key safely inside the keystore'
const LINE = 'သော့(key) ကို keystore အတွင်း ဘေးကင်းစွာ သိမ်းပါ'

/** One translated line as `persistLines` would hand it over. */
function learned(text = LINE, confidence = 1): LearnedSource[] {
  return [{ text, sourceText: SOURCE, confidence }]
}

/** Feeds the same evidence `times` times — what N batches of the same term do. */
function repeat(
  state: ReturnType<typeof createRollingGlossary>,
  glossary: GlossarySpec[],
  times: number,
  text = LINE,
  confidence = 1,
): void {
  for (let index = 0; index < times; index += 1) {
    promoteLearnedTerms(state, glossary, learned(text, confidence))
  }
}

describe('rollingBudgetFor', () => {
  it('stays inside the slack the fill ratio leaves, so the window invariant holds', () => {
    // The fill ratio uses 85% of the content budget, leaving 15% — learning is
    // bounded to a smaller share of the same slack.
    expect(ROLLING_GLOSSARY_SHARE).toBeLessThan(0.15)

    for (const contentBudget of [0, 1_024, 4_096, 16_384, 1_000_000]) {
      const budget = rollingBudgetFor(contentBudget)
      expect(budget).toBeLessThanOrEqual(Math.floor(contentBudget * ROLLING_GLOSSARY_SHARE))
      expect(budget).toBeLessThanOrEqual(ROLLING_GLOSSARY_TOKENS)
      expect(budget).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('promoteLearnedTerms', () => {
  it('promotes a term only after ' + PROMOTE_TERM_AFTER + ' consistent choices', () => {
    const glossary: GlossarySpec[] = []
    const state = createRollingGlossary([], 512)

    repeat(state, glossary, PROMOTE_TERM_AFTER - 1)
    expect(glossary).toHaveLength(0)

    promoteLearnedTerms(state, glossary, learned())
    expect(glossary).toEqual([{ sourceTerm: 'key', targetTerm: 'သော့', caseSensitive: false }])
    expect(state.spent).toBeGreaterThan(0)
    expect(state.spent).toBeLessThanOrEqual(state.tokenBudget)
  })

  it('learns nothing from a line that carries no source-derived annotation', () => {
    const glossary: GlossarySpec[] = []
    const state = createRollingGlossary([], 512)

    repeat(state, glossary, 5, 'ပုံမှန်စာကြောင်း တစ်ကြောင်း')

    expect(glossary).toHaveLength(0)
    expect(state.votes.size).toBe(0)
  })

  it('learns nothing from a result we did not trust', () => {
    const glossary: GlossarySpec[] = []
    const state = createRollingGlossary([], 512)

    repeat(state, glossary, 5, LINE, 0.5)

    expect(glossary).toHaveLength(0)
    expect(state.votes.size).toBe(0)
  })

  it('never shadows a term the user already put in the glossary', () => {
    const owned: GlossarySpec = {
      sourceTerm: 'key',
      targetTerm: 'သော့မှတ်',
      caseSensitive: false,
    }
    const glossary: GlossarySpec[] = [owned]
    const state = createRollingGlossary(glossary, 512)

    repeat(state, glossary, 5)

    expect(glossary).toEqual([owned])
    expect(state.userKeys.has('key')).toBe(true)
    expect(state.votes.size).toBe(0)
  })

  it('drops the evidence when the model disagrees with itself', () => {
    const glossary: GlossarySpec[] = []
    const state = createRollingGlossary([], 512)

    promoteLearnedTerms(state, glossary, learned())
    promoteLearnedTerms(state, glossary, learned('စော့(key) ကို သိမ်းပါ'))
    expect(state.votes.size).toBe(0) // disagreement, not a winner

    repeat(state, glossary, PROMOTE_TERM_AFTER)
    expect(glossary).toHaveLength(1)
    expect(glossary[0].targetTerm).toBe('သော့')
  })

  it('stops at the token ceiling and keeps the evidence rather than re-learning', () => {
    const glossary: GlossarySpec[] = []
    const state = createRollingGlossary([], 1) // one token cannot fit an entry

    repeat(state, glossary, PROMOTE_TERM_AFTER + 3)

    expect(glossary).toHaveLength(0)
    expect(state.spent).toBe(0)
    // The vote is not thrown away, so later batches do not pay to rediscover it.
    expect(state.votes.size).toBe(1)
    expect(state.votes.get('key')?.votes).toBeGreaterThan(PROMOTE_TERM_AFTER)
  })

  it('is a no-op when the ceiling is zero', () => {
    const glossary: GlossarySpec[] = []
    const state = createRollingGlossary([], 0)

    repeat(state, glossary, 5)

    expect(glossary).toHaveLength(0)
    expect(state.votes.size).toBe(0)
  })

  it('never grows the glossary past the shared entry cap', () => {
    const glossary: GlossarySpec[] = Array.from({ length: 200 }, (_, index) => ({
      sourceTerm: `term${index}`,
      targetTerm: `t${index}`,
      caseSensitive: false,
    }))
    const state = createRollingGlossary([], 4_096)

    repeat(state, glossary, PROMOTE_TERM_AFTER)

    expect(glossary).toHaveLength(200)
  })
})
