/**
 * Per-project portable file (JSON).
 *
 * The whole-DB backup (`backup.ts`) moves a *device*; this moves *one project*
 * between devices or browsers as a single file — project row, pages, blocks
 * and the project's glossary terms (UI Phase 4/4, the portability arc that
 * JSON key/settings export and Sheet sync started).
 *
 * Import is always additive: every row is re-identified (fresh ids, pages and
 * blocks remapped onto the new project), so a file can never overwrite or
 * collide with local work and importing twice simply gives two copies. An
 * imported project always lands in the active list (archive state is not
 * carried — a restored project you cannot find is a restored project you
 * think you lost).
 *
 * Deliberately left behind (device-local or binary):
 *  - `sourceFiles` — the original PDF bytes. JSON carries no blobs, the user
 *    still has the file, and the import flow warns when one was referenced.
 *  - revisions / jobs / events / outbox — device-local history and state.
 *  - the translation cache — blocks already carry their current text.
 *  - global glossary terms (`projectId: null`) belong to the device, not to a
 *    project, so only project-scoped terms travel.
 */

import { DB_SCHEMA_VERSION, getDb } from './db'
import { saveJsonFile } from './backup'
import { stampNew } from './repo-common'
import type { BlockRecord, GlossaryRecord, PageRecord, ProjectRecord } from './types'

export const PROJECT_FILE_FORMAT = 'aidt-project'
export const PROJECT_FILE_SCHEMA_VERSION = 1

export interface ProjectFileCounts {
  pages: number
  blocks: number
  glossary: number
}

export interface ProjectFile {
  format: typeof PROJECT_FILE_FORMAT
  schemaVersion: number
  dbSchemaVersion: number
  exportedAt: number
  appVersion: string
  counts: ProjectFileCounts
  project: ProjectRecord
  pages: PageRecord[]
  blocks: BlockRecord[]
  glossary: GlossaryRecord[]
}

/** Import never fails softly — these are advisory, surfaced next to success. */
export type ProjectImportWarning = 'source-pdf-not-included' | 'written-by-newer-app'

export interface ProjectImportResult {
  project: ProjectRecord
  counts: ProjectFileCounts
  warnings: ProjectImportWarning[]
}

export class ProjectFileError extends Error {
  readonly reasonCode: 'PROJECT_FILE_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFileError'
    this.reasonCode = 'PROJECT_FILE_INVALID'
  }
}

function appVersion(): string {
  return import.meta.env?.VITE_APP_VERSION ?? '0.1.0'
}

/** Reads one project and everything that travels with it into a plain object. */
export async function createProjectFile(projectId: string): Promise<ProjectFile> {
  const db = getDb()
  const project = await db.projects.get(projectId)
  if (!project) throw new ProjectFileError(`Project not found: ${projectId}`)

  const pages = await db.pages.where('projectId').equals(projectId).toArray()
  const blocks = await db.blocks.where('projectId').equals(projectId).toArray()
  const glossary = await db.glossary.where('projectId').equals(projectId).toArray()

  return {
    format: PROJECT_FILE_FORMAT,
    schemaVersion: PROJECT_FILE_SCHEMA_VERSION,
    dbSchemaVersion: DB_SCHEMA_VERSION,
    exportedAt: Date.now(),
    appVersion: appVersion(),
    counts: { pages: pages.length, blocks: blocks.length, glossary: glossary.length },
    project,
    pages,
    blocks,
    glossary,
  }
}

export function serializeProjectFile(file: ProjectFile): string {
  return JSON.stringify(file, null, 2)
}

type Row = Record<string, unknown> & { id: string }

function rowsOf(value: unknown, table: string): Row[] {
  if (!Array.isArray(value)) throw new ProjectFileError(`Project file has no "${table}" array`)
  const rows: Row[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') {
      throw new ProjectFileError(`"${table}" contains a row without a string id`)
    }
    rows.push(row as Row)
  }
  return rows
}

