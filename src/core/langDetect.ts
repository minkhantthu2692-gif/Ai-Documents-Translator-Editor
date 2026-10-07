/**
 * Lightweight language detection.
 *
 * Two-stage heuristic, no model downloads:
 *   1. Unicode-range script histogram (Myanmar, Thai, CJK, Hangul, Devanagari…)
 *   2. stop-word / diacritic scoring to separate Latin-script languages
 *
 * Good enough to (a) pre-fill the source language, (b) tell the user when a
 * line is already written in the target language (skip rule) and (c) detect
 * legacy Zawgyi-encoded Myanmar text, which the zawgyi module refines.
 */

export interface LangDetection {
  /** Best-effort language code, or null when the text is too short/mixed. */
  lang: string | null
  /** Dominant script: myanmar | thai | latin | han | kana | hangul | devanagari | arabic | cyrillic | other */
  script: string
  /** 0..1 — how dominant the winning signal is. */
  confidence: number
  /** Per-candidate scores (script histogram or Latin stop-word hits). */
  scores: Record<string, number>
}

interface ScriptRule {
  script: string
  test: (code: number) => boolean
}

const inRange = (code: number, from: number, to: number): boolean => code >= from && code <= to

const SCRIPT_RULES: ScriptRule[] = [
  { script: 'myanmar', test: (c) => inRange(c, 0x1000, 0x109f) || inRange(c, 0xaa60, 0xaa7f) },
  { script: 'thai', test: (c) => inRange(c, 0x0e00, 0x0e7f) },
  { script: 'hiragana', test: (c) => inRange(c, 0x3040, 0x309f) },
  { script: 'katakana', test: (c) => inRange(c, 0x30a0, 0x30ff) || inRange(c, 0x31f0, 0x31ff) },
  { script: 'hangul', test: (c) => inRange(c, 0xac00, 0xd7af) || inRange(c, 0x1100, 0x11ff) },
  { script: 'han', test: (c) => inRange(c, 0x3400, 0x4dbf) || inRange(c, 0x4e00, 0x9fff) },
  {
    script: 'devanagari',
    test: (c) => inRange(c, 0x0900, 0x097f) || inRange(c, 0xa8e0, 0xa8ff),
  },
  { script: 'bengali', test: (c) => inRange(c, 0x0980, 0x09ff) },
  { script: 'tamil', test: (c) => inRange(c, 0x0b80, 0x0bff) },
  { script: 'arabic', test: (c) => inRange(c, 0x0600, 0x06ff) || inRange(c, 0x0750, 0x077f) },
  { script: 'cyrillic', test: (c) => inRange(c, 0x0400, 0x04ff) },
  { script: 'greek', test: (c) => inRange(c, 0x0370, 0x03ff) },
  { script: 'hebrew', test: (c) => inRange(c, 0x0590, 0x05ff) },
  {
    script: 'latin',
    test: (c) =>
      inRange(c, 0x0041, 0x024f) ||
      inRange(c, 0x1e00, 0x1eff) ||
      inRange(c, 0x1ea0, 0x1ef9) ||
      inRange(c, 0x1ed0, 0x1ef1),
  },
]

/** Script → language, when the script is unambiguous enough to name one. */
const SCRIPT_LANGUAGE: Record<string, string> = {
  myanmar: 'my',
  thai: 'th',
  hangul: 'ko',
  devanagari: 'hi',
  bengali: 'bn',
  tamil: 'ta',
  arabic: 'ar',
  hebrew: 'he',
  cyrillic: 'ru',
  greek: 'el',
}

/** Vietnamese keeps tone marks inside the Latin ranges above — detect them. */
const VIETNAMESE_MARKS = /[ăâđêôơư]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i

/** Shared Latin stop words — kept short on purpose (sampled text is limited). */
const STOP_WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'as', 'on', 'be', 'by'],
  fr: ['le', 'la', 'les', 'des', 'une', 'est', 'dans', 'pour', 'que', 'qui', 'sur', 'avec'],
  es: ['el', 'la', 'los', 'las', 'una', 'que', 'para', 'con', 'por', 'del', 'como', 'más'],
  de: ['der', 'die', 'das', 'und', 'ist', 'von', 'mit', 'für', 'nicht', 'ein', 'eine', 'zu'],
  it: ['il', 'la', 'che', 'di', 'per', 'con', 'non', 'una', 'sono', 'questo'],
  pt: ['os', 'as', 'uma', 'que', 'para', 'com', 'não', 'mais', 'dos', 'como'],
  id: ['yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'pada'],
  nl: ['de', 'het', 'een', 'van', 'en', 'dat', 'voor', 'met', 'op', 'niet'],
}

