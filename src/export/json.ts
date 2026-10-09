/**
 * JSON export builder (Phase 4).
 *
 * `buildJsonDocument` writes a self-describing envelope
 * (`{ schema, format: 'json', exportedAt, document }`) around the plain
 * `ExportDocument` payload; `parseJsonDocument` validates and reads such a
 * file back. With `includeGeometry: false` the per-block geometry (`x`, `y`,
 * `width`, `height`) is projected out — everything else survives — so the
 * round-trip returns exactly what was written. Pure string building: no DOM,
 * no worker state.
 */

import { EXPORT_SCHEMA, type ExportBlock, type ExportDocument, type ExportPage } from './types'

export interface JsonOptions {
  /** Two-space indent (true) or compact (false). */
  pretty: boolean
  /** Include per-block geometry (x/y/width/height/fontSize). */
  includeGeometry: boolean
}

/** Block payload without geometry — what `includeGeometry: false` emits. */
type BlockWithoutGeometry = Omit<ExportBlock, 'x' | 'y' | 'width' | 'height'>
type PageWithoutGeometry = Omit<ExportPage, 'blocks'> & { blocks: BlockWithoutGeometry[] }
type DocumentWithoutGeometry = Omit<ExportDocument, 'pages'> & { pages: PageWithoutGeometry[] }
/** Either the full payload or the geometry-free projection of it. */
type AnyDocument = ExportDocument | DocumentWithoutGeometry

/** Self-describing envelope written to disk. */
interface JsonEnvelope {
  schema: number
  format: 'json'
  exportedAt: number
  document: AnyDocument
}

/** Copies one block without its `x`/`y`/`width`/`height`; everything else stays. */
function projectBlock(block: ExportBlock): BlockWithoutGeometry {
  return {
    id: block.id,
    order: block.order,
    kind: block.kind,
    region: block.region,
    status: block.status,
    alignment: block.alignment,
    fontFamily: block.fontFamily,
    fontSize: block.fontSize,
    lineHeight: block.lineHeight,
    color: block.color,
    bold: block.bold,
    italic: block.italic,
    listMarker: block.listMarker,
    headingLevel: block.headingLevel,
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    characterCount: block.characterCount,
    skipRule: block.skipRule,
    placeholders: block.placeholders,
    direction: block.direction,
    fittedFontSize: block.fittedFontSize,
    overflow: block.overflow,
    hasSuggestion: block.hasSuggestion,
  }
}

/** Projects the whole document; a no-op when geometry is included. */
function projectDocument(doc: ExportDocument, includeGeometry: boolean): AnyDocument {
  if (includeGeometry) return doc
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => projectBlock(block)),
    })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Builds the JSON file for `doc`; compact when `pretty` is false. */
export function buildJsonDocument(doc: ExportDocument, options: JsonOptions): string {
  const envelope: JsonEnvelope = {
    schema: EXPORT_SCHEMA,
    format: 'json',
    exportedAt: doc.exportedAt,
    document: projectDocument(doc, options.includeGeometry),
  }
  return JSON.stringify(envelope, null, options.pretty ? 2 : undefined)
}

/**
 * Parses and validates a document produced by `buildJsonDocument`.
 * Throws an `Error` on malformed JSON, a wrong `schema`, a missing document,
 * a `pages` value that is not an array or a page without numeric
 * `index`/`width`/`height`.
 */
export function parseJsonDocument(json: string): ExportDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('parseJsonDocument: input is not valid JSON')
  }
  if (!isRecord(parsed)) throw new Error('parseJsonDocument: root value must be an object')
  if (parsed.schema !== EXPORT_SCHEMA) {
    throw new Error(`parseJsonDocument: unsupported schema ${String(parsed.schema)}`)
  }
  const document = parsed.document
  if (!isRecord(document)) throw new Error('parseJsonDocument: envelope has no document')
  const pages = document.pages
  if (!Array.isArray(pages)) throw new Error('parseJsonDocument: document.pages must be an array')
  for (const page of pages) {
    if (!isRecord(page)) throw new Error('parseJsonDocument: every page must be an object')
    if (
      typeof page.index !== 'number' ||
      typeof page.width !== 'number' ||
      typeof page.height !== 'number'
    ) {
      throw new Error('parseJsonDocument: page.index, page.width and page.height must be numbers')
    }
  }
  return document as unknown as ExportDocument
}
