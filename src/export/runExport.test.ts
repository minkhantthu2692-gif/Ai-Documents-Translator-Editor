import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { suggestFallback, BUNDLED_FAMILIES } from '@/fonts'
import {
  EXPORT_STACK_FAMILIES,
  imageRequirement,
  preflightFamilies,
  preflightProject,
  projectFontFamilies,
} from './runExport'

/**
 * The orchestration itself needs a worker and a real PDF, so what is pinned
 * down here is everything that decides *whether* work happens: which formats
 * must render page artwork, which families the preflight reports, and the
 * substitution offered as the fix action.
 */
describe('imageRequirement', () => {
  it('is mandatory for the raster formats', () => {
    expect(imageRequirement('pdf-raster', false)).toBe(true)
    expect(imageRequirement('images', false)).toBe(true)
  })

  it('follows the option for the layout formats', () => {
    expect(imageRequirement('html', true)).toBe(true)
    expect(imageRequirement('pdf', true)).toBe(true)
    expect(imageRequirement('bilingual-pdf', true)).toBe(true)
    expect(imageRequirement('html', false)).toBe(false)
    expect(imageRequirement('pdf', false)).toBe(false)
  })

  it('never asks for artwork in text-only formats', () => {
    for (const format of ['markdown', 'text', 'json', 'csv', 'tsv', 'docx', 'epub'] as const) {
      expect(imageRequirement(format, true)).toBe(false)
    }
  })
})

describe('project font families', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-preflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
  })

  it('collects distinct families with a text sample each', async () => {
    const page = await pageRepo.upsert({ projectId: 'prj_font', index: 0 })
    await blockRepo.upsert({
      projectId: 'prj_font',
      pageId: page.id,
      order: 0,
      fontFamily: 'ABCDEF+Calibri',
      sourceText: 'Torque curve',
      translatedText: 'တာယာအား မှတ်တမ်း',
    })
    await blockRepo.upsert({
      projectId: 'prj_font',
      pageId: page.id,
      order: 1,
      fontFamily: 'ABCDEF+Calibri',
      sourceText: 'Second use',
      translatedText: '',
    })
    await blockRepo.upsert({
      projectId: 'prj_font',
      pageId: page.id,
      order: 2,
      fontFamily: 'Padauk',
      sourceText: 'Other',
      translatedText: 'အခြား',
    })

    const families = await projectFontFamilies('prj_font')
    expect(families.map((entry) => entry.family)).toEqual(['ABCDEF+Calibri', 'Padauk'])
    // The sample is the first block that used it (translated text first —
    // that is what the script-aware fallback has to be judged against).
    expect(families[0].sample).toBe('တာယာအား မှတ်တမ်း')
  })

  it('ignores blocks with no family and other projects', async () => {
    const page = await pageRepo.upsert({ projectId: 'prj_other', index: 0 })
    await blockRepo.upsert({
      projectId: 'prj_other',
      pageId: page.id,
      fontFamily: '  ',
      sourceText: 'x',
    })
    expect(await projectFontFamilies('prj_other')).toEqual([])
    expect(await projectFontFamilies('prj_missing')).toEqual([])
  })

  it('preflights bundled families as present and maps the rest to a fallback', async () => {
    const families = [
      { family: 'Noto Sans', sample: 'hello' },
      { family: 'Noto Sans Myanmar', sample: 'မင်္ဂလာပါ' },
      { family: 'ABCDEF+Calibri', sample: 'Torque curve' },
    ]
    const preflight = await preflightProject('prj_nothing')
    expect(preflight.families).toEqual([])

    const result = await preflightFamilies(families)
    expect(result.families).toEqual(['Noto Sans', 'Noto Sans Myanmar', 'ABCDEF+Calibri'])
    expect(result.missing).not.toContain('Noto Sans')
    expect(result.missing).not.toContain('Noto Sans Myanmar')
    // Every suggestion is a family the app ships — the fix action must be safe.
    for (const [from, to] of Object.entries(result.substitutions)) {
      expect(BUNDLED_FAMILIES as readonly string[]).toContain(to)
      expect(to).toBe(suggestFallback(from, ''))
    }
    // The embeddable stack always offers Myanmar-capable faces.
    expect(EXPORT_STACK_FAMILIES).toContain('Noto Sans Myanmar')
    expect(EXPORT_STACK_FAMILIES).toContain('Padauk')
  })
})