const SCRIPT_SAMPLE_LIMIT = 8000

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ')
}

/** Histogram of scripts over the first SAMPLE_LIMIT code points. */
export function scriptHistogram(text: string): Record<string, number> {
  const histogram: Record<string, number> = {}
  let total = 0
  let index = 0
  for (const char of text) {
    index += 1
    if (index > SCRIPT_SAMPLE_LIMIT) break
    const code = char.codePointAt(0) ?? 0
    // Whitespace, digits and ASCII punctuation are neutral.
    if (code < 0x30) continue
    if (code >= 0x30 && code <= 0x39) continue
    if (code === 0x20) continue
    const rule = SCRIPT_RULES.find((candidate) => candidate.test(code))
    const script = rule ? rule.script : 'other'
    histogram[script] = (histogram[script] ?? 0) + 1
    total += 1
  }
  if (total > 0) {
    for (const key of Object.keys(histogram)) histogram[key] /= total
  }
  return histogram
}

function scoreLatin(text: string): Record<string, number> {
  const words = normalize(text).split(/\s+/).filter(Boolean).slice(0, 600)
  const scores: Record<string, number> = {}
  for (const lang of Object.keys(STOP_WORDS)) scores[lang] = 0
  for (const word of words) {
    for (const [lang, list] of Object.entries(STOP_WORDS)) {
      if (list.includes(word)) scores[lang] += 1
    }
  }
  if (VIETNAMESE_MARKS.test(text)) scores.vi = (scores.vi ?? 0) + 4
  return scores
}

/**
 * Detects the language of a text sample.
 *
 * Returns `lang: null` for tiny or heavily mixed samples — callers should treat
 * that as "ask the user" rather than guessing.
 */
export function detectLanguage(text: string): LangDetection {
  if (!text || !text.trim()) {
    return { lang: null, script: 'other', confidence: 0, scores: {} }
  }

  const histogram = scriptHistogram(text)
  const scores: Record<string, number> = { ...histogram }

  // Japanese needs kana evidence even when kanji dominates.
  const kanaRatio = (histogram.hiragana ?? 0) + (histogram.katakana ?? 0)
  const hanRatio = histogram.han ?? 0
  const latinRatio = histogram.latin ?? 0
  const dominantScript = Object.entries(histogram).sort((a, b) => b[1] - a[1])[0]

  let lang: string | null = null
  let script = dominantScript?.[0] ?? 'other'
  let confidence = dominantScript?.[1] ?? 0

  if (kanaRatio > 0.02) {
    lang = 'ja'
    script = 'kana'
    confidence = Math.min(1, kanaRatio + hanRatio)
  } else if ((histogram.hangul ?? 0) > 0.15) {
    lang = 'ko'
    confidence = histogram.hangul
  } else if (hanRatio > 0.3) {
    lang = 'zh'
    confidence = hanRatio
  } else if (latinRatio > 0.7 && !histogram.thai && !histogram.myanmar) {
    const latinScores = scoreLatin(text)
    const totalHits = Object.values(latinScores).reduce((sum, value) => sum + value, 0)
    const best = Object.entries(latinScores).sort((a, b) => b[1] - a[1])[0]
    if (best && best[1] > 0) {
      lang = best[0]
      confidence = totalHits > 0 ? best[1] / totalHits : 0
      scores.lang = best[1]
    } else {
      // No stop words at all (very short label, numbers-only…) — still Latin.
      lang = 'en'
      confidence = 0.35
    }
  } else if (dominantScript && dominantScript[1] >= 0.25) {
    lang = SCRIPT_LANGUAGE[dominantScript[0]] ?? null
    confidence = dominantScript[1]
  }

  if (lang && confidence < 0.15) {
    confidence = 0.15
  }

  return { lang, script, confidence: Math.min(1, confidence), scores }
}

/**
 * True when the text already looks like it is written in `lang`.
 * Used by the skip-rules classifier (don't translate what is already target).
 */
export function looksLikeLanguage(text: string, lang: string | null | undefined): boolean {
  if (!lang || !text.trim()) return false
  const detection = detectLanguage(text)
  if (detection.script === 'myanmar') return lang === 'my'
  if (detection.script === 'thai') return lang === 'th'
  if (detection.script === 'hangul') return lang === 'ko'
  if (detection.script === 'devanagari') return lang === 'hi'
  if (detection.script === 'han' || detection.script === 'kana')
    return lang === 'zh' || lang === 'ja'
  if (detection.script === 'latin' && detection.lang) return detection.lang === lang
  return false
}
