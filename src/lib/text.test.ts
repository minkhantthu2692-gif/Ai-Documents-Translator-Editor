import { describe, expect, it } from 'vitest'
import {
  containsCjk,
  containsMyanmar,
  containsRtl,
  directionOf,
  minLineHeight,
  normalizeForSearch,
  normalizeWhitespace,
  scriptClasses,
  stripInvisible,
} from './text'

describe('direction', () => {
  it('detects Hebrew and Arabic runs', () => {
    expect(containsRtl('שלום עולם')).toBe(true)
    expect(containsRtl('مرحبا بالعالم')).toBe(true)
    expect(containsRtl('hello world')).toBe(false)
    expect(containsRtl('မြန်မာစာ')).toBe(false)
  })

  it('resolves the direction from the first strong character', () => {
    expect(directionOf('hello שלום')).toBe('ltr')
    expect(directionOf('שלום hello')).toBe('rtl')
    expect(directionOf('1234')).toBe('ltr')
    expect(directionOf('')).toBe('ltr')
    expect(directionOf('မြန်မာ')).toBe('ltr')
  })
})

describe('script classes', () => {
  it('recognises CJK', () => {
    expect(containsCjk('日本語のテキスト')).toBe(true)
    expect(containsCjk('中文文本')).toBe(true)
    expect(containsCjk('한국어')).toBe(true)
    expect(containsCjk('myanmar text')).toBe(false)
  })

  it('recognises Myanmar script', () => {
    expect(containsMyanmar('မြန်မာစာ')).toBe(true)
    expect(containsMyanmar('ABC')).toBe(false)
  })

  it('reports every class present', () => {
    expect(scriptClasses('အောက်ပါ စာသား')).toEqual({ rtl: false, cjk: false, myanmar: true })
  })

  it('enforces the Myanmar line-height floor', () => {
    expect(minLineHeight('မြန်မာစာ')).toBeGreaterThanOrEqual(1.7)
    expect(minLineHeight('latin')).toBeLessThan(1.7)
  })
})

describe('normalisation', () => {
  it('collapses whitespace', () => {
    expect(normalizeWhitespace('  a \n\t b  ')).toBe('a b')
  })

  it('folds case and accents for search', () => {
    expect(normalizeForSearch('Café  LATTE')).toBe('cafe latte')
    expect(normalizeForSearch('CAFÉ latte')).toBe(normalizeForSearch('cafe latte'))
  })

  it('removes invisible characters', () => {
    expect(stripInvisible('a​b﻿c')).toBe('abc')
  })
})
