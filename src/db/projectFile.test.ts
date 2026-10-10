import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, DB_SCHEMA_VERSION, setDb } from './db'
import { blockRepo, pageRepo, type ParsedBlockPatch } from './repo-content'
import {
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_SCHEMA_VERSION,
  ProjectFileError,
  createProjectFile,
  importProjectFile,
  parseProjectFile,
  serializeProjectFile,
} from './projectFile'
import type { ProjectRecord } from './types'

/**
 * A project file moves one project between devices: everything that belongs to
 * the project travels, the wiring (project/page/block ids) is remapped onto a
 * fresh copy on import, and nothing local can be overwritten by a file.
 */

function makeProject(id: string, name: string, updatedAt: number): ProjectRecord {
  return {
    id,
    name,
    sourceFileName: `${name}.pdf`,
    sourceFileSize: 1024,
    sourceLang: 'en',
    targetLang: 'my',
    status: 'draft',
    pageCount: 1,
    translatedPageCount: 1,
    blockCount: 2,
    characterCount: 30,
    progress: 50,
    archived: false,
    archivedAt: null,
    lastOpenedAt: updatedAt,
    notes: '',
    createdAt: updatedAt,
    updatedAt,
    deviceId: 'dev_exporter',
    version: 1,
  }
}

function patch(
  overrides: Partial<ParsedBlockPatch> & Pick<ParsedBlockPatch, 'id' | 'pageId'>,
): ParsedBlockPatch {
  return {
    projectId: 'prj_a',
    order: 0,
    kind: 'paragraph',
    sourceText: 'Hello world',
    x: 10,
    y: 20,
    width: 120,
    height: 14,
    fontFamily: 'Noto Sans',
    originalFontFamily: 'Noto Sans',
    fontSize: 12,
    originalFontSize: 12,
    lineHeight: 1.7,
    color: '#000000',
    bold: false,
    italic: false,
    characterCount: 11,
    region: 'body',
    alignment: 'left',
    lines: [],
    skipRule: null,
    placeholders: [],
    listMarker: null,
    fontSizeMode: 'original',
    overflow: false,
    ...overrides,
  }
}

