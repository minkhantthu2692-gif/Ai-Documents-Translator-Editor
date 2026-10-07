import { describe, expect, it } from 'vitest'
import {
  buildGlossaryCsv,
  detectDelimiter,
  duplicateRows,
  parseGlossaryCsv,
  splitDelimitedLine,
} from './glossaryCsv'

describe('splitDelimitedLine', () => {
  it('splits plain fields', () => {
    expect(splitDelimitedLine('a,b,c', ',')).toEqual(['a', 'b', 'c'])
  })

  it('keeps delimiters inside quotes and unescapes doubled quotes', () => {
    expect(splitDelimitedLine('"a,b","c ""d"""', ',')).toEqual(['a,b', 'c "d"'])
  })

  it('treats a quote in the middle of an unquoted value as data', () => {
    expect(splitDelimitedLine('c ""d""', ',')).toEqual(['c ""d""'])
  })

  it('ignores a quote that only appears after non-space text', () => {
    expect(splitDelimitedLine('  "quoted"', ',')).toEqual(['quoted'])
  })

  it('preserves an empty trailing field', () => {
    expect(splitDelimitedLine('a,', ',')).toEqual(['a', ''])
  })
})

describe('parseGlossaryCsv', () => {
  it('reads a header row with the usual column names', () => {
    const result = parseGlossaryCsv(
      'source,target,notes,case_sensitive\nhypothesis,ယူဆချက်,Research,false\n',
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toEqual({
      sourceTerm: 'hypothesis',
      targetTerm: 'ယူဆချက်',
      notes: 'Research',
      caseSensitive: false,
    })
    expect(result.columns).toContain('source')
  })

  it('accepts alternate header spellings', () => {
    const result = parseGlossaryCsv('Source Term,Target Term\nTorque,တာယာအား\n')
    expect(result.rows[0].sourceTerm).toBe('Torque')
    expect(result.rows[0].targetTerm).toBe('တာယာအား')
  })

  it('falls back to positional columns when there is no header', () => {
    const result = parseGlossaryCsv('liability,တာဝန်ရှိခြင်း\n')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].sourceTerm).toBe('liability')
    expect(result.errors).toHaveLength(0)
  })

  it('auto-detects a tab-separated export', () => {
    const result = parseGlossaryCsv('source\ttarget\nbreach\tချိုးဖောက်မှု\n')
    expect(result.delimiter).toBe('\t')
    expect(result.rows[0].targetTerm).toBe('ချိုးဖောက်မှု')
  })

  it('strips a UTF-8 BOM Excel adds', () => {
    const result = parseGlossaryCsv('﻿source,target\na,b\n')
    expect(result.rows[0].sourceTerm).toBe('a')
  })

  it('reports rows that are missing a term', () => {
    const result = parseGlossaryCsv('source,target\nhypothesis,\n,ယူဆချက်\n')
    expect(result.rows).toHaveLength(0)
    expect(result.errors.map((error) => error.line)).toEqual([2, 3])
  })

  it('ignores blank lines between rows', () => {
    const result = parseGlossaryCsv('source,target\n\na,b\n\n')
    expect(result.rows).toHaveLength(1)
  })

  it('handles quoted values containing commas and newlines', () => {
    const result = parseGlossaryCsv('source,target\n"alpha, one","two\nlines"\n')
    expect(result.rows[0].sourceTerm).toBe('alpha, one')
    expect(result.rows[0].targetTerm).toBe('two\nlines')
  })

  it('parses case_sensitive=true variants', () => {
    const result = parseGlossaryCsv('source,target,case_sensitive\nA,B,yes\n')
    expect(result.rows[0].caseSensitive).toBe(true)
  })

  it('returns an empty result for empty input', () => {
    expect(parseGlossaryCsv('').rows).toHaveLength(0)
    expect(parseGlossaryCsv('').errors).toHaveLength(0)
  })
})

describe('buildGlossaryCsv', () => {
  it('round-trips through the parser', () => {
    const rows = [
      { sourceTerm: 'torque', targetTerm: 'တာယာအား', notes: 'unit: Nm', caseSensitive: false },
      { sourceTerm: 'a,b', targetTerm: 'he said "hi"', notes: 'x', caseSensitive: true },
    ]
    const parsed = parseGlossaryCsv(buildGlossaryCsv(rows))
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toEqual(rows[0])
    expect(parsed.rows[1]).toEqual(rows[1])
  })

  it('uses CRLF row terminators and a header', () => {
    const csv = buildGlossaryCsv([{ sourceTerm: 'a', targetTerm: 'b' }])
    expect(csv.startsWith('source,target,notes,case_sensitive\r\n')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('round-trips as TSV too', () => {
    const rows = [{ sourceTerm: 'a\tb', targetTerm: 'c,d' }]
    const parsed = parseGlossaryCsv(buildGlossaryCsv(rows, '\t'))
    expect(parsed.delimiter).toBe('\t')
    expect(parsed.rows[0]).toEqual({ ...rows[0], notes: '', caseSensitive: false })
  })
})

describe('duplicateRows', () => {
  it('finds exact repeats but not same-source/different-target pairs', () => {
    const rows = [
      { sourceTerm: 'a', targetTerm: 'x', notes: '', caseSensitive: false },
      { sourceTerm: 'a', targetTerm: 'x', notes: '', caseSensitive: false },
      { sourceTerm: 'a', targetTerm: 'y', notes: '', caseSensitive: false },
      { sourceTerm: 'A', targetTerm: 'x', notes: '', caseSensitive: false },
    ]
    expect(duplicateRows(rows)).toEqual([1, 3])
  })
})

describe('detectDelimiter', () => {
  it('prefers tabs when the line is tab heavy', () => {
    expect(detectDelimiter('a\tb\tc,d')).toBe('\t')
    expect(detectDelimiter('a,b,c')).toBe(',')
  })
})
