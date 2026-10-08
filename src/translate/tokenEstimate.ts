/**
 * Token estimation — script-aware, with runtime calibration.
 *
 * Why this module exists: the estimator used to be `ceil(text.length / 3)`, a
 * ratio tuned for English. Burmese (and most non-Latin scripts) are sparsely
 * covered by BPE vocabularies, so a single Myanmar character routinely costs a
 * token or more. The underestimate does not stay small — it propagates into
 * three places that all assume the number is right:
 *
 *  1. the key pool's TPM bucket, so batches estimated at "1500 tokens" (really
 *     5–8K) were admitted three at a time — a permanent 429 storm against a
 *     free tier with an 8K TPM window;
 *  2. the completion cap in `budget.ts` (`maxOutputFor`), so long Burmese lines
 *     got truncated mid-JSON, the strict validator rejected the batch, the
 *     retry ladder split it, and the run burned *more* requests — a quota
 *     death spiral that looks like "the model cannot translate my document";
 *  3. the request forecast shown before a run starts.
 *
 * ASCII keeps the exact historical arithmetic (`count / 3`), so batches for
 * Latin-script documents are identical to what they were; only non-Latin
 * scripts pay a heavier, more realistic weight.
 *
 * The static weights are still a guess, so `recordTokenCalibration` closes the
 * loop: every provider response carries a real `usage.prompt_tokens`, and a run
 * compares predicted vs actual to nudge a scale factor. The estimate therefore
 * self-corrects within a handful of requests regardless of language, model or
 * tokenizer drift.
 */

/** Characters per token for ASCII — unchanged from the original estimator. */
export const ASCII_CHARS_PER_TOKEN = 3

/**
 * Per-script characters→tokens weights. Conservative on purpose: an
 * over-estimate costs a few extra requests, an under-estimate kills a run.
 */
export const SCRIPT_WEIGHTS = {
  myanmar: 1.1,
  thai: 0.95,
  devanagari: 0.9,
  arabic: 0.75,
  cjk: 0.7,
  hangul: 0.7,
  greek: 0.4,
  cyrillic: 0.4,
  latinExtended: 0.35,
  punctuation: 0.35,
  combiningMark: 0.5,
  unknown: 0.6,
} as const

/** Weight of one non-ASCII code unit; ASCII is handled separately. */
function weightOf(code: number): number {
  // Myanmar (Burmese) — the app's target script, and the reason this exists.
  if (
    (code >= 0x1000 && code <= 0x109f) || // Myanmar
    (code >= 0xa9e0 && code <= 0xa9ff) || // Myanmar Extended-A
    (code >= 0xaa60 && code <= 0xaa7f) // Myanmar Extended-B
  ) {
    return SCRIPT_WEIGHTS.myanmar
  }
  if (code >= 0x0e00 && code <= 0x0e7f) return SCRIPT_WEIGHTS.thai
  if (
    (code >= 0x0900 && code <= 0x097f) || // Devanagari
    (code >= 0xa8e0 && code <= 0xa8ff) // Devanagari Extended
  ) {
    return SCRIPT_WEIGHTS.devanagari
  }
  if (
    (code >= 0x0600 && code <= 0x06ff) || // Arabic
    (code >= 0x0750 && code <= 0x077f) || // Arabic Supplement
    (code >= 0x08a0 && code <= 0x08ff) || // Arabic Extended-A
    (code >= 0xfb50 && code <= 0xfdff) || // Arabic Presentation Forms-A
    (code >= 0xfe70 && code <= 0xfeff) // Arabic Presentation Forms-B
  ) {
    return SCRIPT_WEIGHTS.arabic
  }
  if (
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility
  ) {
    return SCRIPT_WEIGHTS.cjk
  }
  if (
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x3130 && code <= 0x318f) || // Hangul Compatibility Jamo
    (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
  ) {
    return SCRIPT_WEIGHTS.hangul
  }
  if (
    (code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff)
  ) {
    return SCRIPT_WEIGHTS.combiningMark
  }
  if (
    (code >= 0x0370 && code <= 0x03ff) || // Greek
    (code >= 0x1f00 && code <= 0x1fff) // Greek Extended
  ) {
    return SCRIPT_WEIGHTS.greek
  }
  if (code >= 0x0400 && code <= 0x052f) return SCRIPT_WEIGHTS.cyrillic
  if (code >= 0x0100 && code <= 0x024f) return SCRIPT_WEIGHTS.latinExtended
  if (code >= 0x00a0 && code <= 0x00ff) return SCRIPT_WEIGHTS.latinExtended // Latin-1 supplement
  if (code >= 0x2000 && code <= 0x206f) return SCRIPT_WEIGHTS.punctuation // general punctuation
  if (code >= 0x20a0 && code <= 0x20cf) return SCRIPT_WEIGHTS.punctuation // currency symbols
  // Unmapped script (and lone surrogates of astral characters): assume the worst.
  return SCRIPT_WEIGHTS.unknown
}

/**
 * Fractional, pre-scale estimate. ASCII is summed as a count and divided once,
 * which keeps Latin text bit-for-bit identical to the old `len / 3` result —
 * no float drift, no batch-boundary churn for English documents.
 */
export function baseTokenEstimate(text: string): number {
  let ascii = 0
  let weighted = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      ascii += 1
    } else {
      weighted += weightOf(code)
    }
  }
  return ascii / ASCII_CHARS_PER_TOKEN + weighted
}

/* ------------------------- runtime calibration --------------------------- */

const SCALE_MIN = 0.6
const SCALE_MAX = 4
const CALIBRATION_ALPHA = 0.3
/** A single sample may not claim the real ratio is outside this band. */
const SAMPLE_MIN = 0.25
const SAMPLE_MAX = 8
/**
 * Samples required before the scale is allowed to fall below 1. Shrinking the
 * scale makes batches *bigger*, so one noisy response must not be able to do
 * it early in a run.
 */
const SHRINK_AFTER_SAMPLES = 5

let scale = 1
let samples = 0

/** Current calibration multiplier applied to every estimate. */
export function tokenScale(): number {
  return scale
}

/** How many calibration samples a run has contributed so far. */
export function tokenSamples(): number {
  return samples
}

/**
 * Folds one observed `usage.prompt_tokens` reading into the scale.
 *
 * `predicted` must be the estimator's own view of the *same* request
 * (prompt + user message), otherwise the correction is meaningless. Providers
 * that report no usage pass 0 and are ignored.
 */
export function recordTokenCalibration(predicted: number, actual: number): number {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return scale
  if (predicted <= 0 || actual <= 0) return scale

  const sample = Math.min(SAMPLE_MAX, Math.max(SAMPLE_MIN, actual / predicted))
  // `predicted` already carries the current scale, so the scale the sample
  // implies is `scale * sample`. Averging toward it is an EWMA on the scale.
  const implied = scale * sample
  samples += 1
  let next = scale + CALIBRATION_ALPHA * (implied - scale)
  if (samples < SHRINK_AFTER_SAMPLES) next = Math.max(1, next)
  scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next))
  return scale
}

/** Back to the static weights (run start, and between test cases). */
export function resetTokenScale(): void {
  scale = 1
  samples = 0
}

/* ------------------------------ public API -------------------------------- */

/**
 * Estimated tokens for `text`, calibration included.
 *
 * This is the number the whole pipeline reasons with: batch budgets, the
 * key pool's TPM bucket and the output-token cap all call it.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(baseTokenEstimate(text) * scale))
}
