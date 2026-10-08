/**
 * Terminology post-processor: annotation format, occurrence scope, glossary
 * enforcement and the "keep the original" fallback.
 */
import { describe, expect, it } from 'vitest'
import { ensureUnicode, isLikelyZawgyi } from '@/core/zawgyi'
import {
  annotatedTerms,
  enforceGlossary,
  extractTermPairs,
  keepOriginalWhenUnusable,
  normalizeBrackets,
  normalizeTerminology,
  postProcessTranslation,
  type NormalizeOptions,
} from './terminology'
import type { GlossarySpec, TerminologyScope } from './types'

function options(
  scope: TerminologyScope,
  sourceText: string,
  seenPage = new Set<string>(),
  seenDocument = new Set<string>(),
): NormalizeOptions {
  return { scope, seenPage, seenDocument, sourceText }
}

describe('annotation format', () => {
  it('writes TranslatedTerm(OriginalTerm) with ASCII parens and no space: ပန်းသီး(apple)', () => {
    const result = normalizeTerminology(
      'ပန်းသီး (apple)',
      options('every', 'Apple pie is my favourite'),
    )
    expect(result.text).toBe('ပန်းသီး(apple)')
    expect(result.kept).toEqual(['apple'])
    expect(result.removed).toEqual([])
    expect(result.text).not.toMatch(/\s\(/)
  })

  it('normalises full-width brackets to ASCII', () => {
    expect(normalizeBrackets('ပန်းသီး（apple）')).toBe('ပန်းသီး(apple)')
    expect(normalizeBrackets('value［ok］')).toBe('value[ok]')

    const result = normalizeTerminology('ပန်းသီး（apple）', options('every', 'apple pie'))
    expect(result.text).toBe('ပန်းသီး(apple)')
  })

  it('leaves parentheticals that are not source terms alone', () => {
    const result = normalizeTerminology('hello (again) world', options('every', 'hello world'))
    expect(result.text).toBe('hello (again) world')
    expect(result.kept).toEqual([])
  })

  it('never strips an annotation that has nothing in front of it', () => {
    const result = normalizeTerminology('(apple) pie', options('every', 'apple pie'))
    expect(result.text).toBe('(apple) pie')
  })
})

describe('occurrence scope', () => {
  const LINE_1 = 'ပန်းသီး (apple) ကို စားသည်'
  const LINE_2 = 'နောက်တစ်လုံး ပန်းသီး (apple) ကျန်သည်'
  const SOURCE = 'eat an apple and one apple remains'

  it('scope "first" annotates once per page and repeats on the next page', () => {
    const seenPage = new Set<string>()
    const seenDocument = new Set<string>()

    const first = normalizeTerminology(LINE_1, options('first', SOURCE, seenPage, seenDocument))
    const second = normalizeTerminology(LINE_2, options('first', SOURCE, seenPage, seenDocument))
    expect(first.text).toContain('ပန်းသီး(apple)')
    expect(second.text).toBe('နောက်တစ်လုံး ပန်းသီး ကျန်သည်')
    expect(second.removed).toEqual(['apple'])

    // A new page gets its own set → the annotation comes back.
    const nextPage = normalizeTerminology(
      LINE_2,
      options('first', SOURCE, new Set<string>(), seenDocument),
    )
    expect(nextPage.text).toContain('ပန်းသီး(apple)')
  })

  it('scope "document" annotates only the first occurrence in the whole document', () => {
    const seenDocument = new Set<string>()

    const first = normalizeTerminology(LINE_1, options('document', SOURCE, new Set(), seenDocument))
    expect(first.text).toContain('ပန်းသီး(apple)')
    expect([...seenDocument]).toEqual(['apple'])

    // Fresh seenPage, same document: still suppressed — seenDocument decides.
    const second = normalizeTerminology(
      LINE_2,
      options('document', SOURCE, new Set(), seenDocument),
    )
    expect(second.text).toBe('နောက်တစ်လုံး ပန်းသီး ကျန်သည်')
    expect(second.kept).toEqual([])
    expect(second.removed).toEqual(['apple'])
  })

  it('scope "every" annotates every occurrence', () => {
    const seenPage = new Set<string>()
    const seenDocument = new Set<string>()
    const both = `${LINE_1}၊ ${LINE_2}`

    const result = normalizeTerminology(both, options('every', SOURCE, seenPage, seenDocument))
    expect(result.text.match(/ပန်းသီး\(apple\)/g)).toHaveLength(2)
    expect(result.kept).toEqual(['apple', 'apple'])
    expect(result.removed).toEqual([])
  })
})

describe('glossary enforcement', () => {
  const glossary: GlossarySpec[] = [
    { sourceTerm: 'submit', targetTerm: 'တင်သွင်းရန်', caseSensitive: false },
  ]

  it('repairs a source term that leaked through untranslated', () => {
    const outcome = enforceGlossary(
      'Click submit to continue',
      'ဆက်လက် လုပ်ရန် submit ကို နှိပ်ပါ',
      glossary,
    )
    expect(outcome.text).toBe('ဆက်လက် လုပ်ရန် တင်သွင်းရန် ကို နှိပ်ပါ')
    expect(outcome.fixes).toEqual(['submit'])
    expect(outcome.misses).toEqual([])
  })

  it('accepts a translation that already carries the required target term', () => {
    const outcome = enforceGlossary(
      'Click submit to continue',
      'ဆက်လက် တင်သွင်းရန် နှိပ်ပါ',
      glossary,
    )
    expect(outcome.text).toBe('ဆက်လက် တင်သွင်းရန် နှိပ်ပါ')
    expect(outcome.fixes).toEqual([])
    expect(outcome.misses).toEqual([])
  })

  it('reports a mismatch as a miss when neither target nor source term is present', () => {
    const entry: GlossarySpec[] = [
      { sourceTerm: 'API key', targetTerm: 'API သော့', caseSensitive: false },
    ]
    const outcome = enforceGlossary('Store the API key safely', 'စကားဝှက်ကို သိမ်းပါ', entry)
    expect(outcome.misses).toEqual(['API key'])
    expect(outcome.fixes).toEqual([])
    expect(outcome.text).toBe('စကားဝှက်ကို သိမ်းပါ')
  })

  it('ignores glossary entries whose source term is not in the source line', () => {
    const outcome = enforceGlossary('Nothing to see here', 'ဘာမှ မရှိပါ', glossary)
    expect(outcome.misses).toEqual([])
    expect(outcome.fixes).toEqual([])
  })
})

describe('keepOriginalWhenUnusable', () => {
  it('keeps the source when the translation is empty', () => {
    const source = 'A long source sentence that must survive.'
    const outcome = keepOriginalWhenUnusable(source, '   ')
    expect(outcome).toEqual({ text: source, replaced: true })
  })

  it('keeps the source when the translation carries no readable content', () => {
    const source = 'A long source sentence that must survive.'
    const outcome = keepOriginalWhenUnusable(source, '1234567890123')
    expect(outcome).toEqual({ text: source, replaced: true })
  })

  it('keeps a usable translation as-is', () => {
    const outcome = keepOriginalWhenUnusable('Hello there', 'မင်္ဂလာပါ')
    expect(outcome).toEqual({ text: 'မင်္ဂလာပါ', replaced: false })
  })
})

describe('postProcessTranslation', () => {
  it('normalises, enforces and flags in one pass', () => {
    const seenPage = new Set<string>()
    const seenDocument = new Set<string>()
    const outcome = postProcessTranslation(
      'Store the apple',
      'ပန်းသီး (apple) ကို သိမ်းပါ',
      [],
      options('every', 'Store the apple', seenPage, seenDocument),
    )
    expect(outcome.text).toBe('ပန်းသီး(apple) ကို သိမ်းပါ')
    expect(outcome.keptOriginal).toBe(false)
    expect(outcome.glossaryMisses).toEqual([])
    expect(outcome.glossaryFixes).toEqual([])
  })

  it('falls back to the original text when the translation is unusable', () => {
    const source = 'Store the apple in a cool place'
    const outcome = postProcessTranslation(
      source,
      '',
      [],
      options('first', source, new Set(), new Set()),
    )
    expect(outcome.text).toBe(source)
    expect(outcome.keptOriginal).toBe(true)
  })

  it('never produces Zawgyi — the post-processed output is Unicode-safe', () => {
    const source = 'Store the apple'
    const outcome = postProcessTranslation(
      source,
      'ပန်းသီး (apple) ကို သိမ်းပါ',
      [],
      options('every', source, new Set(), new Set()),
    )

    expect(outcome.text).toContain('ပန်းသီး(apple)')
    expect(isLikelyZawgyi(outcome.text)).toBe(false)
    const repair = ensureUnicode(outcome.text)
    expect(repair.wasZawgyi).toBe(false)
    expect(repair.converted).toBe(false)
    expect(repair.text).toBe(outcome.text)
  })
})

describe('annotatedTerms (what a restored run re-seeds)', () => {
  it('returns the lowercased keys already annotated in a translated line', () => {
    const source = 'Apple pie and Orange juice'
    const text = 'ပန်းသီး(Apple) ပိုနှင့် လိမ္မော်(Orange) ဖျော်ရည်'

    expect(annotatedTerms(text, source)).toEqual(['apple', 'orange'])
  })

  it('ignores a parenthetical whose inner text is not in the source', () => {
    expect(annotatedTerms('ကွန်ပျူတာ(computer)', 'Apple pie')).toEqual([])
  })

  it('needs a source line — without one there is nothing to verify against', () => {
    expect(annotatedTerms('ပန်းသီး(apple)')).toEqual([])
    expect(annotatedTerms('', 'apple pie')).toEqual([])
  })

  it('de-duplicates a term annotated twice on the same line', () => {
    const text = 'ပန်းသီး(apple) နှင့် ပန်းသီး(apple) တူညီသည်'

    expect(annotatedTerms(text, 'apple and apple again')).toEqual(['apple'])
  })
})

describe('extractTermPairs (what the rolling glossary learns)', () => {
  it('reads Translated(Original) as a target→source pair', () => {
    const pairs = extractTermPairs('သော့(key) ကို သိမ်းပါ', 'Store the key')

    expect(pairs).toEqual([{ sourceTerm: 'key', targetTerm: 'သော့' }])
  })

  it('never learns from a parenthetical the source does not contain', () => {
    expect(extractTermPairs('ကွန်ပျူတာ(computer)', 'Store the key')).toEqual([])
  })

  it('keeps the first target chosen for a term annotated twice', () => {
    const pairs = extractTermPairs('သော့(key) နှင့် သော့(key)', 'key and key')

    expect(pairs).toHaveLength(1)
    expect(pairs[0].sourceTerm).toBe('key')
  })

  it('finds no pairs in an unannotated line', () => {
    expect(extractTermPairs('သော့ ကို သိမ်းပါ', 'Store the key')).toEqual([])
  })
})
