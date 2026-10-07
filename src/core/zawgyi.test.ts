/**
 * Zawgyi detection + conversion tests.
 *
 * Fixtures are the upstream test vectors from Google's `myanmar-tools`
 * (Apache-2.0): `spec/zawgyi_converter_spec.js` (126 Zawgyi → Unicode pairs)
 * and `resources/compatibility.tsv` (50 samples with expected probabilities).
 * They are converted to JSON by scripts/fetch-zawgyi-fixtures.mjs.
 */

import { describe, expect, it } from 'vitest'
import { ensureUnicode, isLikelyZawgyi, zawgyiProbability, zawgyiToUnicode } from './zawgyi'
import pairs from '../test/fixtures/zawgyiPairs.json'
import compatibility from '../test/fixtures/zawgyiCompatibility.json'

describe('zawgyiToUnicode', () => {
  it('matches every upstream converter vector', () => {
    const failures: string[] = []
    for (const pair of pairs as Array<{ z: string; u: string }>) {
      const actual = zawgyiToUnicode(pair.z)
      if (actual !== pair.u) {
        failures.push(
          `z=${JSON.stringify(pair.z)} expected=${JSON.stringify(pair.u)} actual=${JSON.stringify(actual)}`,
        )
      }
    }
    expect(failures).toEqual([])
  })

  it('produces text that ensureUnicode then leaves untouched', () => {
    const sample = (pairs as Array<{ u: string }>)[10].u
    const once = zawgyiToUnicode(sample)
    const twice = ensureUnicode(once)
    expect(twice.converted).toBe(false)
    expect(twice.text).toBe(once)
    // The raw rule engine is only safe on real Zawgyi input — that is why
    // conversion is gated behind detection (ensureUnicode) everywhere.
  })

  it('leaves ASCII and digits untouched', () => {
    expect(zawgyiToUnicode('123 abc .!@|')).toBe('123 abc .!@|')
  })
})

describe('zawgyiProbability', () => {
  it('reproduces the upstream compatibility scores', () => {
    const failures: string[] = []
    for (const row of compatibility as Array<{ p: number | null; sample: string }>) {
      // JSON cannot encode -Infinity, so the fixture stores it as null.
      const expected = row.p === null ? Number.NEGATIVE_INFINITY : row.p
      const actual = zawgyiProbability(row.sample)
      if (expected === Number.NEGATIVE_INFINITY) {
        if (actual !== Number.NEGATIVE_INFINITY) {
          failures.push(`expected -Infinity for ${JSON.stringify(row.sample)}, got ${actual}`)
        }
        continue
      }
      const tolerance = Math.max(1e-4, Math.abs(expected) * 0.01)
      if (Math.abs(actual - expected) > tolerance) {
        failures.push(
          `expected ${expected} got ${actual} for ${JSON.stringify(row.sample.slice(0, 40))}`,
        )
      }
    }
    expect(failures).toEqual([])
  })

  it('classifies strong Zawgyi and strong Unicode samples', () => {
    const unicodeSample = (compatibility as Array<{ p: number; sample: string }>).find(
      (row) => row.p !== null && row.p < 0.001 && row.sample.length > 20,
    )
    const zawgyiSample = (compatibility as Array<{ p: number; sample: string }>).find(
      (row) => row.p !== null && row.p > 0.99 && row.sample.length > 20,
    )
    expect(unicodeSample).toBeDefined()
    expect(zawgyiSample).toBeDefined()
    expect(isLikelyZawgyi(unicodeSample!.sample)).toBe(false)
    expect(isLikelyZawgyi(zawgyiSample!.sample)).toBe(true)
  })

  it('returns -Infinity for text without Myanmar code points', () => {
    expect(zawgyiProbability('just latin text')).toBe(Number.NEGATIVE_INFINITY)
    expect(isLikelyZawgyi('just latin text')).toBe(false)
  })
})

describe('ensureUnicode', () => {
  it('converts Zawgyi input and flags the repair', () => {
    const zawgyiSample = (compatibility as Array<{ p: number; sample: string }>).find(
      (row) => row.p !== null && row.p > 0.99 && row.sample.length > 20,
    )!.sample
    const result = ensureUnicode(zawgyiSample)
    expect(result.wasZawgyi).toBe(true)
    expect(result.converted).toBe(true)
    expect(result.text).not.toBe(zawgyiSample)
    expect(isLikelyZawgyi(result.text)).toBe(false)
  })

  it('passes Unicode input through untouched', () => {
    const unicodeSample = (compatibility as Array<{ p: number; sample: string }>).find(
      (row) => row.p !== null && row.p < 0.001 && row.sample.length > 20,
    )!.sample
    const result = ensureUnicode(unicodeSample)
    expect(result.wasZawgyi).toBe(false)
    expect(result.converted).toBe(false)
    expect(result.text).toBe(unicodeSample)
  })

  it('never throws on empty or numeric input', () => {
    expect(ensureUnicode('').text).toBe('')
    expect(ensureUnicode('2024').converted).toBe(false)
  })
})
