import { describe, expect, it } from 'vitest'
import { containsTerm, termIsHonoured, violationsForBlock, type GlossaryTerm } from './validate'

const term: GlossaryTerm = {
  sourceTerm: 'torque',
  targetTerm: 'တာယာအား',
  caseSensitive: false,
}

const myanmarTerm: GlossaryTerm = {
  sourceTerm: 'စာရေးသားခြင်း',
  targetTerm: 'writing',
  caseSensitive: false,
}

function block(sourceText: string, translatedText: string, id = 'blk_1') {
  return { id, sourceText, translatedText }
}

describe('containsTerm', () => {
  it('matches case-insensitively by default', () => {
    expect(containsTerm('The Torque value', 'torque', false)).toBe(true)
    expect(containsTerm('The Torque value', 'torque', true)).toBe(false)
  })

  it('does not match inside a longer Latin word', () => {
    expect(containsTerm('smart device', 'art', false)).toBe(false)
    expect(containsTerm('an art class', 'art', false)).toBe(true)
  })

  it('matches Myanmar terms as plain substrings (no word spaces)', () => {
    expect(containsTerm('စာရေးသားခြင်း အကြောင်း', 'စာရေးသားခြင်း', false)).toBe(true)
    expect(containsTerm('စာရေးသားခြင်း', 'ရေးသား', false)).toBe(true)
  })

  it('rejects empty needles and text', () => {
    expect(containsTerm('anything', '  ', false)).toBe(false)
    expect(containsTerm('', 'torque', false)).toBe(false)
  })
})

describe('termIsHonoured', () => {
  it('accepts the prompt annotation Target(Source)', () => {
    expect(termIsHonoured('တာယာအား(torque) ပြောင်းလဲသည်', term)).toBe(true)
  })

  it('accepts the bare target term', () => {
    expect(termIsHonoured('တာယာအား မြင့်သည်', term)).toBe(true)
  })

  it('rejects a translation with neither', () => {
    expect(termIsHonoured('ဒီအချက် ပြောင်းလဲသည်', term)).toBe(false)
  })

  it('treats source === target as "keep as-is"', () => {
    const keep: GlossaryTerm = { sourceTerm: 'API', targetTerm: 'API', caseSensitive: false }
    expect(termIsHonoured('The API responds', keep)).toBe(true)
    expect(termIsHonoured('The interface responds', keep)).toBe(false)
  })
})

describe('violationsForBlock', () => {
  it('reports nothing when the source never uses the term', () => {
    expect(violationsForBlock(block('A plain sentence', 'ရိုးရှင်းသော ဝါကျ'), [term])).toEqual([])
  })

  it('reports nothing while the block is untranslated', () => {
    expect(violationsForBlock(block('The torque curve', ''), [term])).toEqual([])
  })

  it('flags a missing target term', () => {
    const violations = violationsForBlock(block('The torque curve rises', 'ဤအချက် မြင့်လာသည်'), [
      term,
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      blockId: 'blk_1',
      sourceTerm: 'torque',
      targetTerm: 'တာယာအား',
      kind: 'missing',
    })
  })

  it('flags a term left untranslated in the target', () => {
    const violations = violationsForBlock(
      block('The torque curve rises', 'The torque curve rises'),
      [term],
    )
    expect(violations[0].kind).toBe('untranslated')
  })

  it('accepts the annotated form', () => {
    expect(
      violationsForBlock(block('The torque curve', 'တာယာအား(torque) တန်ဖိုး'), [term]),
    ).toEqual([])
  })

  it('checks every applicable term and ignores the rest', () => {
    const other: GlossaryTerm = {
      sourceTerm: 'warranty',
      targetTerm: 'အာမခံ',
      caseSensitive: false,
    }
    const violations = violationsForBlock(
      block('Torque and warranty terms', 'တာယာအား စကားလုံးများ'),
      [term, myanmarTerm, other],
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].sourceTerm).toBe('warranty')
  })

  it('is case-sensitive only when the glossary asks for it', () => {
    const strict: GlossaryTerm = { sourceTerm: 'API', targetTerm: 'API', caseSensitive: true }
    // Case-sensitive: `api` in the source is a different word → not our term.
    expect(violationsForBlock(block('The api is down', 'စနစ် အောက်ကျသည်'), [strict])).toHaveLength(
      0,
    )
    // Exact match in the source but the term never reached the translation.
    expect(violationsForBlock(block('The API is down', 'စနစ် အောက်ကျသည်'), [strict])).toHaveLength(
      1,
    )
    expect(violationsForBlock(block('The API is down', 'API အောက်ကျသည်'), [strict])).toHaveLength(0)
  })
})
