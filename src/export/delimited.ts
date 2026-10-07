/**
 * Delimited (CSV/TSV) export builder (Phase 4).
 *
 * One row per text block with RFC 4180 quoting and CRLF row terminators, so
 * the files open cleanly in Excel, Numbers and pandas. Blocks with no source
 * and no target never produce a row (they are filtered by `pageBlocks`).
 * Pure string building: no DOM, no worker state.
 */

import { contentPages, pageBlocks, textOf } from './shared'
import type { ExportBlock, ExportDocument } from './types'

export type Delimiter = ',' | '\t'

export type DelimitedColumn = 'page' | 'order' | 'kind' | 'status' | 'source' | 'target'

export interface DelimitedOptions {
  delimiter: Delimiter
  header: boolean
  columns: DelimitedColumn[]
}

/** Columns emitted by `buildCsv`/`buildTsv` when the caller says nothing. */
const DEFAULT_COLUMNS: DelimitedColumn[] = ['page', 'order', 'source', 'target']

/** RFC 4180 quoting: quote when the value contains the delimiter, a quote or
 * a newline; double embedded quotes. Newlines inside values are preserved. */
export function escapeDelimited(value: string, delimiter: Delimiter): string {
  const mustQuote =
    value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')
  return mustQuote ? `"${value.replace(/"/g, '""')}"` : value
}

/** One cell: `page`/`order` are 1-based, `target` falls back to the source. */
function cellFor(column: DelimitedColumn, pageIndex: number, block: ExportBlock): string {
  const { source, target } = textOf(block, false)
  switch (column) {
    case 'page':
      return String(pageIndex + 1)
    case 'order':
      return String(block.order + 1)
    case 'kind':
      return block.kind
    case 'status':
      return block.status
    case 'source':
      return source
    case 'target':
      return target
  }
}

/** Rows are separated by CRLF; an empty value is an empty (unquoted) field. */
export function buildDelimited(doc: ExportDocument, options: DelimitedOptions): string {
  const { delimiter } = options
  const rows: string[] = []
  if (options.header) {
    rows.push(options.columns.map((column) => escapeDelimited(column, delimiter)).join(delimiter))
  }
  for (const page of contentPages(doc)) {
    for (const block of pageBlocks(page)) {
      rows.push(
        options.columns
          .map((column) => escapeDelimited(cellFor(column, page.index, block), delimiter))
          .join(delimiter),
      )
    }
  }
  return rows.join('\r\n')
}

/** Comma-separated export: `page,order,source,target` with a header row. */
export function buildCsv(
  doc: ExportDocument,
  options?: Partial<Omit<DelimitedOptions, 'delimiter'>>,
): string {
  return buildDelimited(doc, {
    delimiter: ',',
    header: options?.header ?? true,
    columns: options?.columns ?? DEFAULT_COLUMNS,
  })
}

/** Tab-separated export: same defaults as `buildCsv` with a tab delimiter. */
export function buildTsv(
  doc: ExportDocument,
  options?: Partial<Omit<DelimitedOptions, 'delimiter'>>,
): string {
  return buildDelimited(doc, {
    delimiter: '\t',
    header: options?.header ?? true,
    columns: options?.columns ?? DEFAULT_COLUMNS,
  })
}
