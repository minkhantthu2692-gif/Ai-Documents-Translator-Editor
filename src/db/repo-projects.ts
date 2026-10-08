/** Project repository: CRUD, search, archive, duplicate, cascade delete, stats. */

import { getDb } from './db'
import { stampNew, stampUpdate } from './repo-common'
import { enqueueDelete } from '@/sync/hooks'
import type {
  BlockRecord,
  PageRecord,
  ProjectRecord,
  ProjectStatus,
  TranslationRecord,
} from './types'

export interface CreateProjectInput {
  name: string
  sourceLang: string
  targetLang: string
  sourceFileName?: string | null
  sourceFileSize?: number
  notes?: string
}

export interface ListProjectsOptions {
  search?: string
  status?: ProjectStatus | 'all'
  includeArchived?: boolean
  sort?: 'recent' | 'name' | 'progress'
  limit?: number
}

export class ProjectRepository {
  async create(input: CreateProjectInput): Promise<ProjectRecord> {
    const db = getDb()
    const record = stampNew<ProjectRecord>(
      {
        name: input.name.trim(),
        sourceFileName: input.sourceFileName ?? null,
        sourceFileSize: input.sourceFileSize ?? 0,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        status: 'draft',
        pageCount: 0,
        translatedPageCount: 0,
        blockCount: 0,
        characterCount: 0,
        progress: 0,
        archived: false,
        archivedAt: null,
        lastOpenedAt: Date.now(),
        notes: input.notes ?? '',
      },
      'prj',
    )
    await db.projects.add(record)
    return record
  }

  get(id: string): Promise<ProjectRecord | undefined> {
    return getDb().projects.get(id)
  }

