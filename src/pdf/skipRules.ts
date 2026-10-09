/**
 * Skip-rule classifier.
 *
 * Decides which extracted lines should *not* be sent for translation: page
 * numbers, pure numbers, URLs, e-mail addresses, code fragments, formulas,
 * symbol-only rows and text that is already written in the target language.
 * Every decision carries a machine readable rule so the review UI can explain
 * "why was this line skipped?" in both languages.
 */

import { looksLikeLanguage } from '@/core/langDetect'
import { looksLikeFormula } from './placeholders'

export type SkipRule =
  | 'empty'
  | 'whitespace'
  | 'number'
  | 'url'
  | 'email'
  | 'code'
  | 'formula'
  | 'punctuation'
  | 'alreadyTarget'

export interface SkipContext {
  /** ISO code of the project's target language (e.g. `my`). */
  targetLang?: string | null
  /** ISO code of the project's source language (e.g. `en`). */
  sourceLang?: string | null
}

export interface SkipDecision {
  skip: boolean
  rule: SkipRule | null
  /** Short technical detail for the event log. */
  detail: string
}

const MYANMAR_DIGITS = /^[\u1040-\u1049\s.\-–—/]*$/
const PLAIN_NUMBER = /^[+-]?\s*\d[\d\s.,:/\-–—%]*$/
const ROMAN_NUMERAL = /^[ivxlcdmIVXLCDM]{2,8}$/
const PAGE_LABEL = /^(?:page|pp?|p\.|စာမျက်နှာ)\s*[:.]?\s*[\d\u1040-\u1049]+$/i
const URL = /^(?:https?:\/\/|www\.)\S+$/i
const BARE_URL = /\b(?:https?:\/\/|www\.)\S+/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\s]+$/u

/** Code-ish signals: braces, statement terminators, call syntax, keywords. */
const CODE_KEYWORD =
  /\b(?:const|let|var|function|import|export|class|def|public|private|SELECT|INSERT|UPDATE|DELETE)\b/
const CODE_CALL = /\b(?:if|for|while|switch|catch|return)\s*\(/
const CODE_PUNCTUATION = /[{};]|=>|<\/|\/>|::|&&|\|\|/

function countLatinLetters(text: string): number {
  const matches = text.match(/[A-Za-z]/g)
  return matches ? matches.length : 0
}

/**
 * True when a line's *content* reads as code rather than prose: braces, a
 * statement terminator, call syntax or a keyword, with enough Latin letters
 * behind it that it is not a stray `};`.
 *
 * Deliberately requires a punctuation signal (`for`/`class` alone appear in
 * prose — "for the estimate", "a new class of users"), so it is exported for
 * the block-level detector in `codeBlocks.ts` to reuse. One definition means a
 * line the translator skips and a block the exporters fence are the same line.
 */
export function looksLikeCodeFragment(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  const latinLetters = countLatinLetters(trimmed)
  const hasCodePunctuation = CODE_PUNCTUATION.test(trimmed)
  const codeScore =
    (CODE_CALL.test(trimmed) ? 2 : 0) +
    (CODE_KEYWORD.test(trimmed) ? 2 : 0) +
    (hasCodePunctuation ? 1 : 0) +
    (trimmed.includes(';') ? 1 : 0)
  return hasCodePunctuation && codeScore >= 2 && latinLetters > 4
}

/**
 * Classifies a single line. Order matters: cheap structural rules first, then
 * language-aware rules, so a Myanmar page number is caught as `number` rather
 * than `alreadyTarget`.
 */
export function classifyLine(text: string, ctx: SkipContext = {}): SkipDecision {
  if (text == null) return { skip: true, rule: 'empty', detail: 'null text' }
  if (text.length === 0) return { skip: true, rule: 'empty', detail: 'empty text' }
  if (!text.trim()) return { skip: true, rule: 'whitespace', detail: 'whitespace only' }

  const trimmed = text.trim()

  if (URL.test(trimmed) || BARE_URL.test(trimmed)) {
    return { skip: true, rule: 'url', detail: 'URL' }
  }
  if (EMAIL.test(trimmed)) return { skip: true, rule: 'email', detail: 'e-mail address' }

  if (
    PLAIN_NUMBER.test(trimmed) ||
    MYANMAR_DIGITS.test(trimmed) ||
    ROMAN_NUMERAL.test(trimmed) ||
    PAGE_LABEL.test(trimmed)
  ) {
    return { skip: true, rule: 'number', detail: 'number / page label' }
  }

  if (looksLikeCodeFragment(trimmed)) {
    return { skip: true, rule: 'code', detail: 'code fragment' }
  }

  if (looksLikeFormula(trimmed)) {
    return { skip: true, rule: 'formula', detail: 'mathematical expression' }
  }

  if (PUNCTUATION_ONLY.test(trimmed)) {
    return { skip: true, rule: 'punctuation', detail: 'symbols only' }
  }

  if (ctx.targetLang && looksLikeLanguage(trimmed, ctx.targetLang)) {
    return { skip: true, rule: 'alreadyTarget', detail: `already ${ctx.targetLang}` }
  }

  return { skip: false, rule: null, detail: 'translatable' }
}

/** Convenience wrapper used by the review UI and the translation job. */
export function shouldTranslate(text: string, ctx: SkipContext = {}): boolean {
  return !classifyLine(text, ctx).skip
}

/** Counts how many lines each rule swallowed (drives the pre-flight summary). */
export function summarizeSkips(lines: string[], ctx: SkipContext = {}): Record<string, number> {
  const summary: Record<string, number> = {}
  for (const line of lines) {
    const decision = classifyLine(line, ctx)
    if (!decision.skip || !decision.rule) continue
    summary[decision.rule] = (summary[decision.rule] ?? 0) + 1
  }
  return summary
}
