import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, setDb } from './db'
import { blockRepo, pageRepo, type ParsedBlockPatch } from './repo-content'

/**
 * The whole "layout can be re-parsed without losing work" guarantee rests on
 * these three writes: ids are content hashes (so a re-parse maps onto the same
 * rows), `upsertParsed` may not touch translation state, and stale blocks are
 * the only thing a re-parse is allowed to delete.
 */
function patch(
  overrides: Partial<ParsedBlockPatch> & Pick<ParsedBlockPatch, 'id' | 'pageId'>,
): ParsedBlockPatch {
  return {
    projectId: 'prj_1',
    order: 0,
    kind: 'paragraph',
    sourceText: 'Hello world',
    x: 10,
    y: 20,
    width: 120,
    height: 14,
    fontFamily: 'Noto Sans',
    fontSize: 12,
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
    ...overrides,
  }
}

describe('content repositories', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
  })

  it('keeps the block id — and its translation — across a re-parse', async () => {
    const page = await pageRepo.upsert({ projectId: 'prj_1', index: 0 })
    const block = await blockRepo.upsert({
      projectId: 'prj_1',
      pageId: page.id,
      sourceText: 'Hello world',
    })
    await blockRepo.update(block.id, { status: 'translated', translatedText: 'မင်္ဂလာပါ' })

    await blockRepo.upsertParsed([
      patch({
        id: block.id,
        pageId: page.id,
        sourceText: 'Hello world, re-wrapped',
        fontSize: 14,
      }),
    ])

    const rows = await blockRepo.listByProject('prj_1')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(block.id)
    expect(rows[0].sourceText).toBe('Hello world, re-wrapped')
    expect(rows[0].fontSize).toBe(14)
    expect(rows[0].status).toBe('translated')
    expect(rows[0].translatedText).toBe('မင်္ဂလာပါ')
  })

  it('starts a never-seen block as pending, not undefined', async () => {
    const page = await pageRepo.upsert({ projectId: 'prj_1', index: 1 })
    await blockRepo.upsertParsed([patch({ id: 'blk_stable_1', pageId: page.id })])

    const row = await blockRepo.get('blk_stable_1')
    expect(row?.status).toBe('pending')
    expect(row?.translatedText).toBe('')
    expect(row?.createdAt).toBeGreaterThan(0)
  })

  it('drops only the blocks a re-parse no longer produces', async () => {
    const page = await pageRepo.upsert({ projectId: 'prj_1', index: 2 })
    await blockRepo.upsertParsed([
      patch({ id: 'blk_a', pageId: page.id, order: 0 }),
      patch({ id: 'blk_b', pageId: page.id, order: 1 }),
      patch({ id: 'blk_c', pageId: page.id, order: 2 }),
    ])

    const removed = await blockRepo.removeStaleByPage(page.id, ['blk_a', 'blk_c'])
    expect(removed).toBe(1)
    expect((await blockRepo.listByPage(page.id)).map((row) => row.id)).toEqual(['blk_a', 'blk_c'])
  })

  it('hands the parse queue only the pages still owed work', async () => {
    await pageRepo.upsert({ projectId: 'prj_1', index: 0, analysisState: 'done' })
    await pageRepo.upsert({ projectId: 'prj_1', index: 1, analysisState: 'failed' })
    await pageRepo.upsert({ projectId: 'prj_1', index: 2, analysisState: 'running' })
    await pageRepo.upsert({ projectId: 'prj_2', index: 0, analysisState: 'idle' })

    const owed = await pageRepo.listUnparsed('prj_1')
    expect(owed.map((page) => page.index)).toEqual([1, 2])
  })
})
