/**
 * Request budgeting — how much content may go into a single translation
 * request, computed from the model instead of guessed.
 *
 * Everything here exists because `ModelSpec.contextWindow` used to be display
 * metadata: nothing in the pipeline ever read it, so every batch carried a flat
 * 1500 source tokens regardless of whether the model had an 8K or a 1M window.
 * That was wrong in both directions at once — too big for the free tier's TPM
 * window once the Burmese underestimate is corrected, and far too small for a
 * big-context model, where timid batches multiply the *request* count and
 * requests (not tokens) are what free tiers actually ration.
 *
 * The profile is computed once per run and is the single source of truth for
 *   - `contentBudgetTokens` / `fillTargetTokens` — the chunker's fill target;
 *   - `maxOutputTokens` — the completion cap (long Burmese lines were being
 *     truncated mid-JSON because a flat 1.6× of an under-estimate is tiny);
 *   - `promptOverheadTokens` — *measured*, not assumed: the system prompt
 *     already carries up to 200 glossary lines.
 *
 * See `docs/TRANSLATION_ARCHITECTURE.md`.
 */

import { modelSpec, type ProviderId } from '@/config/models.config'
import { qualitySpec, systemPrompt } from './prompts'
import { estimateTokens } from './tokenEstimate'
import type { GlossarySpec, QualityLevel, TerminologyScope, TranslationBatch } from './types'

/** Share of the usable window we are willing to fill with source content. */
export const FILL_RATIO = 0.85
/** Never plan a request around less than this, however small the window. */
export const MIN_CONTENT_BUDGET = 1_024
/** Window assumed for imported / unlisted models (smallest bundled spec). */
export const UNKNOWN_CONTEXT_WINDOW = 16_384
/** Hard ceiling on requested completion tokens for this pipeline. */
export const DEFAULT_MAX_OUTPUT = 4_096
/** Source tokens → completion tokens for a first-pass translation. */
export const OUTPUT_RATIO = 1.6
/**
 * Tokens spent on the user message around the content: the numbered-line
 * framing, the JSON instruction, up to two neighbour context lines and the
 * repair suffix appended on a retry.
 */
export const USER_PROMPT_OVERHEAD_TOKENS = 256
/**
 * High quality re-sends source *and* draft in the review pass, so one unit of
 * content costs ~2× the window. The content budget shrinks accordingly instead
 * of the review request silently overflowing.
 */
export const REVIEW_COST_MULTIPLIER = 2.05
/**
 * Tokens the completion must hold besides the answer.
 *
 * Reasoning models (gpt-oss-120b on Groq, the nvidia free routes on
 * OpenRouter) spend completion tokens thinking before a single answer token
 * exists. With too little headroom a one-line rung asked for 256 tokens, the
 * model burned all 256 reasoning and answered with an empty body, validation
 * saw `empty` at every rung, the ladder gave up, and 60 of 64 live-translated
 * lines kept their English source (live sweep, Oct 2026). A non-reasoning
 * model simply stops at EOS and never spends the allowance, so the room costs
 * nothing on models that do not think.
 */
export const REASONING_HEADROOM_TOKENS = 2_048
/** Assumed tokens per visual line — only used to bound the line-count guard. */
export const AVG_LINE_TOKENS = 60

export interface BudgetProfile {
  /** Widest window any model in the chain can accept (the narrowest wins). */
  contextWindow: number
  /** Completion cap for one request on that window. */
  maxOutputTokens: number
  /** Measured system prompt + user framing, in tokens. */
  promptOverheadTokens: number
  /** Content tokens one request may carry, after overhead and output. */
  contentBudgetTokens: number
  /** What the chunker actually aims for (headroom for framing + drift). */
  fillTargetTokens: number
  /** Secondary guard: how many visual lines that much content plausibly is. */
  maxLines: number
  /** True when no bundled spec matched — imported or offline model. */
  unknown: boolean
}

export interface BudgetInput {
  /** Needed to look models up; omitted means "treat every model as unknown". */
  provider?: ProviderId
  /** Model chain — the narrowest window wins so fallbacks stay safe too. */
  models: string[]
  quality: QualityLevel
  sourceLang: string
  targetLang: string
  terminologyScope: TerminologyScope
  glossary: GlossarySpec[]
  /** Bypasses the registry entirely (tests, custom OpenAI-compatible setups). */
  contextWindow?: number
}

function isWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Completion cap for a model with this window.
 *
 * The flat 4k cap was the biggest single lever against the whole pipeline: the
 * content budget is derived from it, so on a 1M-window model it reduced a
 * window of a million tokens to about 1,280 usable source tokens per request —
 * a handful of lines at a time, and (before the budget was tied to the cap at
 * all) batches far larger than any completion could return.
 *
 * A model that accepts a very large window also allows a large completion, so
 * the cap now scales with the window. The steps are deliberately conservative:
 * a provider that clamps our request costs nothing, one that rejects it fails
 * the batch, so nothing is asked for that a model with that window could not
 * plausibly return. `ModelSpec.maxOutputTokens` overrides the derivation for a
 * model whose real cap is known.
 */
export const MEDIUM_CONTEXT_WINDOW = 60_000
export const MEDIUM_MAX_OUTPUT = 8_192
export const WIDE_CONTEXT_WINDOW = 200_000
export const WIDE_MAX_OUTPUT = 16_384

export function maxOutputForWindow(contextWindow: number): number {
  const derived =
    contextWindow >= WIDE_CONTEXT_WINDOW
      ? WIDE_MAX_OUTPUT
      : contextWindow >= MEDIUM_CONTEXT_WINDOW
        ? MEDIUM_MAX_OUTPUT
        : DEFAULT_MAX_OUTPUT
  return Math.max(256, Math.min(derived, contextWindow - MIN_CONTENT_BUDGET))
}

export function computeBudget(input: BudgetInput): BudgetProfile {
  const specs = input.models
    .map((model) => (input.provider ? modelSpec(input.provider, model) : undefined))
    .filter((spec) => spec !== undefined)

  const known = specs.map((spec) => spec.contextWindow).filter(isWindow)

  const contextWindow = isWindow(input.contextWindow)
    ? input.contextWindow
    : known.length > 0
      ? Math.min(...known)
      : UNKNOWN_CONTEXT_WINDOW

  // A model that publishes its own cap overrides the derived one, and the
  // narrowest model in the fallback chain still wins overall — a batch may be
  // served by any model that could end up serving it.
  const declared = specs.map((spec) => spec.maxOutputTokens).filter(isWindow)
  const maxOutputTokens =
    declared.length > 0 ? Math.min(...declared) : maxOutputForWindow(contextWindow)

  // The real prompt, measured. It embeds the whole glossary, which is *more*
  // than any single request now sends (`selectGlossary` trims a large one to
  // the terms a batch contains) — deliberately, so the budget never plans a
  // batch the fullest possible prompt would not leave room for.
  const promptOverheadTokens =
    estimateTokens(
      systemPrompt({
        quality: input.quality,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        glossary: input.glossary,
        terminologyScope: input.terminologyScope,
      }),
    ) + USER_PROMPT_OVERHEAD_TOKENS

  const usable = contextWindow - promptOverheadTokens - maxOutputTokens
  const divisor = qualitySpec(input.quality).review ? REVIEW_COST_MULTIPLIER : 1
  const windowBudget = Math.round(usable / divisor)
  /**
   * The *completion*, not the window, is what actually binds. Whatever a batch
   * carries has to come back translated inside `maxOutputTokens`, and Burmese
   * grows on the way out, so the most content a request can usefully hold is
   * what the allowance minus the reasoning headroom can express.
   *
   * Sized from the window alone this was ~885k tokens for a 1M-window model —
   * a number no completion could ever hold against a flat 4k cap. Dense pages
   * then came back as JSON cut off mid-array, failed validation, and paid for a
   * repair retry with the same oversized payload: quota spent on answers that
   * could not exist.
   */
  const expressible = Math.max(
    0,
    Math.floor((maxOutputTokens - REASONING_HEADROOM_TOKENS) / OUTPUT_RATIO),
  )
  const contentBudgetTokens = Math.max(
    MIN_CONTENT_BUDGET,
    Math.round(Math.min(windowBudget, expressible) / divisor),
  )
  const fillTargetTokens = Math.ceil(contentBudgetTokens * FILL_RATIO)

  return {
    contextWindow,
    maxOutputTokens,
    promptOverheadTokens,
    contentBudgetTokens,
    fillTargetTokens,
    maxLines: Math.max(1, Math.floor(contentBudgetTokens / AVG_LINE_TOKENS)),
    unknown: known.length === 0 && !isWindow(input.contextWindow),
  }
}

export function maxOutputFor(profile: BudgetProfile, batch: TranslationBatch): number {
  const wanted = Math.round(batch.tokens * OUTPUT_RATIO) + REASONING_HEADROOM_TOKENS
  return Math.min(profile.maxOutputTokens, Math.max(256, wanted))
}

/** Sensible profile for callers that have no run context (tests, previews). */
export function fallbackBudget(
  options: Pick<
    BudgetInput,
    'quality' | 'sourceLang' | 'targetLang' | 'terminologyScope' | 'glossary'
  >,
): BudgetProfile {
  return computeBudget({ models: [], ...options })
}
