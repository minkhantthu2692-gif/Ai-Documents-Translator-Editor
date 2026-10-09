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

import { directionOf } from '@/lib/text'
import { escapeHtml, fontStackFor, langTag, listPrefix, pageBlocks, pt, round } from './shared'
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
    `font-family:${fontStackFor(block, { fontStack: options.fontStack })}`,
    `font-size:${pt(block.fontSize)}`,
    `line-height:${round(Math.max(block.lineHeight, 1.1), 3)}`,
    `color:${/^#[0-9a-f]{3,8}$/i.test(block.color) ? block.color : '#000000'}`,
    `text-align:${alignmentOf(block)}`,
  ]
  if (block.bold) parts.push('font-weight:700')
  if (block.italic) parts.push('font-style:italic')
  if (block.height > 0) parts.push(`height:${pt(block.height)}`)
  return parts.join(';')
}

function alignmentOf(block: ExportBlock): string {
  if (block.alignment === 'justified') return 'justify'
  if (block.alignment === 'center') return 'center'
  if (block.alignment === 'right') return 'right'
  return 'left'
}

function blockHtml(block: ExportBlock, options: HtmlOptions, classes: string[]): string {
  const text = options.includeOriginal
    ? block.sourceText.length > 0
      ? block.sourceText
      : block.translatedText
    : block.translatedText.length > 0
      ? block.translatedText
      : block.sourceText
  if (text.trim().length === 0) return ''

  const marker = listPrefix(block, text)
  const content = `${marker ? `<span class="marker">${escapeHtml(marker)}</span>` : ''}${escapeHtml(text)}`
  const dir = block.direction === 'rtl' ? ' dir="rtl"' : ''
  const style =
    options.layout === 'absolute'
      ? blockStyle(block, options)
      : `font-family:${fontStackFor(block, { fontStack: options.fontStack })};font-size:${pt(
          block.fontSize,
        )};color:${block.color};${block.bold ? 'font-weight:700;' : ''}${
          block.italic ? 'font-style:italic;' : ''
        }text-align:${alignmentOf(block)}`
  const flagged = block.overflow ? ' overflow' : block.hasSuggestion ? ' suggested' : ''

  return (
    `<div class="${classes.join(' ')}${flagged}" data-block-id="${escapeHtml(block.id)}"` +
    `${dir} style="${style}">${content}</div>`
  )
}

function absolutePage(
  page: ExportDocument['pages'][number],
  options: HtmlOptions,
  image?: string,
): string {
  const blocks = pageBlocks(page)
    .map((block) => blockHtml(block, options, ['block']))
    .filter(Boolean)
    .join('\n')

  const background = image ? `<img class="page-bg" alt="" src="${image}">` : ''

  return (
    `<section class="page ${pageName(page.width, page.height)}" data-page="${page.index}"` +
    ` style="width:${pt(page.width)};height:${pt(page.height)}">\n` +
    `${background}\n${blocks}\n</section>`
  )
}

function flowPage(page: ExportDocument['pages'][number], options: HtmlOptions): string {
  const rows: string[] = []
  for (const block of pageBlocks(page)) {
    const source = block.sourceText
    const target = block.translatedText.length > 0 ? block.translatedText : block.sourceText
    const pair = options.bilingual === 'side-by-side' ? ' pair' : ''

    if (options.includeOriginal && source.trim().length > 0 && source !== target) {
      const sourceIsRtl = directionOf(source) === 'rtl'
      const marker = listPrefix(block, source)
      rows.push(
        `<div class="pair${pair}">` +
          `<p class="src" data-block-id="${escapeHtml(block.id)}"${
            sourceIsRtl ? ' dir="rtl"' : ''
          }">` +
          `${marker ? `<span class="marker">${escapeHtml(marker)}</span>` : ''}${escapeHtml(source)}</p>` +
          `<p class="tgt" data-block-id="${escapeHtml(block.id)}" dir="${
            block.direction === 'rtl' ? 'rtl' : 'ltr'
          }">${escapeHtml(target)}</p>` +
          `</div>`,
      )
    } else {
      const text = target
      if (text.trim().length === 0) continue
      const marker = listPrefix(block, text)
      rows.push(
        `<p class="tgt" data-block-id="${escapeHtml(block.id)}"` +
          ` dir="${block.direction === 'rtl' ? 'rtl' : 'ltr'}">` +
          `${marker ? `<span class="marker">${escapeHtml(marker)}</span>` : ''}${escapeHtml(text)}</p>`,
      )
    }
  }

  return (
    `<section class="page flow" data-page="${page.index}" style="width:${pt(page.width)}">\n` +
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
  ${print ? 'break-inside: avoid; page-break-inside: avoid;' : ''}
}
.block .marker { font-weight: 700; }
.block.overflow { outline: 1px dashed #dc2626; outline-offset: 1px; }
.block.suggested { box-shadow: inset 2px 0 0 #2563eb; }
.page.flow { padding: 18pt 22pt; overflow: hidden; }
.page.flow .src, .page.flow .tgt {
  position: static;
  margin: 0 0 6pt;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font-size: 11pt;
  line-height: 1.7;
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
export function buildHtmlDocument(doc: ExportDocument, options: HtmlOptions): string {
  const images = new Map((options.pageImages ?? []).map((entry) => [entry.index, entry.dataUrl]))
  const sections = doc.pages
    .map((page) =>
      options.layout === 'absolute'
        ? absolutePage(page, options, images.get(page.index))
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
export function buildPrintDocument(doc: ExportDocument, options: HtmlOptions): string {
  return buildHtmlDocument(doc, {
    ...options,
    mode: 'print',
    generator: options.generator || 'AI Documents Translator',
  })
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
