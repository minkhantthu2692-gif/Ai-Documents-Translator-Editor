/**
 * Prompt assembly: what context a batch is handed, and the guarantee that only
 * the numbered lines are ever translated.
 *
 * The context block is the whole of Layer 6's "heading chain" (the part that
 * costs tokens), so it is worth pinning exactly what leaves the machine.
 */
import { describe, expect, it } from 'vitest'
import { GLOSSARY_CAP, systemPrompt, userPrompt } from './prompts'
import type { BatchLine, PromptContext, TranslationBatch } from './types'

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
