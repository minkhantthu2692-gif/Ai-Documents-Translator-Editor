/**
 * Prompt templates per quality level.
 *
 * Quality levels (temperature is always kept low — this is translation, not
 * ideation):
 *   Basic  — small model, single pass, no context.
 *   Medium — neighbour context + glossary enforcement.
 *   High   — context + glossary + a terminology/review pass + a consistency
 *            pass (the review call lives in `engine.ts`).
 *
 * The rules that decide the *shape* of the answer (JSON, ids, Burmese script,
 * terminology annotations, placeholders) are written here once and the
 * post-processor in `terminology.ts` re-checks them — the prompt is a
 * requirement, the post-processor is the guarantee.
 */

import type {
  GlossarySpec,
  QualityLevel,
  QualitySpec,
  PromptContext,
  TranslationBatch,
} from './types'

export const QUALITY_SPECS: Record<QualityLevel, QualitySpec> = {
  basic: {
    level: 'basic',
    temperature: 0.3,
    review: false,
    context: false,
    glossary: false,
    tier: 'basic',
  },
  medium: {
    level: 'medium',
    temperature: 0.2,
    review: false,
    context: true,
    glossary: true,
    tier: 'standard',
  },
  high: {
    level: 'high',
    temperature: 0.1,
    review: true,
    context: true,
    glossary: true,
    tier: 'premium',
  },
}

export function qualitySpec(level: QualityLevel): QualitySpec {
  return QUALITY_SPECS[level]
}

export function temperatureFor(level: QualityLevel): number {
  return QUALITY_SPECS[level].temperature
}

const TERMINOLOGY_RULE = `Terminology: for technical, engineering, scientific, medical, legal or IT terms and proper nouns, write the term as TranslatedTerm(OriginalTerm) — translated first, then the original in ASCII parentheses "(" ")" with NO space before the parenthesis. Example (Myanmar target): ပန်းသီး(apple).
If a term has no good translation, keep the original word alone (no annotation).`

const OUTPUT_RULE = `Return ONLY JSON in exactly this shape, with one entry per input line and nothing else:
{"items":[{"id":"<the id given for the line>","t":"<your translation>"}]}
No commentary, no markdown, no extra keys. Keep every {{n}} placeholder exactly as it appears. Never drop a line.`

const SCRIPT_RULE_MY = `Target script: standard written Burmese in Unicode (ံ ိ ် etc.). Never produce Zawgyi. Line height and wording must suit a document, not chat.`

export interface SystemPromptOptions {
  quality: QualityLevel
  sourceLang: string
  targetLang: string
  glossary: GlossarySpec[]
  /** Frequency rule echoed back to the model (post-processor enforces it). */
  terminologyScope: 'first' | 'document' | 'every'
  /** True for OCR-derived lines (image text translation). */
  fromImage?: boolean
}

function glossaryBlock(glossary: GlossarySpec[]): string {
  if (glossary.length === 0) return ''
  const lines = glossary
    .slice(0, 200)
    .map((entry) => `- "${entry.sourceTerm}" = "${entry.targetTerm}"`)
    .join('\n')
  return `Glossary (use these exact target terms whenever the source term appears):
${lines}
`
}

function scopeSentence(scope: 'first' | 'document' | 'every'): string {
  if (scope === 'every') return 'Annotate every occurrence.'
  if (scope === 'document') return 'Annotate only the first occurrence in the document.'
  return 'Annotate only the first occurrence on each page.'
}

/** The system prompt for one run (never contains user data). */
export function systemPrompt(options: SystemPromptOptions): string {
  const spec = qualitySpec(options.quality)
  const parts: string[] = []

  parts.push(
    `You are a professional document translator. Translate from ${options.sourceLang} to ${options.targetLang}. This is a PDF layout extraction: each line is a visual line of the original document, so the translation must read naturally *line by line* while staying faithful to the source.`,
  )

  if (options.fromImage) {
    parts.push(
      'The source lines come from OCR of an image inside the document — expect recognition noise and translate the intent of the line.',
    )
  }

  parts.push(
    'Rules:\n' +
      '1. Translate the meaning, do not explain, do not add or remove content.\n' +
      '2. Keep numbers, units, dates, formulas, code and {{n}} placeholders unchanged.\n' +
      '3. Keep the list marker out of the text (it is re-attached after translation).\n' +
      '4. One output entry per input line, same ids, same order.\n' +
      `5. ${TERMINOLOGY_RULE}\n6. ${scopeSentence(options.terminologyScope)}`,
  )

  if (options.targetLang === 'my') parts.push(SCRIPT_RULE_MY)
  if (spec.glossary) parts.push(glossaryBlock(options.glossary).trimEnd())
  if (spec.context) {
    parts.push(
      'Use the neighbouring lines as context for consistent terminology, but translate only the numbered input lines.',
    )
  }
  if (spec.review) {
    parts.push(
      'Prefer precise domain terminology over a literal wording, and keep repeated terms consistent with the context lines.',
    )
  }

  parts.push(OUTPUT_RULE)
  return parts.filter((part) => part && part.trim().length > 0).join('\n\n')
}

/** The numbered user message carrying the actual lines. */
export function userPrompt(batch: TranslationBatch, context?: PromptContext | null): string {
  const parts: string[] = []
  if (context && (context.before || context.after)) {
    const contextLines: string[] = []
    if (context.before) contextLines.push(`Previous line (context only): ${context.before}`)
    if (context.after) contextLines.push(`Next line (context only): ${context.after}`)
    parts.push(contextLines.join('\n'))
  }
  const lines = batch.lines
    .map((line, index) => `${index + 1}. [id=${line.id}] ${line.text}`)
    .join('\n')
  parts.push(lines)
  parts.push('Translate every numbered line into JSON now.')
  return parts.join('\n\n')
}

/**
 * High-quality review pass: send source + first-pass translation back and ask
 * for corrections (terminology, consistency, grammar) in the same JSON shape.
 */
export function reviewPrompt(
  batch: TranslationBatch,
  firstPass: Array<{ id: string; t: string }>,
  options: { sourceLang: string; targetLang: string; glossary: GlossarySpec[] },
): string {
  const pairs = batch.lines
    .map((line, index) => {
      const translated = firstPass[index]?.t ?? ''
      return `${index + 1}. [id=${line.id}]\n   source: ${line.text}\n   draft: ${translated}`
    })
    .join('\n')

  const glossary = glossaryBlock(options.glossary)
  return `You are reviewing your own translation draft from ${options.sourceLang} to ${options.targetLang}.
Fix grammar, terminology and inconsistency. Apply the glossary exactly. Keep {{n}} placeholders.
${glossary}
Return ONLY JSON: {"items":[{"id":"…","t":"<corrected translation>"}]} with every id present.

${pairs}`
}

/** Short instruction prepended when a batch is retried after bad JSON. */
export const REPAIR_SUFFIX =
  '\n\nYour previous answer was rejected by a strict validator. Return valid JSON with exactly the requested ids and count.'

/** Maximum completion size for a batch (protects the free tier). */
export function maxOutputTokensFor(batch: TranslationBatch): number {
  // ~1.6x the source estimate, clamped to a sane window.
  return Math.min(4_000, Math.max(256, Math.round(batch.tokens * 1.6)))
}
