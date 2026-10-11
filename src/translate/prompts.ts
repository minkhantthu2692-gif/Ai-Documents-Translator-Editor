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

import { estimateTokens } from './tokenEstimate'
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

/**
 * Hard cap on how many glossary entries one prompt may carry. `glossaryBlock`
 * truncates past it, and the rolling glossary refuses to grow past it too — one
 * number, two consumers.
 */
export const GLOSSARY_CAP = 200

function glossaryBlock(glossary: GlossarySpec[]): string {
  if (glossary.length === 0) return ''
  const lines = glossary
    .slice(0, GLOSSARY_CAP)
    .map((entry) => `- "${entry.sourceTerm}" = "${entry.targetTerm}"`)
    .join('\n')
  return `Glossary (use these exact target terms whenever the source term appears):
${lines}
`
}

/**
 * Token ceiling for the glossary a single request may carry.
 */
export const GLOSSARY_PROMPT_TOKENS = 384

const STARTS_LATIN = /^[a-z0-9]/i
const isWordChar = (character: string): boolean => /[\p{L}\p{N}]/u.test(character)

/**
 * Which entries a batch could actually use, claimed longest match first.
 *
 * A plain `includes` is not enough: `alpha1` "occurs" inside `alpha11`, so on a
 * real glossary most entries appear to match most batches, the filter keeps
 * almost everything, and it saves nothing. Occurrences are therefore claimed
 * longest-first, so a shorter term survives only where no longer one already
 * covers its characters — which keeps the inflected form (`alpha12` inside
 * `alpha12s`) while dropping the false friend.
 *
 * Latin-ish terms additionally need a left word boundary, so `etch` is not
 * found inside `kitchen`. Terms in a script written without spaces — Burmese,
 * Thai, Chinese — get no such test, because there every neighbour is a letter
 * and the test would reject every one of them.
 */
function relevantEntries(glossary: GlossarySpec[], haystack: string): Set<number> {
  const claimed: Array<[number, number]> = []
  const keep = new Set<number>()

  const candidates = glossary
    .map((entry, index) => ({ index, term: entry.sourceTerm.trim().toLowerCase() }))
    .filter((candidate) => candidate.term.length > 0)
    .sort((a, b) => b.term.length - a.term.length)

  for (const candidate of candidates) {
    const { index, term } = candidate
    const needsBoundary = STARTS_LATIN.test(term)
    let from = 0
    for (;;) {
      const at = haystack.indexOf(term, from)
      if (at < 0) break
      const before = at === 0 ? '' : haystack[at - 1]
      const overlaps = claimed.some(([start, end]) => at < end && start < at + term.length)
      if (!overlaps && (!needsBoundary || !isWordChar(before))) {
        claimed.push([at, at + term.length])
        keep.add(index)
        break
      }
      from = at + 1
    }
  }
  return keep
}

/**
 * The glossary entries worth sending with *this* batch.
 *
 * `glossaryBlock` sends the whole document glossary, and once a project has a
 * real one that is the largest cost in the prompt: 200 entries is ~1,900
 * tokens against a fixed prompt of ~511. Measured on the bundled models, a
 * request therefore spent 2,658 tokens of preamble to carry ~3,600 of content
 * — 42% of everything sent, repeated on every request, whether or not the batch
 * contained a single glossary term. On a free tier that meters tokens per day,
 * that share is the difference between a book and several books per key.
 *
 * A batch only needs the terms that occur in it. Small glossaries are still
 * sent whole — they fit the ceiling, so filtering them buys nothing and would
 * only risk dropping a term the matcher missed through inflection. A large one
 * is cut to the entries the batch can use, in document order, until the ceiling
 * is reached.
 */
export function selectGlossary(
  glossary: GlossarySpec[],
  batchText: string,
  tokenBudget: number = GLOSSARY_PROMPT_TOKENS,
): GlossarySpec[] {
  if (glossary.length === 0) return glossary
  if (estimateTokens(glossaryBlock(glossary)) <= tokenBudget) return glossary

  const keep = relevantEntries(glossary, batchText.toLowerCase())
  const kept: GlossarySpec[] = []
  let used = 0
  for (let index = 0; index < glossary.length; index += 1) {
    if (!keep.has(index)) continue
    const cost = estimateTokens(glossaryBlock([glossary[index]]))
    if (used + cost > tokenBudget) break
    kept.push(glossary[index])
    used += cost
  }
  return kept
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
  // Section first: it is the cheapest and most useful of the context lines, and
  // it still applies when a batch happens to sit at a page boundary where there
  // is no neighbouring line to offer.
  const contextLines: string[] = []
  if (context?.section) contextLines.push(`Section heading (context only): ${context.section}`)
  if (context?.sectionTranslation && context.sectionTranslation !== context.section) {
    contextLines.push(`Already translated as (context only): ${context.sectionTranslation}`)
  }
  if (context?.before) contextLines.push(`Previous line (context only): ${context.before}`)
  if (context?.after) contextLines.push(`Next line (context only): ${context.after}`)
  if (contextLines.length > 0) parts.push(contextLines.join('\n'))

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
