/**
 * Accepting a suggestion is the cheapest end-to-end proof that phase (d)
 * actually fires: no worker, no network and no queue — one block, one
 * suggestion, one command. It exercises the whole path the bulk queue takes
 * (setting → fit → merge → `commitCommand` → Dexie), because the alternative
 * would be asserting the pure function twice.
 *
 * fake-indexeddb + a test-seam measurer: no DOM, no canvas, no clock.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type { BlockRecord } from '@/db/types'
import { setTextMeasurer, type TextMeasurer } from './autofit'
import { acceptSuggestion } from './retranslate'

const PROJECT_ID = 'prj_layout'

/** ~0.5 em average advance — deterministic, no canvas needed. */
const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize * 0.5

/** Fourteen words: three lines at 12pt in a 200×40pt box, two at 8pt. */
const LONG = Array.from({ length: 14 }, () => 'word').join(' ')

/** Four words: one line, comfortably inside the box at the extracted size. */
const SHORT = Array.from({ length: 4 }, () => 'word').join(' ')

let db: AppDatabase

async function seed(suggestedText: string): Promise<BlockRecord> {
  const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0, hasTextLayer: true })
  await blockRepo.upsert({
    projectId: PROJECT_ID,
    pageId: page.id,
    order: 0,
    sourceText: 'Source paragraph carrying a handful of words.',
    width: 200,
    height: 40,
    lineHeight: 1.6,
    fontSize: 12,
    originalFontSize: 12,
    suggestedText,
  })
  const [block] = await blockRepo.listByProject(PROJECT_ID)
  return block
}

async function reseed(suggestedText: string): Promise<string> {
  await db.blocks.clear()
  return (await seed(suggestedText)).id
}

describe('acceptSuggestion layout', () => {
  beforeEach(async () => {
    db = new AppDatabase(`aidt-layout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    setTextMeasurer(measure)
    await settingsRepo.remove(SETTING_KEYS.autoFit)
  })

  afterEach(async () => {
    setTextMeasurer(null)
    await db.blocks.clear()
    await db.settings.clear()
    db.close()
  })

  it('steps the size down when the accepted translation outgrew the box', async () => {
    const id = await reseed(LONG)

    expect(await acceptSuggestion(PROJECT_ID, id)).toEqual({ accepted: true })

    const block = (await blockRepo.get(id)) as BlockRecord
    expect(block.translatedText).toBe(LONG)
    expect(block.fontSizeMode).toBe('auto')
    expect(block.fontSize).toBeLessThan(12)
    expect(block.fontSize).toBeGreaterThanOrEqual(6)
    expect(block.overflow).toBe(false)
  })

  it('leaves the size alone when the translation still fits', async () => {
    const id = await reseed(SHORT)

    await acceptSuggestion(PROJECT_ID, id)

    const block = (await blockRepo.get(id)) as BlockRecord
    expect(block.fontSizeMode).toBe('original')
    expect(block.fontSize).toBe(12)
    expect(block.overflow).toBe(false)
  })

  it('writes the re-fit into the same history row as the text it belongs to', async () => {
    const id = await reseed(LONG)

    await acceptSuggestion(PROJECT_ID, id)

    const rows = await db.revisions.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('accept-suggestion')
    expect(rows[0].after).toMatchObject({ translatedText: LONG, fontSizeMode: 'auto' })
    // One change, not one per field: undo puts the size and the text back
    // together or not at all.
    expect(rows[0].before).toHaveProperty('fontSize', 12)
  })

  it('does nothing to the layout when the reader has switched auto-fit off', async () => {
    await settingsRepo.set(SETTING_KEYS.autoFit, false, 'layout')
    const id = await reseed(LONG)

    await acceptSuggestion(PROJECT_ID, id)

    const block = (await blockRepo.get(id)) as BlockRecord
    expect(block.translatedText).toBe(LONG)
    expect(block.fontSizeMode).toBe('original')
    expect(block.fontSize).toBe(12)
    expect(block.overflow).toBe(false)
  })

  it('ignores a block with no box, which has no layout to adjust', async () => {
    const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0, hasTextLayer: true })
    await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order: 0,
      sourceText: 'Source.',
      suggestedText: LONG,
    })
    const [block] = await blockRepo.listByProject(PROJECT_ID)

    await acceptSuggestion(PROJECT_ID, block.id)

    const stored = (await blockRepo.get(block.id)) as BlockRecord
    expect(stored.translatedText).toBe(LONG)
    expect(stored.fontSizeMode).toBe('original')
    expect(stored.overflow).toBe(false)
  })
})
