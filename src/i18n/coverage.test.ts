// @vitest-environment node

/**
 * i18n coverage: every *static* translation key referenced by the source must
 * exist in both locales. `locales.test.ts` proves the two files agree with
 * each other; this one proves they agree with the code — a missing key would
 * silently render its raw dotted path in the UI.
 *
 * Dynamic keys (`t(\`editor.view.${view}\`)`) are listed by the test below and
 * checked against the closed set of values each call site can produce.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import my from './locales/my.json'

type JsonObject = Record<string, unknown>

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function hasStringPath(node: unknown, path: string): boolean {
  let current: unknown = node
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return false
    current = (current as JsonObject)[part]
  }
  return typeof current === 'string'
}

const SRC = fileURLToPath(new URL('..', import.meta.url))
const KEY_PATTERNS = [
  /\bt\(\s*'([a-zA-Z0-9_.-]+)'/g,
  /\bi18n\.t\(\s*'([a-zA-Z0-9_.-]+)'/g,
  /\blabelKey:\s*'([a-zA-Z0-9_.-]+)'/g,
  /\btitleKey:\s*'([a-zA-Z0-9_.-]+)'/g,
]

/** Closed sets behind the `` t(`…${x}`) `` call sites of the editor/export UI. */
const DYNAMIC_KEYS: Record<string, string[]> = {
  'editor.action': [
    'edit-text',
    'edit-style',
    'find-replace',
    'retranslate',
    'suggest',
    'accept-suggestion',
    'reject-suggestion',
    'lock',
    'unlock',
    'autofit',
    'restore',
    'template',
  ],
  'editor.view': ['split', 'original', 'translated'],
  'editor.scope': ['block', 'page', 'document'],
  'editor.align': ['left', 'center', 'right', 'justified'],
  'editor.busy': ['retranslate', 'apply-style', 'find', 'template', 'autosave'],
  'export.format': [
    'pdf',
    'pdf-raster',
    'bilingual-pdf',
    'docx',
    'html',
    'markdown',
    'text',
    'epub',
    'json',
    'csv',
    'tsv',
    'images',
  ],
  'export.group': ['pdf', 'documents', 'data', 'images'],
  'export.stage': ['collect', 'render', 'build', 'package', 'write'],
  'export.bilingual': ['side-by-side', 'interleaved'],
  'export.imageFormat': ['png', 'jpg'],
}

describe('i18n coverage', () => {
  const files = walk(SRC)
  const missing: { key: string; locale: 'en' | 'my'; file: string }[] = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const found = new Set<string>()
    for (const pattern of KEY_PATTERNS) {
      for (const match of source.matchAll(pattern)) found.add(match[1])
    }
    for (const key of found) {
      if (!hasStringPath(en, key)) missing.push({ key, locale: 'en', file })
      if (!hasStringPath(my, key)) missing.push({ key, locale: 'my', file })
    }
  }

  it(`finds translation keys in ${files.length} source files`, () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('every statically referenced key exists in both locales', () => {
    const report = missing.map((entry) => `${entry.locale}: ${entry.key} (${entry.file})`).sort()
    expect(report).toEqual([])
  })

  it('every dynamic key resolves for its closed value set', () => {
    const report: string[] = []
    for (const [prefix, values] of Object.entries(DYNAMIC_KEYS)) {
      for (const value of values) {
        const key = `${prefix}.${value}`
        if (!hasStringPath(en, key)) report.push(`en: ${key}`)
        if (!hasStringPath(my, key)) report.push(`my: ${key}`)
      }
    }
    expect(report).toEqual([])
  })
})
