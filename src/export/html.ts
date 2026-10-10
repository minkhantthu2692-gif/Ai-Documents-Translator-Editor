/**
 * HTML builder (Phase 4).
 *
 * One builder serves three consumers:
 *
 *  - `mode: 'screen'`, `layout: 'absolute'` — the self-contained HTML export
 *    (inline CSS, inlined fonts, absolutely positioned text over the original
 *    geometry, so the page looks like the PDF and the text stays selectable).
 *  - `mode: 'print'`,  `layout: 'absolute'` — the source document the hidden
 *    iframe prints to PDF: `@page` is sized to the original page, margins are
 *    zero, every page breaks onto its own sheet.
 *  - `layout: 'flow'` — bilingual (side-by-side / interleaved) exports where
 *    two texts cannot share one bbox, so the page becomes a readable column.
 *
 * Every piece of text goes through `escapeHtml`; no `dangerouslySetInnerHTML`
 * exists anywhere in the app, and the print frame sanitises this output once
 * more before it reaches the iframe.
 */

import { textMeasurer, type TextMeasurer } from '@/editor/autofit'
import { directionOf } from '@/lib/text'
import type { LinkRef } from '@/pdf/links'
import { reflowBlocks } from './reflow'
import {
  applyLinks,
  CODE_FONT_STACK,
  escapeHtml,
  fontStackFor,
  fontStackForCode,
  headingOffset,
  langTag,
  listPrefix,
  pageBlocks,
  pt,
  round,
  tableGrid,
  tableSpansFor,
} from './shared'
import type { ExportBlock, ExportDocument, ExportOptions } from './types'

export type HtmlLayout = 'absolute' | 'flow'
export type HtmlMode = 'screen' | 'print'

export interface HtmlOptions {
  mode: HtmlMode
  layout: HtmlLayout
  /** Flow layout only: how the source and the translation are arranged. */
  bilingual: 'none' | 'side-by-side' | 'interleaved'
  /** Show the source text beside/before the translation (flow layout). */
  includeOriginal: boolean
  /** `@font-face` rules (data URLs) injected into `<head>`. */
  fontCss: string
  /** Extra CSS font-family entries appended after each block's own family. */
  fontStack: string
  title: string
  /** ISO code for `lang=`. */
  lang: string
  /** Small attribution line in screen mode. */
  generator: string
  /** Page background graphics (already converted to data URLs). */
  pageImages?: Array<{ index: number; dataUrl: string }>
}

export const DEFAULT_HTML_OPTIONS: HtmlOptions = {
  mode: 'screen',
  layout: 'absolute',
  bilingual: 'none',
  includeOriginal: false,
  fontCss: '',
  fontStack: '',
  title: 'Document',
  lang: 'en',
  generator: 'AI Documents Translator',
  pageImages: [],
}

/** `612 × 792` → the CSS name used for the `@page` rule of that size. */
function pageName(width: number, height: number): string {
  return `p${round(width, 1)}x${round(height, 1)}`
}

function blockStyle(block: ExportBlock, options: HtmlOptions): string {
  const parts = [
    `left:${pt(block.x)}`,
    `top:${pt(block.y)}`,
    `width:${pt(block.width)}`,
    `font-family:${fontStackForCode(block, { fontStack: options.fontStack })}`,
    `font-size:${pt(block.fontSize)}`,
    `line-height:${round(Math.max(block.lineHeight, 1.1), 3)}`,
    `color:${/^#[0-9a-f]{3,8}$/i.test(block.color) ? block.color : '#000000'}`,
    `text-align:${alignmentOf(block)}`,
  ]
  // A tab the PDF drew as a run of spaces is already spaces by the time it
  // reaches here, but a real tab that survived a hand-edited block still has
  // to land on a column width rather than the browser's default 8.
  if (block.kind === 'code') parts.push('tab-size:4')
  if (block.bold) parts.push('font-weight:700')
  if (block.italic) parts.push('font-style:italic')
  // A floor, not a ceiling: the box is at least as tall as the PDF cut it, and
  // grows if the translation needs more — `reflowBlocks` has already moved the
  // neighbours down to make that room, so nothing is painted over.
  if (block.height > 0) parts.push(`min-height:${pt(block.height)}`)
  return parts.join(';')
}

