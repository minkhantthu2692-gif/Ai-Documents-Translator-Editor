import { describe, expect, it } from 'vitest'
import {
  hasPlaceholders,
  looksLikeFormula,
  missingPlaceholders,
  restorePlaceholders,
  tokenizePlaceholders,
} from './placeholders'

describe('tokenizePlaceholders / restorePlaceholders', () => {
  it('protects inline maths with $ delimiters and restores it losslessly', () => {
    const source = 'Energy is E=mc^2 and pressure is P=f/A'
    const { text, placeholders } = tokenizePlaceholders(source)
    expect(text).toBe('Energy is {{0}} and pressure is {{1}}')
    expect(placeholders.map((p) => p.original)).toEqual(['E=mc^2', 'P=f/A'])
    expect(restorePlaceholders(text, placeholders)).toBe(source)
  })

  it('protects parenthesised formulas but not plain parentheses', () => {
    const source = 'see (x + y = 10) for details (see chapter 2)'
    const { text, placeholders } = tokenizePlaceholders(source)
    expect(text).toBe('see {{0}} for details (see chapter 2)')
    expect(restorePlaceholders(text, placeholders)).toBe(source)
  })

  it('leaves currency amounts alone', () => {
    const source = 'Costs are $5 and $6 each'
    const { text, placeholders } = tokenizePlaceholders(source)
    expect(text).toBe(source)
    expect(placeholders).toEqual([])
  })

  it('protects inline markup', () => {
    const source = 'Use **bold** and <b>tags</b> carefully'
    const { text, placeholders } = tokenizePlaceholders(source)
    expect(text).toBe('Use {{0}} and {{1}} carefully')
    expect(restorePlaceholders(text, placeholders)).toBe(source)
  })

  it('protects bare formulas inside a sentence', () => {
    const source = 'the result is 1 + 1 = 2 today'
    const { text, placeholders } = tokenizePlaceholders(source)
    expect(text).toBe('the result is {{0}} today')
    expect(placeholders[0].original).toBe('1 + 1 = 2')
    expect(restorePlaceholders(text, placeholders)).toBe(source)
  })

  it('keeps existing tokens verbatim so re-runs stay safe', () => {
    const source = 'value {{0}} stays put'
    const { text, placeholders } = tokenizePlaceholders(source)
    expect(text).toBe(source)
    expect(placeholders).toEqual([{ token: '{{0}}', kind: 'existing', original: '{{0}}' }])
    expect(restorePlaceholders(text, placeholders)).toBe(source)
  })

  it('survives a translation that rewrites whitespace around tokens', () => {
    const source = 'Compute E=mc^2 now'
    const { text, placeholders } = tokenizePlaceholders(source)
    const translated = text.replace('Compute', 'တွက်ပါ').replace(' now', ' ယခု')
    expect(restorePlaceholders(translated, placeholders)).toBe(
      'တွက်ပါ {{0}} ယခု'.replace('{{0}}', 'E=mc^2'),
    )
  })

  it('reports tokens the model dropped', () => {
    const { text, placeholders } = tokenizePlaceholders('a E=mc^2 b')
    expect(missingPlaceholders(text, placeholders)).toEqual([])
    expect(missingPlaceholders('a b', placeholders)).toEqual(['{{0}}'])
  })

  it('handles empty input and detects leftovers', () => {
    expect(tokenizePlaceholders('')).toEqual({ text: '', placeholders: [] })
    expect(hasPlaceholders('plain text')).toBe(false)
    expect(hasPlaceholders('has {{3}} token')).toBe(true)
    expect(restorePlaceholders('no tokens', [])).toBe('no tokens')
  })
})

describe('looksLikeFormula', () => {
  it('accepts real formulas and rejects prose', () => {
    expect(looksLikeFormula('x+y=12')).toBe(true)
    expect(looksLikeFormula('A1 = B2')).toBe(true)
    expect(looksLikeFormula('∑n²')).toBe(true)
    expect(looksLikeFormula('the quick brown fox')).toBe(false)
    expect(looksLikeFormula('')).toBe(false)
    expect(looksLikeFormula('2024')).toBe(false)
  })
})
