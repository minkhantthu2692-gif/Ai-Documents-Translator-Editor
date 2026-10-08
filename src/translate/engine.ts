/**
 * Batch engine — one batch in, ordered results out.
 *
 * Pipeline for a batch:
 *
 *   build prompts → executor (key rotation, 429 handling, model fallback)
 *     → strict validation
 *       → on failure: halve the batch → line-by-line → keep the original
 *     → (High) review pass over the same ids
 *     → post-processing: restore `{{n}}` placeholders, enforce the glossary,
 *       normalise `TranslatedTerm(OriginalTerm)`, keep original when unusable
 *     → confidence + flags
 *
 * The ladder never drops or reorders a line: every input id has exactly one
 * output, even when the model refused to cooperate (that line keeps its source
 * text, is flagged and drags the page's quality score down).
 *
 * Pure async code with injected pool/transport/sleep so the 429-storm and
 * fallback tests run without a worker, a network or a clock.
 */

import { missingPlaceholders, restorePlaceholders } from '@/pdf/placeholders'
import type { TranslateCall } from '@/providers/types'
import { splitBatch, splitToLines } from './batching'
import { fallbackBudget, maxOutputFor, type BudgetProfile } from './budget'
import { validateResponse, type Validation } from './batchValidation'
import { executeWithRotation, type BatchTransport, type ExecutorHooks } from './executor'
import type { KeyPool } from './keyPool'
import {
  qualitySpec,
  REPAIR_SUFFIX,
  reviewPrompt,
  systemPrompt,
  temperatureFor,
  userPrompt,
} from './prompts'
import { estimateTokens, recordTokenCalibration } from './tokenEstimate'
import { postProcessTranslation } from './terminology'
import type {
  BatchResultLine,
  BatchRunResult,
  GlossarySpec,
  PromptContext,
  QualityLevel,
  TerminologyScope,
  TranslationBatch,
  TranslationFlag,
} from './types'

export interface EngineOptions {
  quality: QualityLevel
  sourceLang: string
  targetLang: string
  terminologyScope: TerminologyScope
  glossary: GlossarySpec[]
  /** Ordered model chain (selected first, then fallbacks). */
  models: string[]
  pool: KeyPool
  transport: BatchTransport
  /** Neighbouring lines of the same page (Medium and up). */
  context?: PromptContext | null
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  hooks?: ExecutorHooks
  maxConsecutiveFailures?: number
  /**
   * Size limits for the model chain (context window, completion cap, content
   * budget). Computed once per run by `computeBudget`; when omitted the engine
   * falls back to the conservative unknown-model profile so a batch can never
   * exceed a window nobody told it about.
   */
  budget?: BudgetProfile
  /**
   * Fold the provider's reported `usage.prompt_tokens` into the token
   * estimator. Off by default so tests stay deterministic; the production run
   * (`translation.worker.ts`) turns it on.
   */
  calibrate?: boolean
  /** Page-scoped terminology state — owned by the caller, mutated here. */
  seenPage: Set<string>
  /** Document-scoped terminology state (scope `document`). */
  seenDocument: Set<string>
  /** Called once per provider round trip (progress / ETA / usage). */
  onRequest?: (info: {
    tokensIn: number
    tokensOut: number
    latencyMs: number
    model: string
    keyId: string
    maskedKey: string
  }) => void
}

interface LadderResult {
  lines: BatchResultLine[]
  /** Attempts beyond the first for these lines (the line was retried). */
  retried: boolean
  /** The ladder gave up and kept the source text. */
  gaveUp: boolean
}

const FLAG_PRIORITY: TranslationFlag[] = [
  'placeholder-miss',
  'glossary-miss',
  'kept-original',
  'retried',
  'low-confidence',
]

function stronger(a: TranslationFlag | null, b: TranslationFlag | null): TranslationFlag | null {
  if (a === null) return b
  if (b === null) return a
  return FLAG_PRIORITY.indexOf(a) <= FLAG_PRIORITY.indexOf(b) ? a : b
}

