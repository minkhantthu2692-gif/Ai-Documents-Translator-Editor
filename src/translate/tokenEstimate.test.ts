/**
 * Token estimation: script weights, ASCII parity and runtime calibration.
 *
 * The estimator is the number the whole pipeline trusts — batch budgets, the
 * key pool's TPM bucket and the completion cap all read it — so both
 * directions of error are pinned here: it must not under-count Burmese (that
 * is what produced the 429 storms and the truncated-JSON death spiral), and it
 * must not change a single value for Latin text (that would churn every batch
 * boundary in the app for no reason).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASCII_CHARS_PER_TOKEN,
  baseTokenEstimate,
  estimateTokens,
  recordTokenCalibration,
  resetTokenScale,
  SCRIPT_WEIGHTS,
  tokenSamples,
  tokenScale,
} from './tokenEstimate'

afterEach(() => resetTokenScale())

/** Sample strings, one per script the pipeline actually meets. */
const SAMPLE = {
  english: 'The quick brown fox jumps over the lazy dog and keeps running.',
  myanmar: 'မြန်မာနိုင်ငံသည် အရှေ့တောင်အာရှတွင် တည်ရှိပြီး လူဦးရေ သန်း ၅၀ ကျော်ရှိသည်။',
  thai: 'ภาษาไทยเป็นภาษาราชการของประเทศไทยและใช้อักษรไทยในการเขียน',
  devanagari: 'हिन्दी भारत की राजभाषा है और देवनागरी लिपि में लिखी जाती है।',
  arabic: 'العربية هي إحدى أكثر اللغات انتشاراً في العالم ويتحدث بها الملايين',
  cjk: '文档翻译系统需要处理大量文本并保持原有排版结构不被破坏。',
  korean: '문서 번역 시스템은 대량의 텍스트를 처리하고 원래의 구조를 유지해야 합니다.',
  cyrillic: 'Система перевода документов должна обрабатывать большие объёмы текста.',
} as const

describe('estimateTokens — Latin parity', () => {
  it('is still exactly ceil(length / 3) for pure ASCII', () => {
    for (let length = 1; length <= 300; length += 1) {
      expect(estimateTokens('a'.repeat(length))).toBe(
        Math.max(1, Math.ceil(length / ASCII_CHARS_PER_TOKEN)),
      )
    }
  })

  it('returns 1 for the empty string', () => {
    expect(estimateTokens('')).toBe(1)
  })

  it('reproduces the historical hand-computed values', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('123456')).toBe(2)
    expect(estimateTokens('1234567')).toBe(3)
    expect(estimateTokens('hello world')).toBe(4)
  })
})

describe('estimateTokens — scripts', () => {
  it('charges Burmese several times what the same length of English costs', () => {
    const english = estimateTokens(SAMPLE.english)
    const myanmar = estimateTokens(SAMPLE.myanmar)

    // Comparable length, very different cost: the Myanmar string is barely
    // longer but carries several times the tokens. (It also holds five ASCII
    // spaces, which are still priced at 1/3 a token.)
    expect(SAMPLE.myanmar.length - SAMPLE.english.length).toBeLessThan(20)
    expect(myanmar).toBeGreaterThan(english * 3)

    const burmeseChars = [...SAMPLE.myanmar].filter(
      (character) => character.charCodeAt(0) >= 0x80,
    ).length
    expect(myanmar).toBeGreaterThanOrEqual(burmeseChars * SCRIPT_WEIGHTS.myanmar)
  })

  it('weights every script the document pipeline meets', () => {
    for (const [name, text] of Object.entries(SAMPLE)) {
      const estimate = baseTokenEstimate(text)
      expect(estimate, name).toBeGreaterThan(0)
      expect(estimateTokens(text), name).toBeGreaterThanOrEqual(1)
    }
  })

  it('sums mixed-script text per character', () => {
    const pure = baseTokenEstimate(SAMPLE.myanmar)
    const mixed = baseTokenEstimate(`abc${SAMPLE.myanmar}`)

    expect(mixed - pure).toBeCloseTo(3 / ASCII_CHARS_PER_TOKEN, 6)
  })

  it('counts a combining mark on its own weight', () => {
    // "é" as e + combining acute: ASCII 1/3 plus the mark's weight.
    expect(baseTokenEstimate('e\u0301')).toBeCloseTo(1 / 3 + SCRIPT_WEIGHTS.combiningMark, 6)
  })

  it('does not lose a whole character to the unknown bucket', () => {
    const rare = baseTokenEstimate('\u2c00') // Glagolitic, deliberately unmapped
    expect(rare).toBe(SCRIPT_WEIGHTS.unknown)
  })
})

