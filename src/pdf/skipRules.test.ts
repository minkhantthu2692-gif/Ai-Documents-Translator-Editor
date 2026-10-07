import { describe, expect, it } from 'vitest'
import { classifyLine, shouldTranslate, summarizeSkips } from './skipRules'

const ctx = { sourceLang: 'en', targetLang: 'my' }

describe('classifyLine', () => {
  it('keeps ordinary prose', () => {
    const decision = classifyLine('The quick brown fox jumps over the lazy dog.', ctx)
    expect(decision.skip).toBe(false)
    expect(decision.rule).toBeNull()
    expect(shouldTranslate('Translate me', ctx)).toBe(true)
  })

  it('flags empty and whitespace-only lines', () => {
    expect(classifyLine('', ctx).rule).toBe('empty')
    expect(classifyLine('   \t ', ctx).rule).toBe('whitespace')
  })

  it('skips numbers, page labels and roman numerals', () => {
    expect(classifyLine('12,345.67', ctx)).toMatchObject({ skip: true, rule: 'number' })
    expect(classifyLine('2024', ctx)).toMatchObject({ skip: true, rule: 'number' })
    expect(classifyLine('Page 12', ctx)).toMatchObject({ skip: true, rule: 'number' })
    expect(classifyLine('iv', ctx)).toMatchObject({ skip: true, rule: 'number' })
    expect(classifyLine('စာမျက်နှာ ၅', ctx)).toMatchObject({ skip: true, rule: 'number' })
    expect(classifyLine('-  7 -', ctx)).toMatchObject({ skip: true, rule: 'number' })
  })

  it('skips URLs and e-mail addresses', () => {
    expect(classifyLine('https://example.com/a?b=1', ctx)).toMatchObject({
      skip: true,
      rule: 'url',
    })
    expect(classifyLine('visit www.example.com now', ctx)).toMatchObject({
      skip: true,
      rule: 'url',
    })
    expect(classifyLine('support@example.com', ctx)).toMatchObject({ skip: true, rule: 'email' })
  })

  it('skips code fragments', () => {
    expect(classifyLine('const total = sum(items);', ctx)).toMatchObject({
      skip: true,
      rule: 'code',
    })
    expect(classifyLine('SELECT id FROM users WHERE active = 1;', ctx)).toMatchObject({
      skip: true,
      rule: 'code',
    })
    // Prose that merely contains keywords must survive.
    expect(classifyLine('a new class of users joined', ctx).skip).toBe(false)
    expect(classifyLine('We return to that chapter', ctx).skip).toBe(false)
  })

  it('skips formulas but not prose containing an equals sign', () => {
    expect(classifyLine('E=mc²', ctx)).toMatchObject({ skip: true, rule: 'formula' })
    expect(classifyLine('x + y = 12', ctx)).toMatchObject({ skip: true, rule: 'formula' })
    expect(classifyLine('Use E=mc^2 for the estimate', ctx)).toMatchObject({
      skip: true,
      rule: 'formula',
    })
    expect(classifyLine('This equals that is a matter of opinion.', ctx)).toMatchObject({
      skip: false,
      rule: null,
    })
  })

  it('skips symbol-only rows', () => {
    expect(classifyLine('••• •••', ctx)).toMatchObject({ skip: true, rule: 'punctuation' })
    expect(classifyLine('---', ctx)).toMatchObject({ skip: true, rule: 'number' })
  })

  it('skips text already written in the target language', () => {
    expect(classifyLine('မြန်မာနိုင်ငံ ဒီမိုကရေစီ', ctx)).toMatchObject({
      skip: true,
      rule: 'alreadyTarget',
    })
    expect(classifyLine('မြန်မာနိုင်ငံ ဒီမိုကရေစီ', { ...ctx, targetLang: 'en' })).toMatchObject({
      skip: false,
      rule: null,
    })
  })

  it('does not treat English prose as a number or code', () => {
    expect(classifyLine('Chapter 3 introduces the topic.', ctx).skip).toBe(false)
    expect(classifyLine('Version 2.0 released', ctx).skip).toBe(false)
  })
})

describe('summarizeSkips', () => {
  it('counts each rule', () => {
    const summary = summarizeSkips(
      ['12', 'https://x.test', 'Hello world', 'Hello world', 'E=mc²'],
      ctx,
    )
    expect(summary.number).toBe(1)
    expect(summary.url).toBe(1)
    expect(summary.formula).toBe(1)
    expect(summary.translatable ?? 0).toBe(0)
  })
})
