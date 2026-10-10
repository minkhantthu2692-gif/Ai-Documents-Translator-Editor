/**
 * Export document collection (Phase 4).
 *
 * Reads Dexie once and projects rows into the plain, structured-cloneable
 * `ExportDocument` the worker consumes. Everything layout-specific (reading
 * order, direction, auto-fit size, overflow, pending suggestions) is resolved
 * here so the builders never need the database.
 */

import { currentTemplateId } from '@/editor/templates'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { projectRepo } from '@/db/repo-projects'
import { containsMyanmar, directionOf, minLineHeight } from '@/lib/text'
import { pageBlocks } from './shared'
import { EXPORT_SCHEMA, type ExportBlock, type ExportDocument, type ExportPage } from './types'

export interface CollectOptions {
  projectId: string
  /** Only these page indexes (0-based). Undefined = every page. */
  pageIndexes?: number[]
  /** `PDF family → replacement family` from the pre-export font check. */
  fontSubstitutions?: Record<string, string>
  /** Progress while the rows are read (large documents). */
  onProgress?: (done: number, total: number) => void
}

export async function collectExportDocument(options: CollectOptions): Promise<ExportDocument> {
  const project = await projectRepo.get(options.projectId)
  if (!project) throw new Error(`Project not found: ${options.projectId}`)

  const [pages, blocks, templateId] = await Promise.all([
    pageRepo.listByProject(options.projectId),
    blockRepo.listByProject(options.projectId),
    currentTemplateId(options.projectId),
  ])

  const orderedPages = [...pages].sort((a, b) => a.index - b.index)
  const wanted = options.pageIndexes ? new Set(options.pageIndexes) : null
  const selected = wanted ? orderedPages.filter((page) => wanted.has(page.index)) : orderedPages

  const byPage = new Map<string, typeof blocks>()
  for (const block of blocks) {
    const list = byPage.get(block.pageId)
    if (list) list.push(block)
    else byPage.set(block.pageId, [block])
  }

  const substitutions = options.fontSubstitutions ?? {}
  const exportPages: ExportPage[] = []
  let done = 0

  for (const page of selected) {
    const source = (byPage.get(page.id) ?? []).sort((a, b) => a.order - b.order)
    const exportBlocks: ExportBlock[] = source.map((block) => {
      const text = block.translatedText.length > 0 ? block.translatedText : block.sourceText
      return {
        id: block.id,
        order: block.order,
        kind: block.kind,
        region: block.region,
        status: block.status,
        alignment: block.alignment,
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
        fontFamily: substitutions[block.fontFamily] ?? block.fontFamily,
        fontSize: block.fontSize,
        lineHeight: Math.max(block.lineHeight, minLineHeight(text)),
        color: block.color,
        bold: block.bold,
        italic: block.italic,
        listMarker: block.listMarker,
        headingLevel: block.headingLevel ?? null,
        links: block.links ?? [],
        figures: block.figures ?? [],
        tableCells: block.tableCells ?? null,
        tableSpans: block.tableSpans ?? null,
        sourceText: block.sourceText,
        translatedText: block.translatedText,
        characterCount: block.characterCount,
        skipRule: block.skipRule,
        placeholders: block.placeholders,
        direction: directionOf(text),
        fittedFontSize: block.fontSizeMode === 'auto' ? block.fontSize : null,
        overflow: block.overflow,
        hasSuggestion: block.suggestedText !== null,
      }
    })

    exportPages.push({
      index: page.index,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      contentClass: page.contentClass,
      blocks: exportBlocks,
    })

    done += 1
    options.onProgress?.(done, selected.length)
  }

  // The one moment the whole document is in order at once. A table split by a
  // page break is a table on both sides of it and invisible on either — the
  // pages were read one at a time, out of order when the user scrolled ahead —
  // so the halves are joined here rather than during extraction.
  markTableContinuations(exportPages)

  return {
    schema: EXPORT_SCHEMA,
    projectId: project.id,
    title: project.name,
    sourceFileName: project.sourceFileName ?? '',
    sourceLang: project.sourceLang,
    targetLang: project.targetLang,
    pageCount: exportPages.length,
    exportedAt: Date.now(),
    templateId,
    pages: exportPages,
  }
}

/** The blocks a reader is shown on `page`, in reading order, body only. */
function shownBodyBlocks(page: ExportPage): ExportBlock[] {
  return pageBlocks(page).filter((block) => block.region === 'body')
}

/**
 * Marks the tables a page break split in two — see `ExportBlock.tableContinuation`.
 *
 * The evidence is the same one extraction uses for a leftover row, read from
 * the other side of the break:
 *
 *  - the previous page *ends* with a table (nothing but the margins follows
 *    it), so the table was still running when the page ran out;
 *  - this page *begins* with a table, so nothing else was printed above it;
 *  - the two agree on how many columns a row has — the single check that
 *    separates "the rest of this table" from "another table happens to start
 *    here", which is the one false positive the first two guards leave open;
 *  - the table above ran past the middle of its page, so a table that stops
 *    in the top third with the sheet blank below it (a section end) does not
 *    speak for the next page's table.
 *
 * A missed join costs exactly what every format did before it: two tables
 * where the page broke one. A wrong one would put another table's rows under
 * this table's header, which is why every guard above is about the *shape* of
 * the join rather than a guess about the document.
 */
export function markTableContinuations(pages: ExportPage[]): void {
  for (let index = 1; index < pages.length; index += 1) {
    const previous = pages[index - 1]
    const page = pages[index]
    // Only a page the reader sees *next*: an export of a page range whose
    // neighbour was left out has nothing to continue from.
    if (page.index !== previous.index + 1) continue
    const before = shownBodyBlocks(previous)
    const after = shownBodyBlocks(page)
    const last = before[before.length - 1]
    const first = after[0]
    if (!last || !first) continue
    if (last.kind !== 'table' || first.kind !== 'table') continue
    const columns = last.tableCells?.[0]?.length ?? 0
    if (columns < 2 || first.tableCells?.[0]?.length !== columns) continue
    if (last.y + last.height < previous.height * 0.55) continue
    first.tableContinuation = true
  }
}

/** Families referenced by a collected document (input for the font check). */
export function usedFamilies(doc: ExportDocument): string[] {
  const families = new Set<string>()
  for (const page of doc.pages) {
    for (const block of page.blocks) families.add(block.fontFamily)
  }
  return [...families]
}

/** True when the document contains Myanmar text (drives font embedding). */
export function hasMyanmar(doc: ExportDocument): boolean {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (containsMyanmar(block.translatedText) || containsMyanmar(block.sourceText)) return true
    }
  }
  return false
}
