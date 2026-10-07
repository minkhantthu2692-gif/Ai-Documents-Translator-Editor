/**
 * Script-direction and script-class helpers.
 *
 * Used by the editor (RTL/CJK block layout, line-height rules) and by every
 * export builder, so both sides must agree on how a string is classified.
 *
 * Pure functions only — no DOM, no Intl dependency. Code-point ranges are
 * tables of numbers instead of regular-expression literals so the file stays
 * readable regardless of the editor's encoding.
 */

/** Inclusive code-point ranges. */
type RangeTable = ReadonlyArray<readonly [number, number]>

function inRanges(code: number, table: RangeTable): boolean {
  for (let i = 0; i < table.length; i += 1) {
    const [lo, hi] = table[i]
    if (code >= lo && code <= hi) return true
  }
  return false
}

/**
 * Strong right-to-left scripts: Hebrew, Arabic (+supplement, extended-A),
 * Syriac, Thaana, NKo, Samaritan, Mandaic, Adlam, Old Hungarian, plus the
 * Arabic/Hebrew presentation and decorative forms.
 */
const RTL_RANGES: RangeTable = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo
  [0x0800, 0x083f], // Samaritan
  [0x0840, 0x085f], // Mandaic
  [0x0860, 0x086f], // Syriac Supplement
  [0x0870, 0x089f], // Arabic Extended-B
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew presentation forms
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
  [0x1080, 0x109f], // Cypriot (historic RTL)
  [0x1e000, 0x1efff], // Anatolian signs (right-to-left glyphs)
]

/** Han, kana, hangul, fullwidth forms and the CJK punctuation block. */
const CJK_RANGES: RangeTable = [
  [0x2e80, 0x2eff], // CJK radicals supplement
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3100, 0x312f], // Bopomofo
  [0x3130, 0x318f], // Hangul compatibility Jamo
  [0x31c0, 0x31ef], // CJK strokes
  [0x31f0, 0x31ff], // Katakana phonetic extensions
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xffef], // Fullwidth forms
]

/** Myanmar script (base, Ext-A, Ext-B). */
const MYANMAR_RANGES: RangeTable = [
  [0x1000, 0x109f], // Myanmar
  [0xa9e0, 0xa9ff], // Myanmar Extended-B
  [0xaa60, 0xaa7f], // Myanmar Extended-A
]

/** Soft hyphen, BOM, zero-width and other invisible formatting characters. */
const INVISIBLE_RANGES: RangeTable = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM
  [0x202a, 0x202e], // bidi embedding/override controls
  [0x2060, 0x2064], // word joiner and invisible operators
  [0xfeff, 0xfeff], // BOM / ZWNBSP
]

function anyCode(text: string, table: RangeTable): boolean {
  for (const char of text) {
    if (inRanges(char.codePointAt(0) ?? 0, table)) return true
  }
  return false
}

export function containsRtl(text: string): boolean {
  return anyCode(text, RTL_RANGES)
}

export function containsCjk(text: string): boolean {
  return anyCode(text, CJK_RANGES)
}

export function containsMyanmar(text: string): boolean {
  return anyCode(text, MYANMAR_RANGES)
}

/**
 * `'rtl'` when the first strongly-directional character is right-to-left,
 * otherwise `'ltr'`. Unmarked / numeric-only strings resolve to `'ltr'` so a
 * page number never flips the whole block.
 */
export function directionOf(text: string): 'ltr' | 'rtl' {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (inRanges(code, RTL_RANGES)) return 'rtl'
    if (/\p{L}/u.test(char)) return 'ltr'
  }
  return 'ltr'
}

/** Which scripts appear in a string (drives CSS line-breaking rules). */
export function scriptClasses(text: string): {
  rtl: boolean
  cjk: boolean
  myanmar: boolean
} {
  return {
    rtl: containsRtl(text),
    cjk: containsCjk(text),
    myanmar: containsMyanmar(text),
  }
}

/**
 * Line-height floor for the target script. Myanmar stacked consonants and
 * ligatures need at least 1.7 (design rule), Latin/CJK read fine at 1.35.
 */
export function minLineHeight(text: string): number {
  return containsMyanmar(text) ? 1.7 : 1.35
}

/** Collapses runs of whitespace so find/replace and search compare fairly. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Case- and accent-insensitive key for search / find & replace. */
export function normalizeForSearch(text: string): string {
  return normalizeWhitespace(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/** Strips BOM/zero-width characters a PDF text layer sometimes carries. */
export function stripInvisible(text: string): string {
  let out = ''
  for (const char of text) {
    if (!inRanges(char.codePointAt(0) ?? 0, INVISIBLE_RANGES)) out += char
  }
  return out
}