describe('project files', () => {
  let db: AppDatabase
  let pageIdA: string

  beforeEach(async () => {
    db = new AppDatabase()
    setDb(db)
    await db.projects.bulkPut([
      makeProject('prj_a', 'Annual report', 1_700_000_000_000),
      makeProject('prj_b', 'User manual', 1_700_000_100_000),
    ])

    const page = await pageRepo.upsert({ projectId: 'prj_a', index: 0 })
    pageIdA = page.id
    const other = await pageRepo.upsert({ projectId: 'prj_b', index: 0 })
    await blockRepo.upsertParsed([
      patch({ id: 'blk_a1', pageId: page.id, order: 0 }),
      patch({ id: 'blk_a2', pageId: page.id, order: 1, kind: 'heading', sourceText: 'Title' }),
    ])
    await blockRepo.update('blk_a1', { status: 'translated', translatedText: 'မင်္ဂလာပါ' })
    await blockRepo.upsertParsed([patch({ id: 'blk_b1', pageId: other.id, projectId: 'prj_b' })])

    // Fixed ids: the seed must be idempotent — this database outlives a single
    // test in the file, so a minted-per-run id would accumulate.
    await db.glossary.bulkPut([
      {
        id: 'gl_invoice',
        projectId: 'prj_a',
        sourceTerm: 'invoice',
        targetTerm: 'ငွေတောင်းခံစာ',
        sourceLang: 'en',
        targetLang: 'my',
        notes: '',
        caseSensitive: false,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        deviceId: 'dev_exporter',
        version: 1,
      },
      {
        // Device-global terms belong to this device, not to the project.
        id: 'gl_global',
        projectId: null,
        sourceTerm: 'global',
        targetTerm: 'ကမ္ဘာလုံးဆိုင်ရာ',
        sourceLang: 'en',
        targetLang: 'my',
        notes: '',
        caseSensitive: false,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        deviceId: 'dev_exporter',
        version: 1,
      },
    ])
  })

  it('exports one project with its pages, blocks and glossary — nothing else', async () => {
    const file = await createProjectFile('prj_a')

    expect(file.format).toBe(PROJECT_FILE_FORMAT)
    expect(file.schemaVersion).toBe(PROJECT_FILE_SCHEMA_VERSION)
    expect(file.dbSchemaVersion).toBe(DB_SCHEMA_VERSION)
    expect(file.project.id).toBe('prj_a')
    expect(file.counts).toEqual({ pages: 1, blocks: 2, glossary: 1 })
    expect(file.pages.every((page) => page.projectId === 'prj_a')).toBe(true)
    expect(file.blocks.map((block) => block.id).sort()).toEqual(['blk_a1', 'blk_a2'])
    expect(file.glossary).toHaveLength(1)
    expect(file.glossary[0].sourceTerm).toBe('invoice')
  })

  it('refuses to export a project that is not there', async () => {
    await expect(createProjectFile('prj_missing')).rejects.toThrow(ProjectFileError)
  })

  it('round-trips through JSON into a fresh, self-consistent project', async () => {
    const json = serializeProjectFile(await createProjectFile('prj_a'))
    const result = await importProjectFile(json)

    expect(result.project.id).not.toBe('prj_a')
    expect(result.project.name).toBe('Annual report')
    // The rows are owned by the importing device, not by the exporting one.
    expect(result.project.deviceId).not.toBe('dev_exporter')
    expect(result.counts).toEqual({ pages: 1, blocks: 2, glossary: 1 })
    expect(result.warnings).toContain('source-pdf-not-included')

    const pages = await db.pages.where('projectId').equals(result.project.id).toArray()
    const blocks = await db.blocks.where('projectId').equals(result.project.id).toArray()
    expect(pages).toHaveLength(1)
    expect(pages[0].id).not.toBe(pageIdA)
    expect(blocks).toHaveLength(2)

    // The wiring is remapped, not copied: every block hangs off the new page
    // and the new project, and translation state survived verbatim.
    expect(blocks.every((block) => block.pageId === pages[0].id)).toBe(true)
    const translated = blocks.find((block) => block.sourceText === 'Hello world')
    expect(translated?.translatedText).toBe('မင်္ဂလာပါ')
    expect(translated?.status).toBe('translated')

    const glossary = await db.glossary.where('projectId').equals(result.project.id).toArray()
    expect(glossary).toHaveLength(1)
    expect(glossary[0].sourceTerm).toBe('invoice')
  })

  it('is additive — importing the same file twice gives two projects', async () => {
    // The database outlives a single test in this file, so count from here.
    const before = await db.projects.count()
    const json = serializeProjectFile(await createProjectFile('prj_a'))
    const first = await importProjectFile(json)
    const second = await importProjectFile(json)

    expect(second.project.id).not.toBe(first.project.id)
    const projects = await db.projects.toArray()
    expect(projects).toHaveLength(before + 2)
    expect(new Set(projects.map((project) => project.id)).size).toBe(before + 2)

    const firstBlocks = await db.blocks.where('projectId').equals(first.project.id).toArray()
    const secondBlocks = await db.blocks.where('projectId').equals(second.project.id).toArray()
    expect(firstBlocks.some((block) => secondBlocks.some((other) => other.id === block.id))).toBe(
      false,
    )
  })

  it('an imported project always lands in the active list, PDF warning or not', async () => {
    const file = await createProjectFile('prj_a')
    file.project.archived = true
    file.project.archivedAt = 1_700_000_000_000
    file.project.status = 'archived'
    file.project.sourceFileName = ''

    const result = await importProjectFile(file)

    expect(result.project.archived).toBe(false)
    expect(result.project.archivedAt).toBeNull()
    expect(result.project.status).toBe('draft')
    expect(result.warnings).not.toContain('source-pdf-not-included')
  })

  it('reports a file written by a newer app without failing the import', async () => {
    const file = await createProjectFile('prj_a')
    const result = await importProjectFile({ ...file, dbSchemaVersion: DB_SCHEMA_VERSION + 1 })
    expect(result.warnings).toContain('written-by-newer-app')
  })

  it('rejects foreign or half-wired JSON without touching the database', async () => {
    const good = serializeProjectFile(await createProjectFile('prj_a'))
    const before = await db.projects.count()

    expect(() => parseProjectFile('not json')).toThrow(ProjectFileError)
    expect(() => parseProjectFile('{"format":"something-else"}')).toThrow(/format/)
    expect(() => parseProjectFile('{"format":"aidt-project"}')).toThrow(/schema version/)

    const newer = JSON.parse(good) as Record<string, unknown>
    newer.schemaVersion = PROJECT_FILE_SCHEMA_VERSION + 1
    expect(() => parseProjectFile(JSON.stringify(newer))).toThrow(/newer than supported/)

    // A block whose page was stripped out of the file would import dangling.
    const dangling = JSON.parse(good) as { blocks: { pageId: string }[] }
    dangling.blocks[0].pageId = 'pg_from_nowhere'
    expect(() => parseProjectFile(JSON.stringify(dangling))).toThrow(/page missing/)

    // A row smuggled in from another project would hijack the import.
    const hijack = JSON.parse(good) as { pages: { projectId: string }[] }
    hijack.pages[0].projectId = 'prj_b'
    expect(() => parseProjectFile(JSON.stringify(hijack))).toThrow(/another project/)

    expect(await db.projects.count()).toBe(before)
  })
})