/** Validates untrusted JSON — and its internal wiring — before any write. */
export function parseProjectFile(json: string): ProjectFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new ProjectFileError(`Not valid JSON: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ProjectFileError('Project file is not an object')
  }
  const candidate = parsed as Partial<ProjectFile>
  if (candidate.format !== PROJECT_FILE_FORMAT) {
    throw new ProjectFileError(`Unexpected format: ${String(candidate.format)}`)
  }
  if (typeof candidate.schemaVersion !== 'number' || candidate.schemaVersion < 1) {
    throw new ProjectFileError('Missing project file schema version')
  }
  if (candidate.schemaVersion > PROJECT_FILE_SCHEMA_VERSION) {
    throw new ProjectFileError(
      `Project file schema ${candidate.schemaVersion} is newer than supported ${PROJECT_FILE_SCHEMA_VERSION}`,
    )
  }

  const project = candidate.project
  if (!project || typeof project !== 'object') {
    throw new ProjectFileError('Project file has no project row')
  }
  if (typeof project.id !== 'string' || typeof project.name !== 'string') {
    throw new ProjectFileError('Project row needs a string id and name')
  }

  const pages = rowsOf(candidate.pages, 'pages')
  const blocks = rowsOf(candidate.blocks, 'blocks')
  const glossary = rowsOf(candidate.glossary, 'glossary')

  const pageIds = new Set<string>()
  for (const page of pages) {
    if (page.projectId !== project.id) {
      throw new ProjectFileError('Page row belongs to another project')
    }
    pageIds.add(page.id)
  }
  for (const block of blocks) {
    if (block.projectId !== project.id) {
      throw new ProjectFileError('Block row belongs to another project')
    }
    if (typeof block.pageId !== 'string' || !pageIds.has(block.pageId)) {
      throw new ProjectFileError(`Block references a page missing from the file: ${block.id}`)
    }
  }
  for (const term of glossary) {
    if (term.projectId !== project.id) {
      throw new ProjectFileError('Glossary row belongs to another project')
    }
  }

  return candidate as ProjectFile
}

function isProjectFile(value: unknown): value is ProjectFile {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { format?: unknown }).format === PROJECT_FILE_FORMAT
  )
}

/**
 * Writes a validated project file into the local database as a brand-new
 * project. Fresh ids everywhere (a file imported twice is two projects, never
 * a collision), device-owned rows (the exporting device id is not claimed),
 * translated text and progress carried over verbatim.
 */
export async function importProjectFile(
  input: File | string | ProjectFile,
): Promise<ProjectImportResult> {
  let file: ProjectFile
  if (typeof input === 'string') file = parseProjectFile(input)
  else if (isProjectFile(input)) file = input
  else file = parseProjectFile(await (input as File).text())

  const db = getDb()
  const stamp = Date.now()

  const { id: _id, deviceId: _deviceId, ...projectRest } = file.project
  const project = stampNew<ProjectRecord>(
    {
      ...projectRest,
      archived: false,
      archivedAt: null,
      status: projectRest.status === 'archived' ? 'draft' : projectRest.status,
      lastOpenedAt: stamp,
      version: 1,
    },
    'prj',
  )

  const pageIdMap = new Map<string, string>()
  const pages = file.pages.map((page) => {
    const { id: _pageId, deviceId: _pageDeviceId, ...pageRest } = page
    const copy = stampNew<PageRecord>({ ...pageRest, projectId: project.id }, 'pg')
    pageIdMap.set(page.id, copy.id)
    return copy
  })

  const blocks = file.blocks.map((block) => {
    const { id: _blockId, deviceId: _blockDeviceId, ...blockRest } = block
    return stampNew<BlockRecord>(
      {
        ...blockRest,
        projectId: project.id,
        pageId: pageIdMap.get(block.pageId) ?? block.pageId,
      },
      'blk',
    )
  })

  const glossary = file.glossary.map((term) => {
    const { id: _termId, deviceId: _termDeviceId, ...termRest } = term
    return stampNew<GlossaryRecord>({ ...termRest, projectId: project.id }, 'gl')
  })

  await db.transaction('rw', [db.projects, db.pages, db.blocks, db.glossary], async () => {
    await db.projects.add(project)
    if (pages.length) await db.pages.bulkAdd(pages)
    if (blocks.length) await db.blocks.bulkAdd(blocks)
    if (glossary.length) await db.glossary.bulkAdd(glossary)
  })

  const warnings: ProjectImportWarning[] = []
  if (typeof file.dbSchemaVersion === 'number' && file.dbSchemaVersion > DB_SCHEMA_VERSION) {
    warnings.push('written-by-newer-app')
  }
  if (typeof project.sourceFileName === 'string' && project.sourceFileName.length > 0) {
    warnings.push('source-pdf-not-included')
  }

  return {
    project,
    counts: { pages: pages.length, blocks: blocks.length, glossary: glossary.length },
    warnings,
  }
}

/** `Annual Report 2026!` → `annual-report-2026`; a Burmese name → `project`. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'project'
}

/** Triggers a download; returns the filename handed to the browser. */
export async function downloadProjectFile(projectId: string): Promise<string> {
  const file = await createProjectFile(projectId)
  const json = serializeProjectFile(file)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `aidt-project-${slugify(file.project.name)}-${stamp}.json`
  saveJsonFile(json, filename)
  return filename
}