function alignmentOf(block: ExportBlock): string {
  if (block.alignment === 'justified') return 'justify'
  if (block.alignment === 'center') return 'center'
  if (block.alignment === 'right') return 'right'
  return 'left'
}

/**
 * Escapes `text`, turning any link that landed on it into a real `<a>`.
 *
 * Escaping happens segment by segment through `applyLinks`, so a URL's own
 * `&` is escaped for the attribute while the same URL in the body is escaped
 * for a text node — and neither is passed through the escaping twice. The
 * scheme was already allow-listed at extraction time; `applyLinks` checks it
 * again here because this is the string that ends up in somebody else's
 * browser.
 */
function htmlText(text: string, links: readonly LinkRef[]): string {
  return applyLinks(
    text,
    links,
    (url, anchor) => {
      // An in-document jump stays in this tab: a contents page that opens a
      // new window per entry is hostile, and there is no opener to guard —
      // the href cannot name another origin.
      const attrs = url.startsWith('#')
        ? `href="${escapeHtml(url)}"`
        : `href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank"`
      return `<a ${attrs}>${escapeHtml(anchor)}</a>`
    },
    escapeHtml,
  )
}

/**
 * The text `blockHtml` is about to print for a block.
 *
 * Deliberately not `textOf(...).primary`: `includeOriginal` falls back to the
 * translation when the source is empty, which is the inverse of what a flow
 * bilingual column does. `reflowBlocks` measures this exact string, so what the
 * layout leaves room for is what the page actually shows.
 */
function printedText(block: ExportBlock, options: HtmlOptions): string {
  return options.includeOriginal
    ? block.sourceText.length > 0
      ? block.sourceText
      : block.translatedText
    : block.translatedText.length > 0
      ? block.translatedText
      : block.sourceText
}

/** Everything `blockHtml` renders as text, list marker included. */
function printedLine(block: ExportBlock, options: HtmlOptions): string {
  // A table is reflowed as the grid it will draw, not as the tab-separated
  // string: `\t` has no reliable width in a measuring canvas, so a row with
  // tabs in it would measure narrower than it prints and the block would be
  // given too little room. Three spaces per cell gap is about what the cell
  // padding and the border come to, and every row is one line — which is what
  // the `<tr>` is.
  if (block.kind === 'table') {
    const grid = tableGrid(printedText(block, options))
    if (grid) return grid.map((row) => row.join('   ')).join('\n')
  }
  const text = printedText(block, options)
  return `${listPrefix(block, text)}${text}`
}

/**
 * A `<table>` for the printed text of a table block, or `''` when the text
 * turned out not to be tabular.
 *
 * Every cell is a `<td>` — including the first row. Which row is the header is
 * not something the extractor knows (a table without one is perfectly legal),
 * and inventing a bold header would be a claim the PDF never made. Markdown is
 * the one format that *requires* a header row, so it promotes row 0 there and
 * says so in its own comment.
 */
function tableHtml(text: string, block: ExportBlock): string {
  const grid = tableGrid(text)
  if (!grid) return ''
  // A cell that spans columns is drawn once with `colspan`; the cells it
  // covers are not drawn at all. Applying both would push the row a column
  // wide for every merge. `tableSpansFor` answers `null` when the printed
  // grid is no longer the shape the spans were measured on — a model that
  // answered with a different number of columns — and every cell then stands
  // on its own, which is still a table, just an unmerged one.
  const spans = tableSpansFor(block, grid)
  const rows = grid
    .map((cells, row) => {
      const drawn = cells.map((cell, column) => {
        const span = spans ? spans[row][column] : 1
        if (span === 0) return ''
        return `<td${span > 1 ? ` colspan="${span}"` : ''}>${htmlText(cell, block.links)}</td>`
      })
      return `<tr>${drawn.join('')}</tr>`
    })
    .join('')
  return `<table><tbody>${rows}</tbody></table>`
}