export async function runBatch(
  batch: TranslationBatch,
  options: EngineOptions,
): Promise<BatchRunResult> {
  const started = Date.now()
  const stats = {
    requests: 0,
    retries: 0,
    tokensIn: 0,
    tokensOut: 0,
    keyId: null as string | null,
    model: options.models[0] ?? '',
    latencyMs: 0,
  }

  const spec = qualitySpec(options.quality)
  const system = systemPrompt({
    quality: options.quality,
    sourceLang: options.sourceLang,
    targetLang: options.targetLang,
    glossary: options.glossary,
    terminologyScope: options.terminologyScope,
  })
  const budget =
    options.budget ??
    fallbackBudget({
      quality: options.quality,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      terminologyScope: options.terminologyScope,
      glossary: options.glossary,
    })

  const executorHooks: ExecutorHooks = {
    ...options.hooks,
    onModelFallback: (model) => {
      stats.model = model
      options.hooks?.onModelFallback?.(model)
    },
    onLease: (lease, model) => {
      stats.keyId = lease.keyId
      stats.model = model
      options.hooks?.onLease?.(lease, model)
    },
  }

  async function attempt(target: TranslationBatch, useRepair: boolean): Promise<Validation> {
    const user = userPrompt(target, options.context ?? null) + (useRepair ? REPAIR_SUFFIX : '')
    const call: TranslateCall = {
      model: stats.model,
      system,
      user,
      temperature: temperatureFor(options.quality),
      maxOutputTokens: maxOutputFor(budget, target),
    }
    const outcome = await executeWithRotation(() => call, {
      pool: options.pool,
      models: options.models,
      transport: options.transport,
      tokenEstimate: estimateTokens(target.lines.map((line) => line.text).join('\n')),
      signal: options.signal,
      now: options.now,
      sleep: options.sleep,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      hooks: executorHooks,
    })

    stats.requests += outcome.attempts
    stats.retries += Math.max(0, outcome.attempts - 1)
    stats.tokensIn += outcome.tokensIn
    stats.tokensOut += outcome.tokensOut
    stats.latencyMs += outcome.latencyMs
    stats.keyId = outcome.keyId
    stats.model = outcome.model
    options.onRequest?.({
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      latencyMs: outcome.latencyMs,
      model: outcome.model,
      keyId: outcome.keyId,
      maskedKey: outcome.maskedKey,
    })

    // The provider told us the truth about the prompt size — let it correct
    // the estimator for the rest of the run (and every later batch).
    if (options.calibrate) {
      recordTokenCalibration(estimateTokens(system) + estimateTokens(user), outcome.tokensIn)
    }

    return validateResponse(outcome.text, target)
  }

  /** Try → halve → line-by-line → keep the original. Always ordered. */
  async function ladder(target: TranslationBatch, depth: number): Promise<LadderResult> {
    const validation = await attempt(target, false)
    if (validation.ok) {
      return {
        lines: validation.lines,
        retried: depth > 0 || target !== batch,
        gaveUp: false,
      }
    }

    if (target.lines.length > 1) {
      if (depth === 0) {
        // First fallback: a smaller batch (the same ids, half the lines).
        const halves = splitBatch(target)
        if (halves.length === 2) {
          const left = await ladder(halves[0], depth + 1)
          const right = await ladder(halves[1], depth + 1)
          return {
            lines: [...left.lines, ...right.lines],
            retried: true,
            gaveUp: left.gaveUp || right.gaveUp,
          }
        }
      } else {
        // The smaller batch failed too: line-by-line, one request per line.
        const singles = splitToLines(target)
        const lines: BatchResultLine[] = []
        let gaveUp = false
        for (const single of singles) {
          const result = await ladder(single, depth + 1)
          lines.push(...result.lines)
          gaveUp = gaveUp || result.gaveUp
        }
        return { lines, retried: true, gaveUp }
      }
    }

    // Single line: one more try with the repair instruction, then keep it.
    if (target.lines.length === 1) {
      const repaired = await attempt(target, true)
      if (repaired.ok) {
        return { lines: repaired.lines, retried: true, gaveUp: false }
      }
      const line = target.lines[0]
      return {
        lines: [
          {
            id: line.id,
            text: line.text,
            confidence: 0.2,
            flag: 'kept-original',
          },
        ],
        retried: true,
        gaveUp: true,
      }
    }

    const singles = splitToLines(target)
    const lines: BatchResultLine[] = []
    let gaveUp = false
    for (const single of singles) {
      const result = await ladder(single, depth + 1)
      lines.push(...result.lines)
      gaveUp = gaveUp || result.gaveUp
    }
    return { lines, retried: true, gaveUp }
  }

  const ladderResult = await ladder(batch, 0)
  let texts = new Map(ladderResult.lines.map((line) => [line.id, line]))
  let reviewApplied = false

  /* ---------------- High quality: review / verification pass ----------- */
  if (spec.review && !ladderResult.gaveUp) {
    const draft = batch.lines.map((line) => ({
      id: line.id,
      t: texts.get(line.id)?.text ?? line.text,
    }))
    try {
      const reviewCall: TranslateCall = {
        model: stats.model,
        system,
        user: reviewPrompt(batch, draft, {
          sourceLang: options.sourceLang,
          targetLang: options.targetLang,
          glossary: options.glossary,
        }),
        temperature: temperatureFor(options.quality),
        maxOutputTokens: maxOutputFor(budget, batch),
      }
      const outcome = await executeWithRotation(() => reviewCall, {
        pool: options.pool,
        models: options.models,
        transport: options.transport,
        tokenEstimate: estimateTokens(draft.map((item) => item.t).join('\n')),
        signal: options.signal,
        now: options.now,
        sleep: options.sleep,
        maxConsecutiveFailures: options.maxConsecutiveFailures,
        hooks: executorHooks,
      })
      stats.requests += outcome.attempts
      stats.tokensIn += outcome.tokensIn
      stats.tokensOut += outcome.tokensOut
      stats.latencyMs += outcome.latencyMs
      options.onRequest?.({
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        latencyMs: outcome.latencyMs,
        model: outcome.model,
        keyId: outcome.keyId,
        maskedKey: outcome.maskedKey,
      })

      const reviewed = validateResponse(outcome.text, batch)
      if (reviewed.ok) {
        const reviewedMap = new Map(reviewed.lines.map((line) => [line.id, line.text]))
        texts = new Map(
          [...texts].map(([id, line]) => [id, { ...line, text: reviewedMap.get(id) ?? line.text }]),
        )
        reviewApplied = true
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      // A failed review pass never invalidates a good first pass.
    }
  }

  /* ---------------- Post-processing ----------------------------------- */
  const seenPage = options.seenPage
  const seenDocument = options.seenDocument

  const lines: BatchResultLine[] = batch.lines.map((line) => {
    const ladderLine = texts.get(line.id)
    const rawText = ladderLine?.text ?? line.text
    let confidence = ladderLine?.confidence ?? 1
    let flag: TranslationFlag | null = ladderLine?.flag ?? null

    const missing =
      line.placeholders.length > 0 ? missingPlaceholders(rawText, line.placeholders) : []
    const restored =
      line.placeholders.length > 0 ? restorePlaceholders(rawText, line.placeholders) : rawText
    if (missing.length > 0) {
      confidence -= 0.35
      flag = stronger(flag, 'placeholder-miss')
    }

    const processed = postProcessTranslation(line.text, restored, options.glossary, {
      scope: options.terminologyScope,
      seenPage,
      seenDocument,
      sourceText: line.text,
    })

    if (processed.keptOriginal) {
      confidence -= 0.5
      flag = stronger(flag, 'kept-original')
    }
    if (processed.glossaryMisses.length > 0) {
      confidence -= 0.3
      flag = stronger(flag, 'glossary-miss')
    } else if (processed.glossaryFixes.length > 0) {
      confidence -= 0.1
      flag = stronger(flag, 'glossary-miss')
    }
    if (ladderResult.retried && !reviewApplied) {
      confidence -= 0.1
      flag = stronger(flag, 'retried')
    }

    confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(3))))
    if (confidence < 0.7) flag = stronger(flag, 'low-confidence') ?? flag

    return { id: line.id, text: processed.text, confidence, flag }
  })

  return {
    batchId: batch.id,
    lines,
    requests: stats.requests,
    tokensIn: stats.tokensIn,
    tokensOut: stats.tokensOut,
    keyId: stats.keyId,
    model: stats.model,
    latencyMs: Date.now() - started,
  }
}
