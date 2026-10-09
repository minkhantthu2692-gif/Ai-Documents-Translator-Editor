/**
 * Plain-text export builder (Phase 4).
 *
 * `buildPlainText` lays an `ExportDocument` out as a `.txt` string: an
 * optional `{page}` header per page, one line per text block (optionally the
 * source line above the translation line) and a configurable page separator
 * (form feed `\f` by default). `wrapText` is a greedy, script-aware wrapper
 * that honours spaces plus CJK/Myanmar break opportunities and never splits a
 * word that fits. Pure string building: no DOM, no worker state.
 */

import { containsCjk, containsMyanmar } from '@/lib/text'
import { contentPages, listPrefix, pageBlocks, textOf } from './shared'
import type { ExportDocument } from './types'

export interface TextOptions {
  includeOriginal: boolean
  /** 0 = never wrap. Otherwise a soft column width in characters. */
  wrapWidth: number
  /** Separator emitted between pages, default `\f` (form feed). */
  pageSeparator: string
  /** Header line printed before each page, e.g. `--- Page 1 ---`. Empty = none. */
  pageHeader: string
}

/** Profile used when the caller has no overrides for a plain-text export. */
const DEFAULT_TEXT_OPTIONS: TextOptions = {
  includeOriginal: false,
  wrapWidth: 0,
  pageSeparator: '\f',
  pageHeader: '',
}

/** Myanmar sign ranges that must never start a wrapped line. */
const MYANMAR_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x102b, 0x103e], // vowel signs, visarga, virama, asat, medials
  [0x1056, 0x1064], // two-story vowel signs and Karen vowels
  [0x1067, 0x106d], // S'gaw Karen vowels
  [0x1082, 0x1084], // Shan medial consonants
]

interface WrapToken {
  space: boolean
  text: string
}

function isMyanmarMark(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return MYANMAR_MARK_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

/**
 * Splits a single line into greedy-wrap tokens: whitespace runs stay as
 * break opportunities, every CJK character and every Myanmar base character
 * is its own unit, and Myanmar signs glue onto the unit in front of them so
 * a line never opens with a combining mark.
 */
function tokenize(line: string): WrapToken[] {
  const tokens: WrapToken[] = []
  let word = ''
  let space = ''
  const flushWord = () => {
    if (word.length > 0) {
      tokens.push({ space: false, text: word })
      word = ''
    }
  }
  const flushSpace = () => {
    if (space.length > 0) {
      tokens.push({ space: true, text: space })
      space = ''
    }
  }
  for (const ch of line) {
    if (/\s/.test(ch)) {
      flushWord()
      space += ch
      continue
    }
    // A pending gap belongs in front of the unit that follows it.
    flushSpace()
    if (containsCjk(ch)) {
      flushWord()
      tokens.push({ space: false, text: ch })
      continue
    }
    if (containsMyanmar(ch) && !isMyanmarMark(ch)) {
      flushWord()
      tokens.push({ space: false, text: ch })
      continue
    }
    const previous = tokens[tokens.length - 1]
    if (containsMyanmar(ch) && word.length === 0 && tokens.length > 0 && !previous.space) {
      previous.text += ch
      continue
    }
    word += ch
  }
  flushWord()
  flushSpace()
  return tokens
}

/** Greedy wrap of one line; trailing spaces are dropped when a line breaks. */
function wrapLine(line: string, width: number): string[] {
  if (line.trim().length === 0) return [line.replace(/\s+$/, '')]
  const tokens = tokenize(line)
  const lines: string[] = []
  let current = ''
  let pending = ''
  for (const token of tokens) {
    if (token.space) {
      pending += token.text
      continue
    }
    const candidate = current.length === 0 ? pending + token.text : current + pending + token.text
    if (candidate.length <= width) {
      current = candidate
      pending = ''
      continue
    }
    if (current.length > 0) {
      lines.push(current)
    }
    // The word becomes the new line whole — even when it exceeds `width`,
    // because an un-splittable word must never be cut.
    current = token.text
    pending = ''
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/**
 * Greedy wrap honouring spaces and CJK/Myanmar break opportunities. Never
 * splits a word that fits (an over-long word stays intact on its own line).
 * `width <= 0` returns the input unchanged apart from trimmed line ends.
 */
export function wrapText(text: string, width: number): string {
  const lines = text.split('\n')
  if (!Number.isFinite(width) || width <= 0) {
    return lines.map((line) => line.replace(/\s+$/, '')).join('\n')
  }
  const wrapped: string[] = []
  for (const line of lines) wrapped.push(...wrapLine(line, width))
  return wrapped.join('\n')
}

/**
 * Builds the plain-text file for `doc`. Pages are joined with `pageSeparator`
 * and the result ends with a single `\n`. Within a page each block contributes
 * its translation line (carrying the block's list marker via `listPrefix`);
 * with `includeOriginal` the source line is printed directly above it (once,
 * when it actually differs from the translation).
 * A page without any text block is omitted.
 */
export function buildPlainText(doc: ExportDocument, options: TextOptions): string {
  const sections: string[] = []
  for (const page of contentPages(doc)) {
    const lines: string[] = []
    if (options.pageHeader.length > 0) {
      lines.push(options.pageHeader.replaceAll('{page}', String(page.index + 1)))
    }
    for (const block of pageBlocks(page)) {
      const { source, primary } = textOf(block, false)
      if (primary.trim().length === 0) continue
      if (options.includeOriginal && source.trim().length > 0 && source !== primary) {
        lines.push(wrapText(source, options.wrapWidth))
      }
      lines.push(wrapText(`${listPrefix(block, primary)}${primary}`, options.wrapWidth))
    }
    sections.push(lines.join('\n'))
  }
  if (sections.length === 0) return ''
  return `${sections.join(options.pageSeparator)}\n`
}

/**
 * Plain-text export with the default layout profile: no source lines, no
 * wrapping, form-feed page breaks and no page header. `options` overrides
 * individual fields of that profile.
 */
export function buildPlainTextDefault(doc: ExportDocument, options: TextOptions): string {
  return buildPlainText(doc, { ...DEFAULT_TEXT_OPTIONS, ...options })
}
