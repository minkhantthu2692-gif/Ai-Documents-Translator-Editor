/**
 * Request budgeting: what one translation request is allowed to carry.
 *
 * The properties pinned here are the ones that keep a large document inside
 * the model's window — and, just as importantly, that keep the budget large
 * enough that a big-context model is not served 1500-token appetisers a
 * thousand times a day.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeBudget,
  DEFAULT_MAX_OUTPUT,
  FILL_RATIO,
  fallbackBudget,
  maxOutputFor,
  maxOutputForWindow,
  MEDIUM_MAX_OUTPUT,
  MIN_CONTENT_BUDGET,
  OUTPUT_RATIO,
  REASONING_HEADROOM_TOKENS,
  UNKNOWN_CONTEXT_WINDOW,
  USER_PROMPT_OVERHEAD_TOKENS,
  WIDE_MAX_OUTPUT,
} from './budget'
import { resetTokenScale } from './tokenEstimate'
import type { BudgetInput } from './budget'
import type { TranslationBatch } from './types'

afterEach(() => resetTokenScale())

const BASE: BudgetInput = {
  provider: 'gemini',
  models: ['gemini-2.5-flash'],
  quality: 'medium',
  sourceLang: 'en',
  targetLang: 'my',
  terminologyScope: 'first',
  glossary: [],
}

const GLOSSARY = [
  { sourceTerm: 'invoice', targetTerm: 'ငွေတောင်းခံစာ', caseSensitive: false },
  { sourceTerm: 'contract', targetTerm: 'စာချုပ်', caseSensitive: false },
]

function batchOf(tokens: number): TranslationBatch {
  return { id: 'proj#1#0#0', pageIndex: 0, index: 0, lines: [], tokens }
}

describe('computeBudget — window resolution', () => {
  it('reads the window from the bundled spec', () => {
    const budget = computeBudget(BASE)

    expect(budget.contextWindow).toBe(1_048_576)
    expect(budget.unknown).toBe(false)
    // The completion cap scales with the window: a model that will take a
    // million tokens will return far more than the flat 4k that used to
    // throttle every batch to a handful of lines.
    expect(budget.maxOutputTokens).toBe(WIDE_MAX_OUTPUT)
  })

  it('falls back to a conservative window for an imported model', () => {
    const budget = computeBudget({ ...BASE, models: ['some/imported-model:free'] })

    expect(budget.unknown).toBe(true)
    expect(budget.contextWindow).toBe(UNKNOWN_CONTEXT_WINDOW)
  })

  it('lets an explicit window win (custom OpenAI-compatible endpoints)', () => {
    const budget = computeBudget({ ...BASE, models: [], contextWindow: 32_768 })

    expect(budget.contextWindow).toBe(32_768)
    expect(budget.unknown).toBe(false)
  })

  it('uses the narrowest window in the fallback chain', () => {
    // gpt-4.1-mini is 1M; gpt-3.5-turbo is 16 385. The chain may fall back to
    // the smaller one at any moment, so a batch must fit *it*.
    const budget = computeBudget({
      ...BASE,
      provider: 'openai',
      models: ['gpt-4.1-mini', 'gpt-3.5-turbo'],
    })

    expect(budget.contextWindow).toBe(16_385)
  })
})

describe('computeBudget — the window invariant', () => {
  const CASES: Array<{ name: string; input: BudgetInput }> = [
    { name: 'huge window (Gemini)', input: BASE },
    {
      name: 'smallest bundled window (gpt-3.5-turbo)',
      input: { ...BASE, provider: 'openai', models: ['gpt-3.5-turbo'] },
    },
    { name: 'unknown window (imported model)', input: { ...BASE, models: ['x/y'] } },
    {
      name: 'explicit tiny window',
      input: { ...BASE, models: [], contextWindow: 8_192 },
    },
    { name: 'high quality (review pass)', input: { ...BASE, quality: 'high' } },
    { name: 'basic quality (no glossary)', input: { ...BASE, quality: 'basic' } },
  ]

  it.each(CASES)('$name: overhead + content + output never exceeds the window', ({ input }) => {
    const budget = computeBudget(input)

    expect(
      budget.promptOverheadTokens + budget.fillTargetTokens + budget.maxOutputTokens,
    ).toBeLessThanOrEqual(budget.contextWindow)
    expect(budget.contentBudgetTokens).toBeGreaterThanOrEqual(MIN_CONTENT_BUDGET)
    expect(budget.fillTargetTokens).toBe(Math.ceil(budget.contentBudgetTokens * FILL_RATIO))
  })

  it('prices the glossary into the prompt it is actually going to send', () => {
    const without = computeBudget(BASE)
    const withGlossary = computeBudget({ ...BASE, glossary: GLOSSARY })

    expect(withGlossary.promptOverheadTokens).toBeGreaterThan(without.promptOverheadTokens)

    // The glossary no longer *decides* the content budget — the completion cap
    // does (next test) — and it should not: a prompt a few hundred tokens
    // fatter cannot outgrow a window of thousands, and pretending it could made
    // the budget look like it had room it never had.
    expect(withGlossary.contentBudgetTokens).toBe(without.contentBudgetTokens)
  })

  it('never plans more content than the completion could return', () => {
    // The bug this pins: the budget was derived from the context window alone,
    // so a 1M-window model was handed an ~885k-token content budget against a
    // flat 4k completion cap. Dense pages then came back as JSON truncated
    // mid-array, failed validation, and paid for a repair retry with the same
    // payload that could not have fit — quota spent on answers that could not
    // exist. Whatever the window, a batch may not carry more source than the
    // completion, minus its reasoning headroom, can express.
    for (const models of [['gemini-2.5-flash'], ['openai/gpt-oss-120b'], []]) {
      const budget = computeBudget({ ...BASE, models })
      const expressible = Math.floor(
        (budget.maxOutputTokens - REASONING_HEADROOM_TOKENS) / OUTPUT_RATIO,
      )
      expect(budget.contentBudgetTokens).toBeLessThanOrEqual(expressible)

      // And the chunker's target sits below the budget it was derived from.
      expect(budget.fillTargetTokens).toBeLessThanOrEqual(budget.contentBudgetTokens)
    }
  })

  it('a batch inside the budget still gets a completion that fits it', () => {
    const budget = computeBudget(BASE)

    expect(maxOutputFor(budget, batchOf(budget.fillTargetTokens))).toBeLessThanOrEqual(
      budget.maxOutputTokens,
    )
  })

  it('shrinks the content budget for High quality, whose review pass doubles the payload', () => {
    const medium = computeBudget({ ...BASE, quality: 'medium' })
    const high = computeBudget({ ...BASE, quality: 'high' })

    expect(high.contentBudgetTokens).toBeLessThan(medium.contentBudgetTokens)
  })

  it('always leaves room for the user-message framing', () => {
    const budget = computeBudget({ ...BASE, models: [], contextWindow: 16_385 })

    expect(budget.promptOverheadTokens).toBeGreaterThan(USER_PROMPT_OVERHEAD_TOKENS)
  })
})

describe('maxOutputForWindow', () => {
  it('scales the completion with the window, but never beyond it', () => {
    expect(maxOutputForWindow(1_048_576)).toBe(WIDE_MAX_OUTPUT)
    expect(maxOutputForWindow(128_000)).toBe(MEDIUM_MAX_OUTPUT)
    // Below the medium threshold nothing changes: an unknown or narrow-window
    // model still gets the conservative flat cap it always got.
    expect(maxOutputForWindow(16_385)).toBe(DEFAULT_MAX_OUTPUT)
    expect(maxOutputForWindow(8_192)).toBeLessThan(8_192)
    expect(maxOutputForWindow(1_500)).toBeLessThanOrEqual(1_500 - MIN_CONTENT_BUDGET)
  })

  it('never asks a window for a completion it could not hold', () => {
    for (const window of [1_500, 8_192, 16_385, 128_000, 1_048_576]) {
      expect(maxOutputForWindow(window)).toBeLessThanOrEqual(window - MIN_CONTENT_BUDGET)
    }
  })
})

describe('maxOutputFor', () => {
  const profile = computeBudget({ ...BASE, provider: 'openai', models: ['gpt-4o-mini'] })

  it('leaves room for reasoning before the answer', () => {
    // gpt-oss-120b burned a 256-token single-line cap entirely on reasoning
    // and answered with an empty body (live sweep, Oct 2026); the cap now
    // covers thinking + translation, still clamped by the model's own limit.
    expect(maxOutputFor(profile, batchOf(100))).toBe(2_208) // 100×1.6 + 2_048
    // A 128k-window model now allows an 8k completion, so the 4_448 this batch
    // needs is granted in full. It used to be cut back to 4_096 — the flat
    // cap — which is exactly how a dense batch came back as JSON truncated
    // mid-array and paid for a repair retry with a payload that could not fit.
    expect(maxOutputFor(profile, batchOf(1_500))).toBe(4_448)
  })

  it('stops at the model instead of a flat constant', () => {
    // A 25-line Burmese batch can genuinely be several thousand tokens of
    // source; the old flat 4000 cap is what truncated it mid-JSON.
    const big = maxOutputFor(profile, batchOf(20_000))

    expect(big).toBe(profile.maxOutputTokens)
    expect(big).toBeGreaterThan(4_000)
  })
})

describe('fallbackBudget', () => {
  it('gives callers with no run context the conservative profile', () => {
    const budget = fallbackBudget({
      quality: 'medium',
      sourceLang: 'en',
      targetLang: 'my',
      terminologyScope: 'first',
      glossary: [],
    })

    expect(budget.unknown).toBe(true)
    expect(budget.contextWindow).toBe(UNKNOWN_CONTEXT_WINDOW)
  })
})
