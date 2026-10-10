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
