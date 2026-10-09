/**
 * Markdown export builder (Phase 4).
 *
 * Turns an `ExportDocument` into GitHub-flavoured Markdown: one escaped H1,
 * optional `## Page N` headings and one line per text block, with the source
 * text optionally emitted as a blockquote directly above its translation.
 * Blocks with no text at all never reach the output (see `pageBlocks`);
 * skipped/locked blocks keep theirs because it matters to the reader. RTL and
 * Myanmar strings are written as-is — Markdown has no direction concept.
 *
 * Pure string building: no DOM, no worker state, safe in Vitest.
 */

import { contentPages, headingOffset, listPrefix, pageBlocks, textOf } from './shared'
import type { ExportBlock, ExportDocument } from './types'

export interface MarkdownOptions {
  /** Document title used for the H1. */
  title: string
  /** Emit the source text above the translation for every block. */
  includeOriginal: boolean
  /** Emit `## Page N` headings between pages. */
  includePageHeadings: boolean
}

/**
 * Characters that would otherwise change the meaning of a Markdown line:
 * the six from the export spec (`#`, `*`, `_`, backtick, `[`, `]`) plus the
 * backslash that escapes them.
 */
const MARKDOWN_SPECIALS = /([\\#*_`[\]])/g

/** Prefixes every special character with a backslash so it renders literally. */
function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIALS, '\\$&')
}

/**
 * One block as a Markdown unit: an optional `> source` blockquote immediately
 * followed (no blank line) by the block line, which is `{listPrefix}{primary}`
 * for everything but a heading — a heading gets ATX hashes instead, deep
 * enough to sit below the `#` title and (when they are on) the `## Page N`
 * separators, so nothing in the outline collides with anything else.
 * Returns `''` for a block whose text is empty so it is skipped entirely.
 */
function blockGroup(block: ExportBlock, includeOriginal: boolean, levelsAbove: number): string {
  const { source, primary } = textOf(block, false)
  if (primary.trim().length === 0) return ''
  const lines: string[] = []
  // Never emit an empty blockquote, and skip it when it would repeat the line.
  if (includeOriginal && source.trim().length > 0 && source !== primary) {
    for (const line of source.split('\n')) lines.push(`> ${line}`)
  }
  const level = headingOffset(block, levelsAbove)
  lines.push(
    level === null ? `${listPrefix(block, primary)}${primary}` : `${'#'.repeat(level)} ${primary}`,
  )
  // Guard the "exactly one blank line between blocks" invariant against text
  // that ends (or starts) with a newline.
  return lines.join('\n').replace(/^\n+|\n+$/g, '')
}

/** Builds the Markdown file for `doc`. Always ends with exactly one `\n`. */
export function buildMarkdown(doc: ExportDocument, options: MarkdownOptions): string {
  const parts: string[] = [`# ${escapeMarkdown(options.title)}`]
  // The `#` title, plus `## Page N` when it is emitted — the levels the
  // document's own headings have to start below.
  const levelsAbove = options.includePageHeadings ? 2 : 1
  for (const page of contentPages(doc)) {
    if (options.includePageHeadings) parts.push(`## Page ${page.index + 1}`)
    for (const block of pageBlocks(page)) {
      const group = blockGroup(block, options.includeOriginal, levelsAbove)
      if (group.length > 0) parts.push(group)
    }
  }
  return `${parts.join('\n\n')}\n`
}
