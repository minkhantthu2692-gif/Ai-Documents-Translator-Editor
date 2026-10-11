/**
 * Prompt assembly: what context a batch is handed, and the guarantee that only
 * the numbered lines are ever translated.
 *
 * The context block is the whole of Layer 6's "heading chain" (the part that
 * costs tokens), so it is worth pinning exactly what leaves the machine.
 */
import { describe, expect, it } from 'vitest'
import { GLOSSARY_CAP, selectGlossary, systemPrompt, userPrompt } from './prompts'
import { estimateTokens } from './tokenEstimate'
import type { BatchLine, GlossarySpec, PromptContext, TranslationBatch } from './types'

function batch(texts: string[]): TranslationBatch {
  const lines: BatchLine[] = texts.map((text, index) => ({
    id: `blk_${index}`,
    text,
    pageIndex: 0,
    order: index,
    listMarker: null,
    kind: 'paragraph',
    placeholders: [],
  }))
  return { id: 'p#1#0#0', pageIndex: 0, lines, tokens: 0, index: 0 }
}

function context(partial: Partial<PromptContext>): PromptContext {
  return { before: '', after: '', ...partial }
}

describe('userPrompt context', () => {
  it('leads with the section heading, then the neighbouring lines', () => {
    const prompt = userPrompt(
      batch(['a body line']),
      context({
        before: 'previous line',
        after: 'next line',
        section: 'Energy conservation',
        sectionTranslation: 'စွမ်းအင်ထိန်းသိမ်းမှု',
      }),
    )

    expect(prompt).toContain('Section heading (context only): Energy conservation')
    expect(prompt).toContain('Already translated as (context only): စွမ်းအင်ထိန်းသိမ်းမှု')
    expect(prompt).toContain('Previous line (context only): previous line')
    expect(prompt).toContain('Next line (context only): next line')
    // The section comes first so the model anchors on it before the neighbours.
    expect(prompt.indexOf('Section heading')).toBeLessThan(prompt.indexOf('Previous line'))
  })

  it('offers a section on its own when a page boundary leaves no neighbour', () => {
    const prompt = userPrompt(batch(['a body line']), context({ section: 'Appendix A' }))

    expect(prompt).toContain('Section heading (context only): Appendix A')
    expect(prompt).not.toContain('Previous line')
    expect(prompt).not.toContain('Next line')
  })

  it('never repeats the heading as its own translation', () => {
    const prompt = userPrompt(
      batch(['x']),
      context({ section: 'Heading', sectionTranslation: 'Heading' }),
    )

    expect(prompt).toContain('Section heading (context only): Heading')
    expect(prompt).not.toContain('Already translated as')
  })

  it('omits the context block entirely when there is nothing to say', () => {
    const prompt = userPrompt(batch(['a body line']), context({}))

    expect(prompt).not.toContain('context only')
    expect(prompt).toContain('1. [id=blk_0] a body line')
  })

  it('works with no context argument at all (Basic quality)', () => {
    expect(userPrompt(batch(['only line']))).toContain('1. [id=blk_0] only line')
  })

  it('numbers only the batch lines — context is never translated', () => {
    const prompt = userPrompt(
      batch(['first line', 'second line']),
      context({ before: 'ignored', after: 'ignored too', section: 'ignored as well' }),
    )

    expect(prompt).toContain('1. [id=blk_0] first line')
    expect(prompt).toContain('2. [id=blk_1] second line')
    expect(prompt.match(/^\d+\. \[id=/gm)).toHaveLength(2)
    expect(prompt.endsWith('Translate every numbered line into JSON now.')).toBe(true)
  })
})

describe('systemPrompt', () => {
  it('carries the glossary and the occurrence rule', () => {
    const prompt = systemPrompt({
      sourceLang: 'English',
      targetLang: 'Myanmar',
      quality: 'medium',
      terminologyScope: 'document',
      glossary: [{ sourceTerm: 'key', targetTerm: 'သော့', caseSensitive: false }],
    })

    expect(prompt).toContain('- "key" = "သော့"')
    expect(prompt).toContain('first occurrence in the document')
  })

  it('truncates the glossary at the shared cap', () => {
    expect(GLOSSARY_CAP).toBe(200)
    const prompt = systemPrompt({
      sourceLang: 'English',
      targetLang: 'Myanmar',
      quality: 'medium',
      terminologyScope: 'first',
      glossary: Array.from({ length: GLOSSARY_CAP + 5 }, (_, index) => ({
        sourceTerm: `term${index}`,
        targetTerm: `t${index}`,
        caseSensitive: false,
      })),
    })

    expect(prompt).toContain('- "term0" = "t0"')
    expect(prompt).toContain(`- "term${GLOSSARY_CAP - 1}" = "t${GLOSSARY_CAP - 1}"`)
    expect(prompt).not.toContain(`- "term${GLOSSARY_CAP}"`)
  })
})

/**
 * Which glossary terms travel with a batch.
 *
 * This is the largest single lever on how much a free-tier key can translate:
 * the glossary is re-sent on every request, so sending the whole document
 * glossary to every batch was spending ~3,000 tokens per request on terms the
 * batch never contained.
 */
describe('selectGlossary', () => {
  const term = (index: number): GlossarySpec => ({
    sourceTerm: `alpha${index}`,
    targetTerm: `အေလဗာ${index}`,
    caseSensitive: false,
  })

  function many(count: number): GlossarySpec[] {
    return Array.from({ length: count }, (_, index) => term(index))
  }

  it('sends a small glossary whole — filtering it would risk a term for no saving', () => {
    const glossary = [term(0), term(1)]

    expect(selectGlossary(glossary, 'nothing relevant here')).toEqual(glossary)
  })

  it('cuts a large glossary down to the terms the batch actually contains', () => {
    const glossary = many(120)
    const kept = selectGlossary(glossary, 'Etching uses alpha7 as a mask.')

    expect(kept.map((entry) => entry.sourceTerm)).toEqual(['alpha7'])
  })

  it('returns the survivors in document order, however the batch orders them', () => {
    const glossary = many(120)
    const kept = selectGlossary(glossary, 'alpha5 and alpha3 and alpha9 appear here.')

    expect(kept.map((entry) => entry.sourceTerm)).toEqual(['alpha3', 'alpha5', 'alpha9'])
  })

  it('matches case-insensitively and through inflected forms', () => {
    const glossary = many(120)
    const kept = selectGlossary(glossary, 'The ALPHA11 mask; alpha12s were etched.')

    expect(kept.map((entry) => entry.sourceTerm)).toEqual(['alpha11', 'alpha12'])
  })

  it('does not mistake a shorter term for a prefix of a longer one', () => {
    const glossary = many(120)
    const kept = selectGlossary(glossary, 'Only alpha11 appears in this line.')

    // `alpha1` is a substring of `alpha11`; keeping it would mean a full
    // glossary matches every batch and the filter saves nothing.
    expect(kept.map((entry) => entry.sourceTerm)).toEqual(['alpha11'])
  })

  it('tests terms in a script written without spaces by substring alone', () => {
    const stem = 'စကားလုံး'
    const before = '၎င်း'
    const after = 'ကို သုံးသည်'
    const burmese: GlossarySpec[] = many(120).map((entry, index) => ({
      sourceTerm: `${stem}${index}`,
      targetTerm: entry.targetTerm,
      caseSensitive: false,
    }))
    // Burmese has no word spaces, so a boundary test would reject every term.
    const kept = selectGlossary(burmese, `${before}${stem}7${after}`)

    expect(kept.map((entry) => entry.sourceTerm)).toEqual([`${stem}7`])
  })
  it('drops everything when the batch names no term', () => {
    expect(selectGlossary(many(120), 'A page about something else entirely.')).toEqual([])
  })

  it('honours the token ceiling instead of sending every match', () => {
    const glossary = many(120)
    const text = Array.from({ length: 40 }, (_, index) => `alpha${index}`).join(' ')

    const kept = selectGlossary(glossary, text, 60)

    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(40)
  })

  it('saves most of the prompt once a real glossary exists', () => {
    const glossary = many(200)
    const whole = estimateTokens(
      systemPrompt({
        sourceLang: 'English',
        targetLang: 'Myanmar',
        quality: 'medium',
        terminologyScope: 'document',
        glossary,
      }),
    )
    const trimmed = estimateTokens(
      systemPrompt({
        sourceLang: 'English',
        targetLang: 'Myanmar',
        quality: 'medium',
        terminologyScope: 'document',
        glossary: selectGlossary(glossary, 'Only alpha3 matters here.'),
      }),
    )

    expect(trimmed).toBeLessThan(whole / 3)
  })
})
