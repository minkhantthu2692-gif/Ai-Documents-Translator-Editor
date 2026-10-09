/**
 * Guard for `apps-script/Code.gs` — the file is a Google Apps Script, not a
 * module this repo can import, so it gets no unit tests of its own. It is
 * still shipped to users by the Download Code.gs button, and one line of it
 * decides whether a translated document can write a formula into the user's
 * own Sheet. This test reads the source and holds that line in place.
 *
 * The invariant: Sheets parses a cell on the way *in*. `=IMPORTDATA("…")`
 * arriving as a block's first line would become a live formula that phones
 * home from the user's spreadsheet. Every write of request-derived data must
 * therefore go through `writePlain_`, which formats the range as Plain Text
 * before `setValues`. The only allowed raw writes are the header rows, whose
 * contents are literals defined at the top of the same file.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Vitest runs from the repo root; `import.meta.url` is an http URL here.
const source = readFileSync(join(process.cwd(), 'apps-script', 'Code.gs'), 'utf8')

/** Lines whose writes are constant header labels, not request data. */
const HEADER_WRITES = [
  'sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers.slice()])',
  'sh.getRange(1, 1, 1, cols).setValues([def.headers.slice()])',
  'sh.getRange(1, 1, 1, LOG_HEADERS_.length).setValues([LOG_HEADERS_.slice()])',
]

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} should exist in Code.gs`).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`${name} is not closed`)
}

describe('apps-script/Code.gs — formula injection', () => {
  it('formats a write destination as plain text before setValues', () => {
    const body = bodyOf('writePlain_')
    expect(body).toContain('setNumberFormat(PLAIN_TEXT_FMT_)')
    // The format must be applied to the same range, before the values land.
    expect(body.indexOf('setNumberFormat')).toBeLessThan(body.indexOf('setValues'))
  })

  it('leaves no raw setValues outside writePlain_ but the header rows', () => {
    // The one raw write allowed is inside writePlain_ itself — the helper
    // formats the range first, then hands off.
    const withoutHelper = source.replace(bodyOf('writePlain_'), '')

    const raw = withoutHelper
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(
        (entry) =>
          entry.line.includes('.setValues(') &&
          !entry.line.includes('function ') &&
          !entry.line.startsWith('*') &&
          !entry.line.startsWith('//'),
      )
      .filter((entry) => !HEADER_WRITES.includes(entry.line))

    expect(
      raw,
      'every data write must go through writePlain_ — a raw setValues can turn ' +
        '"=IMPORTDATA(...)" into a live formula in the user\'s Sheet',
    ).toEqual([])
  })

  it('routes both data paths through it', () => {
    // The two places request-derived values are written: sheet rows and the
    // SyncLog audit entry (whose `message` carries response text).
    expect(bodyOf('flushRun_')).toContain('writePlain_(')
    expect(bodyOf('writeSyncLog_')).toContain('writePlain_(')
  })

  it('keeps the apostrophe out of the sanitiser, so the round trip is exact', () => {
    // Prefixing with "'" is the textbook mitigation and it does not round-trip:
    // Sheets eats the marker on read, so a hyphen bullet would come back bare.
    const body = bodyOf('sanitizeCell_')
    expect(body).not.toContain(`"'" +`)
    expect(body).not.toContain(`+ "'"`)
    expect(body).not.toContain(`'\\''`)
  })
})