function blockHtml(block: ExportBlock, options: HtmlOptions, classes: string[]): string {
  const text = printedText(block, options)
  if (text.trim().length === 0) return ''
  // A table draws cells, not a paragraph of tab-separated text. `tableHtml`
  // returns '' when the printed text turns out to carry no cells — a model
  // that answered a table with one sentence — and the block then falls back to
  // being the paragraph it now is rather than emitting an empty grid.
  const table = block.kind === 'table' ? tableHtml(text, block) : ''
  const marker = table ? '' : listPrefix(block, text)
  const content =
    table ||
    `${marker ? `<span class="marker">${escapeHtml(marker)}</span>` : ''}${htmlText(
      text,
      block.links,
    )}`
  const dir = block.direction === 'rtl' ? ' dir="rtl"' : ''
  const style =
    options.layout === 'absolute'
      ? blockStyle(block, options)
      : `font-family:${fontStackForCode(block, { fontStack: options.fontStack })};font-size:${pt(
          block.fontSize,
        )};color:${block.color};${block.bold ? 'font-weight:700;' : ''}${
          block.italic ? 'font-style:italic;' : ''
        }text-align:${alignmentOf(block)}${block.kind === 'code' ? ';tab-size:4' : ''}`
  const flagged = block.overflow ? ' overflow' : block.hasSuggestion ? ' suggested' : ''

  // The screen export opens with an `<h1>` title; the printed one has no
  // header at all, so its blocks start at level 1.
  const level = headingOffset(block, options.mode === 'print' ? 0 : 1)
  // A code snippet is never a heading: the size rule that would promote a
  // short line runs *after* the code detector, but `headingLevel` is written by
  // a pass over the whole ladder, so the tag is held back here as well. A
  // table is not a heading either, and `<table>` cannot live inside `<h2>`.
  const tag = level === null || block.kind === 'code' || table ? 'div' : `h${level}`

  return (
    `<${tag} class="${classes.join(' ')}${faceClass(block)}${table ? ' has-table' : ''}${
      flagged
    }"` + ` data-block-id="${escapeHtml(block.id)}"${dir} style="${style}">${content}</${tag}>`
  )
}

/**
 * The class that says *what kind of text this is* rather than where it sits —
 * every one of these kinds is drawn by the same `div`/`p`/`hN` tag, so the
 * class is the only handle a stylesheet (or a reader) gets on them.
 *
 * A code snippet keeps its line breaks, a form label and an annotation note
 * are text the page never printed, and a table is a grid the rules below draw.
 */
function faceClass(block: ExportBlock): string {
  if (block.kind === 'code') return ' code'
  if (block.kind === 'form-field') return ' form-field'
  if (block.kind === 'annotation') return ' annotation'
  return ''
}

function absolutePage(
  page: ExportDocument['pages'][number],
  options: HtmlOptions,
  measure: TextMeasurer,
  image?: string,
  onOverlap?: (blockId: string) => void,
): string {
  const blocks = reflowBlocks(pageBlocks(page), {
    measure,
    pageHeight: page.height,
    // Marker included: a bullet that pushes the first word onto a second line
    // has to be counted by the layout too.
    textOf: (block) => printedLine(block, options),
    onOverlap: onOverlap ? (block) => onOverlap(block.id) : undefined,
  })
    .map((block) => blockHtml(block, options, ['block']))
    .filter(Boolean)
    .join('\n')

  const background = image ? `<img class="page-bg" alt="" src="${image}">` : ''

  return (
    `<section class="page ${pageName(page.width, page.height)}" id="page-${page.index + 1}"` +
    ` data-page="${page.index}"` +
    ` style="width:${pt(page.width)};height:${pt(page.height)}">\n` +
    `${background}\n${blocks}\n</section>`
  )
}

