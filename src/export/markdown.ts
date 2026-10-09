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

import {
  applyLinks,
  contentPages,
  headingOffset,
  listPrefix,
  pageBlocks,
  tableGrid,
  textOf,
} from './shared'
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
/**
 * `[anchor](url)` with the characters that would end the label early
 * backslashed. Only the label needs escaping: a URL is matched verbatim and
 * lives between the parentheses, where `)` in the destination is legal and
 * cannot be escaped without changing what the browser is sent.
 */
function linkMarkdown(url: string, anchor: string): string {
  return `[${anchor.replace(/[\\[\]]/g, '\\$&')}](${url})`
}

/** Length of the longest run of backticks in `text` — a fence must beat it. */
function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

/**
 * Escapes the one character that would end a table cell early.
 *
 * Only `|`. This builder leaves the other Markdown metacharacters alone
 * everywhere else, and escaping them here would make the same sentence render
 * differently inside a table than outside one — while an unescaped `|` does
 * not just render wrong, it adds a column.
 */
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** `linkMarkdown` with the pipe escaped too, for a link inside a cell. */
function tableLinkMarkdown(url: string, anchor: string): string {
  return `[${anchor.replace(/[\\[\]|]/g, '\\$&')}](${url})`
}

/**
 * One grid as GitHub-flavoured Markdown table lines.
 *
 * Markdown has no table without a header row, so **row 0 becomes the header**
 * whether or not the PDF had one — a format constraint, not a claim about the
 * document. A one-row table still emits both the header and the separator, and
 * a bodyless table is valid. `html.ts` and `epub.ts` make no such promotion:
 * they can show every row the same way, and the extractor does not know which
 * (if any) is a header.
 */
function tableMarkdown(grid: string[][], block: ExportBlock): string[] {
  const cell = (text: string): string =>
    applyLinks(text, block.links, tableLinkMarkdown, escapeTableCell)
  const [header, ...body] = grid
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ]
}

function blockGroup(block: ExportBlock, includeOriginal: boolean, levelsAbove: number): string {
  const { source, primary } = textOf(block, false)
  if (primary.trim().length === 0) return ''
  const lines: string[] = []
  const sourceGrid =
    block.kind === 'table' && includeOriginal && source !== primary ? tableGrid(source) : null
  // Never emit an empty blockquote, and skip it when it would repeat the line.
  if (includeOriginal && source.trim().length > 0 && source !== primary) {
    // A quoted table stays a table: `> | a | b |` is legal, and quoting the
    // raw `a \t b` string instead would print the cell separators as tabs.
    if (sourceGrid) {
      for (const line of tableMarkdown(sourceGrid, block)) lines.push(`> ${line}`)
    } else {
      for (const line of applyLinks(source, block.links, linkMarkdown).split('\n')) {
        lines.push(`> ${line}`)
      }
    }
  }
  if (block.kind === 'code') {
    // The body is literal: no backslash escaping (a `\_` in a snippet must
    // stay `\_`), no anchor rewriting (a URL inside code is data, not a link)
    // and no list marker (a leading `1.` is a statement, not a number). The
    // fence has to out-length the longest backtick run inside it, or a snippet
    // quoting a triple backtick closes the block early and everything after it
    // leaks back out as prose.
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(primary) + 1))
    lines.push(`${fence}\n${primary}\n${fence}`)
    // Guard the "exactly one blank line between blocks" invariant against text
    // that ends (or starts) with a newline.
    return lines.join('\n').replace(/^\n+|\n+$/g, '')
  }
  const grid = block.kind === 'table' ? tableGrid(primary) : null
  if (grid) {
    lines.push(...tableMarkdown(grid, block))
    return lines.join('\n').replace(/^\n+|\n+$/g, '')
  }
  const body = applyLinks(primary, block.links, linkMarkdown)
  const level = headingOffset(block, levelsAbove)
  lines.push(
    level === null ? `${listPrefix(block, primary)}${body}` : `${'#'.repeat(level)} ${body}`,
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
