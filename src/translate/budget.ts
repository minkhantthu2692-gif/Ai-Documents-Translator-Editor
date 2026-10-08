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
 * Completion cap derived from the window: a large share of it, but never more
 * than the model could possibly hold alongside the prompt and a minimal body.
 */
export function maxOutputForWindow(contextWindow: number): number {
  return Math.max(
    256,
    Math.min(
      DEFAULT_MAX_OUTPUT,
      Math.round(contextWindow * 0.4),
      contextWindow - MIN_CONTENT_BUDGET,
    ),
  )
}

export function computeBudget(input: BudgetInput): BudgetProfile {
  const known = input.models
    .map((model) => (input.provider ? modelSpec(input.provider, model) : undefined))
    .map((spec) => spec?.contextWindow)
    .filter(isWindow)

  const contextWindow = isWindow(input.contextWindow)
    ? input.contextWindow
    : known.length > 0
      ? Math.min(...known)
      : UNKNOWN_CONTEXT_WINDOW

  const maxOutputTokens = maxOutputForWindow(contextWindow)

  // The real prompt, measured: it already embeds the glossary when the quality
  // level uses one, so a 200-entry glossary is accounted for automatically.
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
  const contentBudgetTokens = Math.max(MIN_CONTENT_BUDGET, Math.round(usable / divisor))
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

/**
 * Completion cap for one batch: proportional to what is actually being sent,
 * clamped by the model instead of by a flat 4000.
 */
export function maxOutputFor(profile: BudgetProfile, batch: TranslationBatch): number {
  const wanted = Math.round(batch.tokens * OUTPUT_RATIO)
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