function flowPage(page: ExportDocument['pages'][number], options: HtmlOptions): string {
  const rows: string[] = []
  // Same offset as the absolute layout: the screen export opens with an `<h1>`
  // title, the printed one has no header at all.
  const levelsAbove = options.mode === 'print' ? 0 : 1
  for (const block of pageBlocks(page)) {
    const source = block.sourceText
    const target = block.translatedText.length > 0 ? block.translatedText : block.sourceText
    const pair = options.bilingual === 'side-by-side' ? ' pair' : ''
    const level = headingOffset(block, levelsAbove)
    const tag = level === null ? 'p' : `h${level}`
    // Code is never a heading, and it carries the `code` class so the flow
    // stylesheet can set the monospace face — the flow layout puts no inline
    // `font-family` on these elements at all. The same class carries a form
    // label and an annotation note: in this layout nothing else marks text the
    // page never printed, so without it they would read as the document's own.
    const isCode = block.kind === 'code'
    const openTag = isCode ? `<p` : `<${tag}`
    const closeTag = isCode ? `p` : tag
    const face = faceClass(block)

    // A table draws cells. `<p>` cannot contain a `<table>`, so the wrapper is
    // a `<div>` wearing the same `.src`/`.tgt` classes the flow stylesheet
    // styles — and if the printed text turned out to carry no cells, the block
    // falls through and renders as the paragraph it now is.
    if (block.kind === 'table') {
      const targetTable = tableHtml(target, block)
      if (targetTable) {
        const dirAttr = ` dir="${block.direction === 'rtl' ? 'rtl' : 'ltr'}"`
        if (options.includeOriginal && source.trim().length > 0 && source !== target) {
          const sourceTable = tableHtml(source, block)
          rows.push(
            `<div class="pair${pair}">` +
              (sourceTable
                ? `<div class="src" data-block-id="${escapeHtml(block.id)}">${sourceTable}</div>`
                : `<p class="src" data-block-id="${escapeHtml(block.id)}">${htmlText(
                    source,
                    block.links,
                  )}</p>`) +
              `<div class="tgt table" data-block-id="${escapeHtml(block.id)}"${dirAttr}>` +
              `${targetTable}</div>` +
              `</div>`,
          )
        } else {
          rows.push(
            `<div class="tgt table" data-block-id="${escapeHtml(block.id)}"${dirAttr}>` +
              `${targetTable}</div>`,
          )
        }
        continue
      }
    }

    if (options.includeOriginal && source.trim().length > 0 && source !== target) {
      const sourceIsRtl = directionOf(source) === 'rtl'
      const marker = listPrefix(block, source)
      rows.push(
        `<div class="pair${pair}">` +
          `<p class="src" data-block-id="${escapeHtml(block.id)}"${
            sourceIsRtl ? ' dir="rtl"' : ''
          }">` +
          `${marker ? `<span class="marker">${escapeHtml(marker)}</span>` : ''}${htmlText(
            source,
            block.links,
          )}</p>` +
          `${openTag} class="tgt${face}" data-block-id="${escapeHtml(block.id)}" dir="${
            block.direction === 'rtl' ? 'rtl' : 'ltr'
          }">${htmlText(target, block.links)}</${closeTag}>` +
          `</div>`,
      )
    } else {
      const text = target
      if (text.trim().length === 0) continue
      const marker = listPrefix(block, text)
      rows.push(
        `${openTag} class="tgt${face}" data-block-id="${escapeHtml(block.id)}"` +
          ` dir="${block.direction === 'rtl' ? 'rtl' : 'ltr'}">` +
          `${marker ? `<span class="marker">${escapeHtml(marker)}</span>` : ''}${htmlText(
            text,
            block.links,
          )}</${closeTag}>`,
      )
    }
  }

  return (
    `<section class="page flow" id="page-${page.index + 1}" data-page="${page.index}"` +
    ` style="width:${pt(page.width)}">\n` +
    `${rows.join('\n')}\n</section>`
  )
}

