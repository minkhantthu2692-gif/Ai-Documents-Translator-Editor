/** Glossary and translation-memory repositories. */

import { getDb } from './db'
import { hashText, stampNew, stampUpdate } from './repo-common'
import { enqueueDelete } from '@/sync/hooks'
import type { GlossaryRecord, TranslationMemoryRecord } from './types'

export class GlossaryRepository {
  list(projectId?: string | null): Promise<GlossaryRecord[]> {
    const table = getDb().glossary
    if (projectId === undefined) return table.toArray()
    if (projectId === null) return table.where('projectId').equals('global').toArray()
    return table.where('projectId').equals(projectId).toArray()
  }

  async create(
    input: Partial<GlossaryRecord> & { sourceTerm: string; targetTerm: string },
  ): Promise<GlossaryRecord> {
    const db = getDb()
    const record = stampNew<GlossaryRecord>(
      {
        projectId: null,
        sourceLang: 'en',
        targetLang: 'my',
        notes: '',
        caseSensitive: false,
        ...input,
      },
      'gl',
    )
    await db.glossary.add(record)
    return record
  }

  async update(id: string, patch: Partial<GlossaryRecord>): Promise<GlossaryRecord> {
    const db = getDb()
    const existing = await db.glossary.get(id)
    if (!existing) throw new Error(`Glossary entry not found: ${id}`)
    const next = stampUpdate(existing, patch)
    await db.glossary.put(next)
    return next
  }

  async remove(id: string): Promise<void> {
    const db = getDb()
    const existing = await db.glossary.get(id)
    await db.glossary.delete(id)
    if (existing) {
      await enqueueDelete('glossary', existing as unknown as Record<string, unknown>)
    }
  }
}

export class TranslationMemoryRepository {
  async find(
    sourceText: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<TranslationMemoryRecord | undefined> {
    const sourceHash = hashText(`${sourceLang}|${targetLang}|${sourceText}`)
    const match = await getDb()
      .translationMemory.where('[sourceLang+targetLang+sourceHash]')
      .equals([sourceLang, targetLang, sourceHash] as never)
      .first()
    if (match) {
      const table = getDb().translationMemory
      const updated = stampUpdate(match, { hits: match.hits + 1, lastUsedAt: Date.now() })
      await table.put(updated)
      return updated
    }
    return undefined
  }

  async put(input: {
    sourceText: string
    targetText: string
    sourceLang: string
    targetLang: string
    provider: string
    model: string
  }): Promise<TranslationMemoryRecord> {
    const db = getDb()
    const sourceHash = hashText(`${input.sourceLang}|${input.targetLang}|${input.sourceText}`)
    const existing = await db.translationMemory
      .where('[sourceLang+targetLang+sourceHash]')
      .equals([input.sourceLang, input.targetLang, sourceHash] as never)
      .first()
    if (existing) {
      const next = stampUpdate(existing, {
        targetText: input.targetText,
        provider: input.provider,
        model: input.model,
        lastUsedAt: Date.now(),
      })
      await db.translationMemory.put(next)
      return next
    }
    const record = stampNew<TranslationMemoryRecord>(
      {
        sourceHash,
        sourceText: input.sourceText,
        targetText: input.targetText,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        provider: input.provider,
        model: input.model,
        characters: input.sourceText.length,
        hits: 1,
        lastUsedAt: Date.now(),
      },
      'tm',
    )
    await db.translationMemory.add(record)
    return record
  }

  async top(limit = 50): Promise<TranslationMemoryRecord[]> {
    const rows = await getDb().translationMemory.toArray()
    return rows.sort((a, b) => b.hits - a.hits || b.lastUsedAt - a.lastUsedAt).slice(0, limit)
  }

  async clear(): Promise<void> {
    await getDb().translationMemory.clear()
  }
}

export const glossaryRepo = new GlossaryRepository()
export const translationMemoryRepo = new TranslationMemoryRepository()
