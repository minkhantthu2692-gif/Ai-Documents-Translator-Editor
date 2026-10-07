/**
 * Regenerates the Zawgyi test fixtures from Google's `myanmar-tools` package.
 *
 *   node scripts/fetch-zawgyi-fixtures.mjs
 *
 * Reads (or downloads and extracts) myanmar-tools, then writes:
 *   src/test/fixtures/zawgyiPairs.json         — 126 Zawgyi → Unicode vectors
 *   src/test/fixtures/zawgyiCompatibility.json — 50 scored detection samples
 *
 * myanmar-tools is Copyright 2017 Google LLC, licensed under Apache-2.0.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const VERSION = '1.2.0'
const ROOT = resolve(import.meta.dirname, '..')
const FIXTURE_DIR = join(ROOT, 'src', 'test', 'fixtures')
const WORK = join(tmpdir(), 'aidt-myanmar-tools')

const tarball = join(WORK, `myanmar-tools-${VERSION}.tgz`)
const extracted = join(WORK, 'package')

mkdirSync(WORK, { recursive: true })
if (!existsSync(join(extracted, 'spec', 'zawgyi_converter_spec.js'))) {
  execFileSync(
    'curl',
    [
      '-L',
      '-o',
      tarball,
      `https://registry.npmjs.org/myanmar-tools/-/myanmar-tools-${VERSION}.tgz`,
    ],
    { stdio: 'inherit' },
  )
  execFileSync('tar', ['-xzf', tarball, '-C', WORK], { stdio: 'inherit' })
}

// 1) Converter vectors: `var zawygi_unicode_convert_data = [ ... ];`
const spec = readFileSync(join(extracted, 'spec', 'zawgyi_converter_spec.js'), 'utf8')
const marker = 'var zawygi_unicode_convert_data = '
const start = spec.indexOf(marker) + marker.length
const end = spec.indexOf('];', start) + 1
const pairs = eval(spec.slice(start, end))

// 2) Detector scores: `probability<TAB>sample` (JSON cannot encode -Infinity).
const tsv = readFileSync(join(extracted, 'resources', 'compatibility.tsv'), 'utf8')
const compatibility = tsv
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const tab = line.indexOf('\t')
    return { p: Number(line.slice(0, tab)), sample: line.slice(tab + 1) }
  })
  .filter((row) => !Number.isNaN(row.p))
  .map((row) => ({ p: row.p === Number.NEGATIVE_INFINITY ? null : row.p, sample: row.sample }))

mkdirSync(FIXTURE_DIR, { recursive: true })
writeFileSync(join(FIXTURE_DIR, 'zawgyiPairs.json'), JSON.stringify(pairs, null, 2), 'utf8')
writeFileSync(
  join(FIXTURE_DIR, 'zawgyiCompatibility.json'),
  JSON.stringify(compatibility, null, 2),
  'utf8',
)
console.log(`wrote ${pairs.length} converter vectors and ${compatibility.length} detector samples`)
