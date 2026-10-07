/** Content repositories: pages, blocks, translations. */

import { getDb } from './db'
import { stampNew, stampUpdate } from './repo-common'
import type { BlockRecord, PageRecord, TranslationRecord } from './types'

export class PageRepository {
  listByProject(projectId: string): Promise<PageRecord[]> {
    return getDb().pages.where('projectId').equals(projectId).sortBy('index')
  }

  get(id: string): Promise<PageRecord | undefined> {
    return getDb().pages.get(id)
  }

  async getByIndex(projectId: string, index: number): Promise<PageRecord | undefined> {
    return getDb()
      .pages.where('[projectId+index]')
      .equals([projectId, index] as never)
      .first()
  }

  async upsert(
    input: Partial<PageRecord> & { projectId: string; index: number },
  ): Promise<PageRecord> {
    const db = getDb()
    const existing = await this.getByIndex(input.projectId, input.index)
    if (existing) {
      const next = stampUpdate(existing, input)
      await db.pages.put(next)
      return next
    }
    const record = stampNew<PageRecord>(
      {
        width: 0,
        height: 0,
        rotation: 0,
        hasTextLayer: false,
        textCharacterCount: 0,
        ocrStatus: 'idle',
        renderStatus: 'idle',
        blockCount: 0,
        ...input,
      },
      'pg',
    )
    await db.pages.add(record)
    return record
  }

  update(id: string, patch: Partial<PageRecord>): Promise<PageRecord> {
    return (async () => {
      const db = getDb()
      const existing = await db.pages.get(id)
      if (!existing) throw new Error(`Page not found: ${id}`)
      const next = stampUpdate(existing, patch)
      await db.pages.put(next)
      return next
    })()
  }

  removeByProject(projectId: string): Promise<number> {
    return getDb().pages.where('projectId').equals(projectId).delete()
  }
}

export class BlockRepository {
  listByProject(projectId: string): Promise<BlockRecord[]> {
    return getDb().blocks.where('projectId').equals(projectId).sortBy('order')
  }

  listByPage(pageId: string): Promise<BlockRecord[]> {
    return getDb().blocks.where('pageId').equals(pageId).sortBy('order')
  }

  get(id: string): Promise<BlockRecord | undefined> {
    return getDb().blocks.get(id)
  }

  async upsert(
    input: Partial<BlockRecord> & { projectId: string; pageId: string },
  ): Promise<BlockRecord> {
    const db = getDb()
    if (input.id) {
      const existing = await db.blocks.get(input.id)
      if (existing) {
        const next = stampUpdate(existing, input)
        await db.blocks.put(next)
        return next
      }
    }
    const record = stampNew<BlockRecord>(
      {
        order: 0,
        kind: 'paragraph',
        sourceText: '',
        translatedText: '',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fontFamily: 'Noto Sans',
        fontSize: 12,
        lineHeight: 1.5,
        color: '#000000',
        bold: false,
        italic: false,
        status: 'pending',
        characterCount: 0,
        ...input,
      },
      'blk',
    )
    await db.blocks.add(record)
    return record
  }

  async bulkUpsert(
    records: Array<Partial<BlockRecord> & { projectId: string; pageId: string }>,
  ): Promise<BlockRecord[]> {
    const results: BlockRecord[] = []
    for (const record of records) {
      if (!record.projectId || !record.pageId) throw new Error('block requires projectId & pageId')
      results.push(await this.upsert(record))
    }
    return results
  }

  async update(id: string, patch: Partial<BlockRecord>): Promise<BlockRecord> {
    const db = getDb()
    const existing = await db.blocks.get(id)
    if (!existing) throw new Error(`Block not found: ${id}`)
    const next = stampUpdate(existing, patch)
    await db.blocks.put(next)
    return next
  }

  removeByProject(projectId: string): Promise<number> {
    return getDb().blocks.where('projectId').equals(projectId).delete()
  }
}

export class TranslationRepository {
  listByProject(projectId: string): Promise<TranslationRecord[]> {
    return getDb().translations.where('projectId').equals(projectId).toArray()
  }

  async findByHash(sourceHash: string): Promise<TranslationRecord | undefined> {
    return getDb().translations.where('sourceHash').equals(sourceHash).first()
  }

  async upsert(
    input: Partial<TranslationRecord> & { projectId: string; blockId: string },
  ): Promise<TranslationRecord> {
    const db = getDb()
    if (input.id) {
      const existing = await db.translations.get(input.id)
      if (existing) {
        const next = stampUpdate(existing, input)
        await db.translations.put(next)
        return next
      }
    }
    const record = stampNew<TranslationRecord>(
      {
        sourceText: '',
        translatedText: '',
        sourceHash: '',
        sourceLang: 'en',
        targetLang: 'my',
        provider: 'unknown',
        model: 'unknown',
        characters: 0,
        tokens: 0,
        status: 'pending',
        reasonCode: null,
        ...input,
      },
      'trn',
    )
    await db.translations.add(record)
    return record
  }

  removeByProject(projectId: string): Promise<number> {
    return getDb().translations.where('projectId').equals(projectId).delete()
  }
}

export const pageRepo = new PageRepository()
export const blockRepo = new BlockRepository()
export const translationRepo = new TranslationRepository()