  async list(options: ListProjectsOptions = {}): Promise<ProjectRecord[]> {
    const { search = '', status = 'all', includeArchived = false, sort = 'recent', limit } = options
    const query = getDb().projects
    let rows = await query.toArray()

    const needle = search.trim().toLowerCase()
    rows = rows.filter((row) => {
      if (!includeArchived && row.archived) return false
      if (status !== 'all' && row.status !== status) return false
      if (!needle) return true
      return (
        row.name.toLowerCase().includes(needle) ||
        (row.sourceFileName ?? '').toLowerCase().includes(needle)
      )
    })

    rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'progress') return b.progress - a.progress || b.updatedAt - a.updatedAt
      return b.lastOpenedAt - a.lastOpenedAt || b.updatedAt - a.updatedAt
    })

    return limit ? rows.slice(0, limit) : rows
  }

  async countAll(): Promise<number> {
    return getDb().projects.count()
  }

  async update(id: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord> {
    const db = getDb()
    const existing = await db.projects.get(id)
    if (!existing) throw new Error(`Project not found: ${id}`)
    const next = stampUpdate(existing, patch)
    await db.projects.put(next)
    return next
  }

  rename(id: string, name: string): Promise<ProjectRecord> {
    return this.update(id, { name: name.trim() })
  }

  async touch(id: string): Promise<void> {
    await this.update(id, { lastOpenedAt: Date.now() })
  }

  setStatus(id: string, status: ProjectStatus, progress?: number): Promise<ProjectRecord> {
    return this.update(id, progress === undefined ? { status } : { status, progress })
  }

  archive(id: string, archived: boolean): Promise<ProjectRecord> {
    return this.update(id, {
      archived,
      archivedAt: archived ? Date.now() : null,
      status: archived ? 'archived' : 'draft',
    })
  }

  /** Deep copy: project + pages + blocks + translations (fresh ids, no history). */
  async duplicate(id: string, nameSuffix = ' (copy)'): Promise<ProjectRecord> {
    const db = getDb()
    const source = await db.projects.get(id)
    if (!source) throw new Error(`Project not found: ${id}`)

    const nowMs = Date.now()
    const { id: _sourceId, ...sourceRest } = source
    const copy = stampNew<ProjectRecord>(
      {
        ...sourceRest,
        name: `${source.name}${nameSuffix}`.slice(0, 120),
        status: 'draft',
        progress: 0,
        translatedPageCount: 0,
        archived: false,
        archivedAt: null,
        lastOpenedAt: nowMs,
        createdAt: nowMs,
        version: 1,
      },
      'prj',
    )

    const pages = await db.pages.where('projectId').equals(id).toArray()
    const pageIdMap = new Map<string, string>()
    const pageCopies = pages.map((page) => {
      const { id: _pageId, ...pageRest } = page
      const copyPage = stampNew<PageRecord>({ ...pageRest, projectId: copy.id }, 'pg')
      pageIdMap.set(page.id, copyPage.id)
      return copyPage
    })

    const blocks = await db.blocks.where('projectId').equals(id).toArray()
    const blockIdMap = new Map<string, string>()
    const blockCopies = blocks.map((block) => {
      const { id: _blockId, ...blockRest } = block
      const copyBlock = stampNew<BlockRecord>(
        {
          ...blockRest,
          projectId: copy.id,
          pageId: pageIdMap.get(block.pageId) ?? block.pageId,
          translatedText: '',
          status: 'pending',
        },
        'blk',
      )
      blockIdMap.set(block.id, copyBlock.id)
      return copyBlock
    })

    const translations = await db.translations.where('projectId').equals(id).toArray()
    const translationCopies = translations.map((translation) => {
      const { id: _translationId, ...translationRest } = translation
      return stampNew<TranslationRecord>(
        {
          ...translationRest,
          projectId: copy.id,
          blockId: blockIdMap.get(translation.blockId) ?? translation.blockId,
        },
        'trn',
      )
    })

    await db.transaction('rw', [db.projects, db.pages, db.blocks, db.translations], async () => {
      await db.projects.add(copy)
      if (pageCopies.length) await db.pages.bulkAdd(pageCopies)
      if (blockCopies.length) await db.blocks.bulkAdd(blockCopies)
      if (translationCopies.length) await db.translations.bulkAdd(translationCopies)
    })
    return copy
  }

  /** Removes the project and everything that belongs to it. */
  async remove(id: string): Promise<void> {
    const db = getDb()
    const existing = await db.projects.get(id)
    await db.transaction(
      'rw',
      [db.projects, db.pages, db.blocks, db.translations, db.jobs, db.outbox],
      async () => {
        await db.projects.delete(id)
        await db.pages.where('projectId').equals(id).delete()
        await db.blocks.where('projectId').equals(id).delete()
        await db.translations.where('projectId').equals(id).delete()
        await db.jobs.where('projectId').equals(id).delete()
        // Queued children upserts would beat the server-side cascade (see
        // dropPendingProjectChildren); the project row itself is replaced by a
        // tombstone so other devices learn about the deletion.
        await db.outbox
          .filter(
            (row) =>
              (row.entity === 'page' || row.entity === 'block') &&
              Boolean(
                row.payload &&
                typeof row.payload === 'object' &&
                (row.payload as { projectId?: unknown }).projectId === id,
              ),
          )
          .delete()
      },
    )
    if (existing) {
      await enqueueDelete('project', existing as unknown as Record<string, unknown>)
    }
  }

  async stats(): Promise<{
    projects: number
    activeProjects: number
    archivedProjects: number
    pages: number
    pagesTranslated: number
    characters: number
    blocks: number
  }> {
    const db = getDb()
    const projects = await db.projects.toArray()
    const pages = await db.pages.toArray()
    return {
      projects: projects.filter((row) => !row.archived).length,
      activeProjects: projects.filter((row) => !row.archived && row.status !== 'done').length,
      archivedProjects: projects.filter((row) => row.archived).length,
      pages: pages.length,
      pagesTranslated: projects.reduce((sum, row) => sum + row.translatedPageCount, 0),
      characters: projects.reduce((sum, row) => sum + row.characterCount, 0),
      blocks: projects.reduce((sum, row) => sum + row.blockCount, 0),
    }
  }

  /** Re-derives progress/page counters from child tables. */
  async refreshCounters(projectId: string): Promise<ProjectRecord | undefined> {
    const db = getDb()
    const pages = await db.pages.where('projectId').equals(projectId).toArray()
    const blocks = await db.blocks.where('projectId').equals(projectId).toArray()
    const translatedPages = pages.filter(
      (page) => page.ocrStatus === 'done' || page.hasTextLayer,
    ).length
    const pageCount = pages.length
    const progress = pageCount === 0 ? 0 : Math.round((translatedPages / pageCount) * 100)
    const characters = blocks.reduce((sum, block) => sum + block.characterCount, 0)
    return this.update(projectId, {
      pageCount,
      blockCount: blocks.length,
      translatedPageCount: translatedPages,
      progress,
      characterCount: characters,
    })
  }
}

export const projectRepo = new ProjectRepository()