function pageRules(doc: ExportDocument): string {
  const sizes = new Map<string, { width: number; height: number }>()
  for (const page of doc.pages) sizes.set(pageName(page.width, page.height), page)
  const rules: string[] = []
  const first = doc.pages[0]
  if (first) rules.push(`@page { size: ${pt(first.width)} ${pt(first.height)}; margin: 0; }`)
  for (const [name, page] of sizes) {
    rules.push(`@page ${name} { size: ${pt(page.width)} ${pt(page.height)}; margin: 0; }`)
  }
  for (const name of sizes.keys()) rules.push(`.page.${name} { page: ${name}; }`)
  return rules.join('\n')
}

function baseCss(doc: ExportDocument, options: HtmlOptions): string {
  const print = options.mode === 'print'
  const pages = pageRules(doc)
  const bodyFont = doc.pages[0]?.blocks[0]
    ? fontStackFor(doc.pages[0].blocks[0], { fontStack: options.fontStack })
    : 'sans-serif'

  return `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: ${bodyFont};
  color: #111827;
  background: ${print ? '#ffffff' : '#f3f4f6'};
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.document { margin: 0 auto; }
${pages}
.page {
  position: relative;
  overflow: visible;
  background: #ffffff;
  margin: ${print ? '0' : '12pt auto'};
  ${print ? 'break-after: page; page-break-after: always;' : 'border: 1px solid #e5e7eb;'}
}
.page:last-child { break-after: auto; page-break-after: auto; }
${print ? '.page { border: none; }' : ''}
.page-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; }
.block {
  position: absolute;
  white-space: pre-wrap;
  word-break: normal;
  overflow-wrap: break-word;
  /* A heading emitted as h1-h6 must render exactly like the div it replaced:
     no UA margin, and the UA's bold replaced by the block's own weight (the
     inline font-weight still wins when the block is bold). */
  margin: 0;
  font-weight: inherit;
  ${print ? 'break-inside: avoid; page-break-inside: avoid;' : ''}
}
.block .marker { font-weight: 700; }
.block.overflow { outline: 1px dashed #dc2626; outline-offset: 1px; }
.block.suggested { box-shadow: inset 2px 0 0 #2563eb; }
/* A code snippet keeps its line breaks and its columns. The absolute layout
   already carries the monospace stack inline (fontStackForCode), so this
   rule is what sets it for the flow layout, which puts no inline font on
   its .src/.tgt elements at all. */
.code {
  font-family: ${CODE_FONT_STACK};
  tab-size: 4;
  white-space: pre-wrap;
}
/* A form field's tooltip and a dropdown's option captions are text the page
   never printed (src/pdf/formFields.ts). The block already arrives italic and
   grey, so this rule is the hook a reader of the document can reach for — and
   the guarantee that a print stylesheet which resets colour does not put them
   back among the labels they describe. */
.form-field {
  font-style: italic;
  color: #6b7280;
}
/* An annotation note — a sticky note, a highlight's reason, a stamp's legend
   (src/pdf/annotations.ts) — is text the page never printed either, and it is
   the one a reader is most likely to mistake for the document's own: it sits
   right under the passage it marks. Same second voice as a form label. */
.annotation {
  font-style: italic;
  color: #6b7280;
}
/* A table draws its own grid. Cells keep the block's face and the block's
   line-height (they are regular text), so the only things added here are the
   rules and the padding — and the padding is kept to a point or two on purpose,
   because reflow measures the rows as plain lines and every point of vertical
   padding it cannot see is a point of under-measured height. */
.page table {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  font: inherit;
  color: inherit;
}
.page td {
  border: 1px solid #d1d5db;
  padding: 1pt 4pt;
  vertical-align: top;
  overflow-wrap: break-word;
}
.page.flow { padding: 18pt 22pt; overflow: hidden; }
.page.flow .src, .page.flow .tgt {
  position: static;
  margin: 0 0 6pt;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font-size: 11pt;
  line-height: 1.7;
  /* A heading rendered as h1-h6 keeps the paragraph's weight, so the tag
     carries structure and nothing else. */
  font-weight: inherit;
}
.page.flow .src { color: #6b7280; font-size: 10pt; }
.page.flow .pair { display: grid; gap: 10pt; margin-bottom: 10pt; }
body.bilingual-side .page.flow .pair { grid-template-columns: 1fr 1fr; }
body.bilingual-inter .page.flow .pair { display: block; }
.page.flow .marker { font-weight: 700; }
${options.fontCss}
`.trim()
}