describe('recordTokenCalibration', () => {
  it('moves toward the observed ratio and stabilises there', () => {
    // The provider really charges 2× what we predict. `predicted` is the
    // estimator's own view of the request, so it grows with the scale — the
    // way it does in `engine.ts`.
    const base = 1_000
    const actual = 2_000
    let scale = 1
    for (let sample = 0; sample < 60; sample += 1) {
      scale = recordTokenCalibration(base * scale, actual)
    }

    expect(scale).toBeCloseTo(2, 2)
    // Stable: another identical reading no longer moves it.
    const before = recordTokenCalibration(base * scale, actual)
    expect(Math.abs(before - scale)).toBeLessThan(0.01)
  })

  it('applies the correction to estimateTokens', () => {
    const text = 'x'.repeat(300) // 100 tokens
    expect(estimateTokens(text)).toBe(100)

    for (let sample = 0; sample < 60; sample += 1) {
      recordTokenCalibration(estimateTokens(text), 400)
    }
    expect(estimateTokens(text)).toBe(400)
  })

  it('ignores providers that reported no usage', () => {
    expect(recordTokenCalibration(100, 0)).toBe(1)
    expect(recordTokenCalibration(0, 100)).toBe(1)
    expect(recordTokenCalibration(Number.NaN, 100)).toBe(1)
    expect(tokenScale()).toBe(1)
    expect(tokenSamples()).toBe(0)
  })

  it('clamps a wild sample instead of trusting it', () => {
    // A single reading claiming a 10 000× error must not become a 10 000×
    // scale. Moving *up* is the safe direction (batches shrink), so it is
    // allowed immediately — but only within the documented bound.
    recordTokenCalibration(100, 1_000_000)
    expect(tokenScale()).toBeGreaterThan(1)
    expect(tokenScale()).toBeLessThanOrEqual(4)
  })

  it('needs several samples before it will shrink the estimate', () => {
    for (let sample = 0; sample < 4; sample += 1) recordTokenCalibration(1_000, 10)
    expect(tokenScale()).toBe(1)

    for (let sample = 0; sample < 40; sample += 1) recordTokenCalibration(1_000, 10)
    expect(tokenScale()).toBeGreaterThanOrEqual(0.6)
    expect(tokenScale()).toBeLessThan(1)
  })

  it('never runs away past the documented bounds', () => {
    for (let sample = 0; sample < 200; sample += 1) recordTokenCalibration(1, 1_000_000)
    expect(tokenScale()).toBeLessThanOrEqual(4)

    resetTokenScale()
    for (let sample = 0; sample < 400; sample += 1) recordTokenCalibration(1_000_000, 1)
    expect(tokenScale()).toBeGreaterThanOrEqual(0.6)
  })

  it('resetTokenScale puts the static weights back', () => {
    for (let sample = 0; sample < 60; sample += 1) recordTokenCalibration(100, 300)
    expect(tokenScale()).not.toBe(1)

    resetTokenScale()
    expect(tokenScale()).toBe(1)
    expect(tokenSamples()).toBe(0)
    expect(estimateTokens('a'.repeat(300))).toBe(100)
  })
})
