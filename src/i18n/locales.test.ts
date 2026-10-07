import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import my from './locales/my.json'

type JsonNode = string | number | boolean | null | JsonNode[] | { [key: string]: JsonNode }

function collectPaths(node: JsonNode, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => collectPaths(entry, `${prefix}[${index}]`))
  }
  return Object.entries(node).flatMap(([key, value]) =>
    collectPaths(value, prefix ? `${prefix}.${key}` : key),
  )
}

function readPath(node: JsonNode, path: string): JsonNode {
  return path.split('.').reduce<JsonNode>((current, key) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null
    return current[key] ?? null
  }, node)
}

function collectStrings(node: JsonNode, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]]
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => collectStrings(entry, `${prefix}[${index}]`))
  }
  return Object.entries(node).flatMap(([key, value]) =>
    collectStrings(value, prefix ? `${prefix}.${key}` : key),
  )
}

describe('i18n resources', () => {
  const enPaths = collectPaths(en as JsonNode).sort()
  const myPaths = collectPaths(my as JsonNode).sort()

  it('exposes exactly the same keys in English and Burmese', () => {
    const missingInMy = enPaths.filter((path) => !myPaths.includes(path))
    const missingInEn = myPaths.filter((path) => !enPaths.includes(path))
    expect(missingInMy).toEqual([])
    expect(missingInEn).toEqual([])
  })

  it('has no empty translations', () => {
    for (const [path, value] of collectStrings(en as JsonNode)) {
      expect(value.trim().length, `en.${path}`).toBeGreaterThan(0)
    }
    for (const [path, value] of collectStrings(my as JsonNode)) {
      expect(value.trim().length, `my.${path}`).toBeGreaterThan(0)
    }
  })

  it('keeps interpolation placeholders aligned between languages', () => {
    const placeholders = (value: string) =>
      (value.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((entry) => entry.replace(/\s+/g, '')).sort()

    for (const path of enPaths) {
      const enValue = readPath(en as JsonNode, path)
      const myValue = readPath(my as JsonNode, path)
      if (typeof enValue !== 'string' || typeof myValue !== 'string') continue
      expect(placeholders(myValue), path).toEqual(placeholders(enValue))
    }
  })

  it('includes Burmese script in every Burmese message-style string', () => {
    // Keys whose values are proper nouns, brand names or units may stay Latin.
    const allowedLatin = /^(common\.(kB|mB|gB)|settings\.data\.appsScriptUrl|nav\.language)/
    const myanmarRange = /[\u1000-\u109F]/
    for (const [path, value] of collectStrings(my as JsonNode)) {
      if (allowedLatin.test(path)) continue
      if (value.length < 3) continue
      expect(myanmarRange.test(value) || /[A-Za-z]/.test(value), path).toBe(true)
    }
  })
})