function screenHeader(doc: ExportDocument, options: HtmlOptions): string {
  if (options.mode === 'print') return ''
  return (
    `<header class="doc-header">\n` +
    `  <h1>${escapeHtml(options.title)}</h1>\n` +
    `  <p class="meta">${escapeHtml(doc.sourceFileName)} · ${escapeHtml(doc.sourceLang)} → ` +
    `${escapeHtml(doc.targetLang)} · ${doc.pageCount} pages</p>\n` +
    `  <p class="meta generator">${escapeHtml(options.generator)}</p>\n` +
    `</header>`
  )
}

/**
 * Builds the whole document. Pure: no DOM, no I/O — font CSS and page images
 * arrive already prepared so the function runs inside the export worker.
 */
export function buildHtmlDocument(
  doc: ExportDocument,
  options: HtmlOptions,
  measure: TextMeasurer = textMeasurer(),
  /** Ids of blocks reflow could not clear — the page edge stopped it. */
  onOverlap?: (blockId: string) => void,
): string {
  const images = new Map((options.pageImages ?? []).map((entry) => [entry.index, entry.dataUrl]))
  const sections = doc.pages
    .map((page) =>
      options.layout === 'absolute'
        ? absolutePage(page, options, measure, images.get(page.index), onOverlap)
        : flowPage(page, options),
    )
    .join('\n')

  const bodyClass =
    options.layout === 'flow'
      ? options.bilingual === 'side-by-side'
        ? 'bilingual-side'
        : options.bilingual === 'interleaved'
          ? 'bilingual-inter'
          : 'bilingual-none'
      : 'layout-absolute'

  const title = options.title.length > 0 ? options.title : doc.title

  return `<!doctype html>
<html lang="${langTag(options.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escapeHtml(options.generator)}">
<title>${escapeHtml(title)}</title>
<style>
${baseCss(doc, options)}
</style>
</head>
<body class="${bodyClass}">
<main class="document">
${screenHeader(doc, options)}
${sections}
</main>
</body>
</html>
`
}

/** Convenience wrapper: the exact source handed to `iframe.srcdoc`. */
export function buildPrintDocument(
  doc: ExportDocument,
  options: HtmlOptions,
  measure: TextMeasurer = textMeasurer(),
  onOverlap?: (blockId: string) => void,
): string {
  return buildHtmlDocument(
    doc,
    {
      ...options,
      mode: 'print',
      generator: options.generator || 'AI Documents Translator',
    },
    measure,
    onOverlap,
  )
}

/** Default options for the plain HTML export. */
export function htmlExportOptions(
  doc: ExportDocument,
  options: ExportOptions,
  fontCss: string,
): HtmlOptions {
  const bilingual = options.includeOriginal ? options.bilingual : 'none'
  return {
    ...DEFAULT_HTML_OPTIONS,
    mode: 'screen',
    layout: options.includeOriginal ? 'flow' : 'absolute',
    bilingual,
    includeOriginal: options.includeOriginal,
    fontCss,
    fontStack: options.fontStack,
    title: doc.title,
    lang: doc.targetLang,
  }
}
