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
import { figureAlt, figureArtMap, figureGoesBefore, figureKey } from './figureArt'
import type { FigureArt } from './figureArt'
import type { ExportBlock, ExportDocument } from './types'

export interface MarkdownOptions {
  /** Document title used for the H1. */
  title: string
  /** Emit the source text above the translation for every block. */
  includeOriginal: boolean
  /** Emit `## Page N` headings between pages. */
  includePageHeadings: boolean
  /**
   * Cropped figures keyed by `figureKey`, embedded as data-URI images on the
   * side of their block where the page painted them. Markdown has no asset
   * folder, so the pixels travel inside the document — a picture is worth a
   * much larger file, and `includeImages: false` turns the whole thing off.
   */
  figures?: FigureArt[]
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
 * The `![alt](data:…)` lines for one block, split by the side of the block the
 * page painted them on: `before` holds a picture that sat above its text (the
 * usual captioned figure), `after` one that sat below it. A figure whose crop
 * did not survive rendering is simply absent — the text around it is worth
 * more than a broken image link.
 */
function blockFigures(
  block: ExportBlock,
  options: MarkdownOptions,
): { before: string[]; after: string[] } {
  const art = figureArtMap(options.figures)
  if (art.size === 0 || block.figures.length === 0) return { before: [], after: [] }
  const before: string[] = []
  const after: string[] = []
  block.figures.forEach((figure, index) => {
    const found = art.get(figureKey(block.id, index))
    if (!found) return
    // Alt text is prose: `]` and `\` would end the label early, everything
    // else is safe inside `![…]`.
    const alt = figureAlt(block).replace(/([\\[\]])/g, '\\$&')
    const line = `![${alt}](${found.dataUrl})`
    ;(figureGoesBefore(block, figure.bbox) ? before : after).push(line)
  })
  return { before, after }
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
 * Markdown has no table without a header row, so when `promote` is on **row 0
 * becomes the header** whether or not the PDF had one — a format constraint,
 * not a claim about the document. A one-row table still emits both the header
 * and the separator, and a bodyless table is valid. `html.ts` and `epub.ts`
 * make no such promotion: they can show every row the same way, and the
 * extractor does not know which (if any) is a header.
 *
 * `promote` comes off for the rows of a table that continues the one above it
 * (`ExportBlock.tableContinuation`): those rows are appended to a table that
 * already has its header, and promoting their first row would put data in the
 * place the header lives.
 */
function tableMarkdown(grid: string[][], block: ExportBlock, promote: boolean): string[] {
  const cell = (text: string): string =>
    applyLinks(text, block.links, tableLinkMarkdown, escapeTableCell)
  const lines = grid.map((row) => `| ${row.map(cell).join(' | ')} |`)
  if (!promote || lines.length === 0) return lines
  return [lines[0], `| ${grid[0].map(() => '---').join(' | ')} |`, ...lines.slice(1)]
}

/** One block as Markdown: the quoted source above, the primary text below. */
interface BlockGroup {
  /** `> …` lines, empty when the block quotes nothing. */
  quote: string[]
  /** The block's own lines, in order. */
  body: string[]
}

/**
 * The empty ends a text that begins or ends with a newline would otherwise
 * leave in a group — the "exactly one blank line between blocks" invariant.
 * Only the ends are trimmed: a blank line *inside* a fenced snippet is content
 * and stays where it is.
 */
function trimGroup(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && out[0].trim() === '') out.shift()
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  if (out.length > 0) {
    out[0] = out[0].replace(/^\n+/, '')
    out[out.length - 1] = out[out.length - 1].replace(/\n+$/, '')
  }
  return out
}

/**
 * One block as a Markdown unit: an optional `> source` blockquote immediately
 * followed (no blank line between the two of *them*) by the primary text,
 * which is `{listPrefix}{primary}` for everything but a heading — a heading
 * gets ATX hashes instead, deep enough to sit below the `#` title and (when
 * they are on) the `## Page N` separators, so nothing in the outline collides
 * with anything else. Empty quote and body arrays together mean the block is
 * skipped entirely.
 *
 * `promote` is `tableMarkdown`'s: false for the rows of a table that continues
 * the one above it, because those rows join a table that already has a header.
 */
function blockGroup(
  block: ExportBlock,
  includeOriginal: boolean,
  levelsAbove: number,
  promote: boolean,
): BlockGroup {
  const { source, primary } = textOf(block, false)
  if (primary.trim().length === 0) return { quote: [], body: [] }
  const quote: string[] = []
  const sourceGrid =
    block.kind === 'table' && includeOriginal && source !== primary ? tableGrid(source) : null
  // Never emit an empty blockquote, and skip it when it would repeat the line.
  if (includeOriginal && source.trim().length > 0 && source !== primary) {
    // A quoted table stays a table: `> | a | b |` is legal, and quoting the
    // raw `a \t b` string instead would print the cell separators as tabs.
    if (sourceGrid) {
      quote.push(...tableMarkdown(sourceGrid, block, promote).map((line) => `> ${line}`))
    } else {
      quote.push(
        ...applyLinks(source, block.links, linkMarkdown)
          .split('\n')
          .map((line) => `> ${line}`),
      )
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
    return { quote, body: trimGroup([`${fence}\n${primary}\n${fence}`]) }
  }
  const grid = block.kind === 'table' ? tableGrid(primary) : null
  if (grid) return { quote, body: tableMarkdown(grid, block, promote) }
  const text = applyLinks(primary, block.links, linkMarkdown)
  const level = headingOffset(block, levelsAbove)
  return {
    quote,
    body: trimGroup([
      level === null ? `${listPrefix(block, primary)}${text}` : `${'#'.repeat(level)} ${text}`,
    ]),
  }
}

/** A line that is a table row: what a part's tail has to be to be extended. */
function isTableRowLine(line: string): boolean {
  return line.startsWith('|') && line.endsWith('|')
}

/** Unescaped `|` in a rendered row line: one more than the cells it holds. */
function tableCellCount(line: string): number {
  return (line.match(/(^|[^\\])\|/g) ?? []).length - 1
}

/**
 * A rendered row line with empty cells appended until it is `width` wide.
 *
 * A continuation's rows are rendered from their own printed text, and a model
 * is free to answer that block with fewer columns than the table above it —
 * which in Markdown would silently pull every cell after the gap out of line
 * with the header. Extra cells are left alone: padding is alignment, cutting
 * is data loss.
 */
function padTableRow(line: string, width: number): string {
  if (!isTableRowLine(line)) return line
  const cells = tableCellCount(line)
  if (cells < 1 || cells >= width) return line
  let padded = line.slice(0, -2)
  for (let index = cells; index < width; index += 1) padded += ' | '
  return `${padded} |`
}

/**
 * One group as it prints: the `>` lines immediately above the primary line —
 * no blank line between a source and its translation, that is the whole point
 * of quoting it — and the blank line between *groups* comes from the join in
 * `buildMarkdown`, not from here.
 */
function renderGroup(group: BlockGroup): string {
  return [...group.quote, ...group.body].join('\n')
}

/**
 * Builds the Markdown file for `doc`. Always ends with exactly one `\n`.
 */
export function buildMarkdown(doc: ExportDocument, options: MarkdownOptions): string {
  const groups: BlockGroup[] = []
  // The part a table that continues over a page break adds its rows to: the
  // last one whose tail is a table row. A `## Page N` heading does not take
  // this over — a heading cannot sit inside a table, so the marker for the
  // page whose table was cut lands just *after* the rows the break moved up,
  // which is where the rest of that page begins.
  let tablePart = -1
  const pushGroup = (group: BlockGroup, clears = true): void => {
    if (group.quote.length === 0 && group.body.length === 0) return
    groups.push(group)
    if (!clears) return
    const tail = group.body[group.body.length - 1]
    tablePart = tail !== undefined && isTableRowLine(tail) ? groups.length - 1 : -1
  }
  // The `#` title, plus `## Page N` when it is emitted — the levels the
  // document's own headings have to start below.
  const levelsAbove = options.includePageHeadings ? 2 : 1
  pushGroup({ quote: [], body: [`# ${escapeMarkdown(options.title)}`] })
  for (const page of contentPages(doc)) {
    if (options.includePageHeadings) {
      groups.push({ quote: [], body: [`## Page ${page.index + 1}`] })
    }
    for (const block of pageBlocks(page)) {
      // The figures ride with their block, on the side the page painted them:
      // a picture above its caption stays above it, one below the paragraph it
      // was paired with stays below. A block with no text at all still emits
      // its figures — the artwork is the content there. Either side clears the
      // merge target: artwork between two halves of a table is a reason to
      // draw them as the two blocks they are.
      const { before, after } = blockFigures(block, options)
      for (const figure of before) pushGroup({ quote: [], body: [figure] })
      const continues = tableContinuationTarget(block, options.includeOriginal, groups, tablePart)
      if (continues) {
        mergeGroup(continues, blockGroup(block, options.includeOriginal, levelsAbove, false))
      } else {
        // A running head or a page footer is printed where it was on its page,
        // and it is not content *between* a table and its continuation: it is
        // laid down without taking the merge target away, the way the `## Page
        // N` marker above it does.
        pushGroup(
          blockGroup(block, options.includeOriginal, levelsAbove, true),
          block.region === 'body',
        )
      }
      for (const figure of after) pushGroup({ quote: [], body: [figure] })
    }
  }
  return `${groups.map(renderGroup).join('\n\n')}\n`
}

/**
 * The part a continuation table's rows belong in, or `null` when it has none.
 *
 * `null` is the normal answer and always safe: the block then renders as a
 * table of its own, exactly as it did before continuations were joined — a
 * promoted header and all, which is what a table that really *is* new should
 * get anyway.
 */
function tableContinuationTarget(
  block: ExportBlock,
  includeOriginal: boolean,
  groups: BlockGroup[],
  tablePart: number,
): BlockGroup | null {
  if (block.kind !== 'table' || !block.tableContinuation) return null
  if (tablePart < 0) return null
  const target = groups[tablePart]
  const tail = target.body[target.body.length - 1]
  if (tail === undefined || !isTableRowLine(tail)) return null
  // The quoted half has to land in a quoted half: a `> | row |` after the
  // translation it belongs to would print the source *below* the text it is
  // the source of, so a block bringing its own quote to a part that has none
  // (the table above it is untranslated, say) stands on its own instead.
  const { source, primary } = textOf(block, false)
  const quotes = includeOriginal && source.trim().length > 0 && source !== primary
  if (quotes && target.quote.length === 0) return null
  return target
}

/** Appends one group's rows to the table above it, cells kept in line. */
function mergeGroup(target: BlockGroup, group: BlockGroup): void {
  const body = target.body[target.body.length - 1]
  const quote = target.quote[target.quote.length - 1]
  const bodyWidth = body === undefined ? 0 : tableCellCount(body)
  const quoteWidth = quote === undefined ? 0 : tableCellCount(quote)
  for (const line of group.body) target.body.push(padTableRow(line, bodyWidth))
  for (const line of group.quote) target.quote.push(padTableRow(line, quoteWidth))
}
