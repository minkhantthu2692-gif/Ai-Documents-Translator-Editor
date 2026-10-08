/**
 * Layer 7 — merge integrity.
 *
 * `verifyDocumentIntegrity` re-plans the project with the *same*
 * `buildTranslatePlan` the run used, so "missing" can never disagree with the
 * queue about what counts as work. What these tests pin is that the two lists
 * actually mean what they say:
 *
 *   - every still-pending block shows up as missing,
 *   - a translated block does not,
 *   - a block the scope rules exclude is not "missing" (it was never work),
 *   - and nothing is ever reported twice.
 *
 * fake-indexeddb, no worker, no network.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushEvents } from '@/core/eventLogger'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import type { BlockRecord } from '@/db/types'
import { verifyDocumentIntegrity } from './integrity'
import type { TranslateRunConfig } from './types'

const PROJECT_ID = 'prj_integrity'
const BLOCK_COUNT = 12

const CONFIG: TranslateRunConfig = {
  projectId: PROJECT_ID,
  provider: 'openrouter',
  model: 'test-model',
  quality: 'medium',
  sourceLang: 'en',
  targetLang: 'my',
  translateImages: false,
  terminologyScope: 'first',
  fallbackModels: [],
  strategy: 'round-robin',
}

async function seedProject(): Promise<BlockRecord[]> {
  const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0, hasTextLayer: true })
  for (let order = 0; order < BLOCK_COUNT; order += 1) {
    await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order,
      sourceText: `Source paragraph ${order} carrying a handful of words.`,
    })
  }
  return (await blockRepo.listByProject(PROJECT_ID)).sort((a, b) => a.order - b.order)
}

/** Marks a block as landed, exactly as `persistLines` leaves it. */
async function markTranslated(id: string): Promise<void> {
  await blockRepo.update(id, { status: 'translated', translatedText: 'ဘာသာပြန်ပြီး' })
}

describe('verifyDocumentIntegrity', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-integrity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
  })

  afterEach(async () => {
    await flushEvents()
    db.close()
  })

  it('reports every still-pending block as missing', async () => {
    await seedProject()

    const report = await verifyDocumentIntegrity(PROJECT_ID, CONFIG)

    expect(report.checked).toBe(BLOCK_COUNT)
    expect(report.missing).toHaveLength(BLOCK_COUNT)
    expect(report.duplicated).toHaveLength(0)
    expect(report.ok).toBe(false)
  })

  it('is whole once every block has landed', async () => {
    const blocks = await seedProject()
    for (const block of blocks) await markTranslated(block.id)

    const report = await verifyDocumentIntegrity(PROJECT_ID, CONFIG)

    expect(report.checked).toBe(BLOCK_COUNT)
    expect(report.missing).toEqual([])
    expect(report.duplicated).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('reports only the blocks the merge never reached', async () => {
    const blocks = await seedProject()
    for (const block of blocks.slice(0, BLOCK_COUNT / 2)) await markTranslated(block.id)

    const report = await verifyDocumentIntegrity(PROJECT_ID, CONFIG)

    expect(report.checked).toBe(BLOCK_COUNT)
    expect(report.missing).toHaveLength(BLOCK_COUNT / 2)
    // A landed block must never be reported missing, and never twice.
    expect(new Set(report.missing).size).toBe(report.missing.length)
    for (const block of blocks.slice(0, BLOCK_COUNT / 2)) {
      expect(report.missing).not.toContain(block.id)
    }
  })

  it('does not call a block missing when the scope rules exclude it', async () => {
    const blocks = await seedProject()
    for (const block of blocks) await markTranslated(block.id)
    // Locked and blank blocks are not work — they were never in the plan.
    await blockRepo.update(blocks[0].id, { status: 'locked' })
    // `pending` as well as blank: a translated block is `done` before the
    // blank-source rule is ever consulted.
    await blockRepo.update(blocks[1].id, { status: 'pending', sourceText: '   ' })

    const report = await verifyDocumentIntegrity(PROJECT_ID, CONFIG)

    expect(report.checked).toBe(BLOCK_COUNT - 2)
    expect(report.missing).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('honours the image switch the run itself used', async () => {
    const scanned = await pageRepo.upsert({ projectId: PROJECT_ID, index: 1, hasTextLayer: false })
    await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: scanned.id,
      order: 0,
      sourceText: 'OCR text that is out of scope when image translation is off.',
    })

    const off = await verifyDocumentIntegrity(PROJECT_ID, {
      ...CONFIG,
      translateImages: false,
    })
    const on = await verifyDocumentIntegrity(PROJECT_ID, {
      ...CONFIG,
      translateImages: true,
    })

    // Same scope rules as the queue: an OCR page is not work while the image
    // switch is off, so it cannot be "missing" either.
    expect(off.checked).toBe(0)
    expect(off.ok).toBe(true)
    expect(on.checked).toBe(1)
    expect(on.ok).toBe(false)
  })

  it('never reports a duplicate across pages', async () => {
    for (let index = 0; index < 3; index += 1) {
      const page = await pageRepo.upsert({ projectId: PROJECT_ID, index, hasTextLayer: true })
      for (let order = 0; order < 5; order += 1) {
        await blockRepo.upsert({
          projectId: PROJECT_ID,
          pageId: page.id,
          order,
          sourceText: `Page ${index} line ${order} with a few words.`,
        })
      }
    }

    const report = await verifyDocumentIntegrity(PROJECT_ID, CONFIG)

    expect(report.checked).toBe(15)
    expect(report.duplicated).toEqual([])
  })
})
