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
  MIN_CONTENT_BUDGET,
  UNKNOWN_CONTEXT_WINDOW,
  USER_PROMPT_OVERHEAD_TOKENS,
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
    expect(budget.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT)
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

  it('accounts for the glossary it is actually going to send', () => {
    const without = computeBudget(BASE)
    const withGlossary = computeBudget({ ...BASE, glossary: GLOSSARY })

    expect(withGlossary.promptOverheadTokens).toBeGreaterThan(without.promptOverheadTokens)
    expect(withGlossary.contentBudgetTokens).toBeLessThan(without.contentBudgetTokens)
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
  it('caps the completion at the model budget and the window', () => {
    expect(maxOutputForWindow(1_048_576)).toBe(DEFAULT_MAX_OUTPUT)
    expect(maxOutputForWindow(16_385)).toBe(DEFAULT_MAX_OUTPUT)
    expect(maxOutputForWindow(8_192)).toBeLessThan(8_192)
    expect(maxOutputForWindow(1_500)).toBeLessThanOrEqual(1_500 - MIN_CONTENT_BUDGET)
  })
})

describe('maxOutputFor', () => {
  const profile = computeBudget({ ...BASE, provider: 'openai', models: ['gpt-4o-mini'] })

  it('scales with what is actually being sent', () => {
    expect(maxOutputFor(profile, batchOf(100))).toBe(256)
    expect(maxOutputFor(profile, batchOf(1_500))).toBe(2_400)
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
