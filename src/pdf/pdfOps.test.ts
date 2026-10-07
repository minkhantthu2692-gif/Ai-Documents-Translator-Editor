import { describe, expect, it } from 'vitest'
import { OPS as realOps } from 'pdfjs-dist'
import {
  OPS,
  addFont,
  assignColors,
  classifyFontName,
  countImages,
  emptyFontStats,
  normalizeColor,
  traceTextRuns,
  type OpList,
} from './pdfOps'

function opList(entries: Array<[number, unknown[]]>): OpList {
  return {
    fnArray: entries.map(([fn]) => fn),
    argsArray: entries.map(([, args]) => args),
  }
}

describe('OPS mirror', () => {
  it('stays in sync with pdfjs-dist', () => {
    expect({ ...OPS }).toEqual({ ...realOps })
  })
})

describe('normalizeColor', () => {
  it('keeps hex strings from pdf.js', () => {
    expect(normalizeColor(['#FF00AA'])).toBe('#ff00aa')
    expect(normalizeColor(['#f0a'])).toBe('#ff00aa')
  })

  it('reads the normalised 0xRRGGBB number', () => {
    expect(normalizeColor([0x3366cc])).toBe('#3366cc')
  })

  it('reads raw RGB triples with either scale', () => {
    expect(normalizeColor([255, 0, 0])).toBe('#ff0000')
    expect(normalizeColor([0, 1, 0])).toBe('#00ff00')
  })

  it('reads a fractional grey level', () => {
    expect(normalizeColor([0.5])).toBe('#808080')
    expect(normalizeColor([1])).toBe('#ffffff')
    expect(normalizeColor([0])).toBe('#000000')
  })

  it('converts CMYK', () => {
    // magenta + yellow = red, no cyan, no key
    expect(normalizeColor([0, 1, 1, 0])).toBe('#ff0000')
    // full cyan
    expect(normalizeColor([1, 0, 0, 0])).toBe('#00ffff')
    expect(normalizeColor([0, 0, 0, 0])).toBe('#ffffff')
  })

  it('returns null for unusable input', () => {
    expect(normalizeColor(undefined)).toBeNull()
    expect(normalizeColor([])).toBeNull()
    expect(normalizeColor(['rgb(1,2,3)'])).toBeNull()
    expect(normalizeColor(['#zzzzzz'])).toBeNull()
  })
})

describe('traceTextRuns', () => {
  it('records position and colour for every text-showing operator', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.setFillRGBColor, ['#ff0000']],
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.setFillGray, [0.5]],
      [OPS.setTextMatrix, [11, 0, 0, 11, 40, 600]],
      [OPS.nextLineShowText, [1]],
      [OPS.endText, []],
    ])

    expect(traceTextRuns(ops)).toEqual([
      { color: '#ff0000', x: 10, y: 700 },
      { color: '#ff0000', x: 10, y: 686 },
      { color: '#808080', x: 40, y: 600 },
    ])
  })

  it('resets the position at every BT', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.moveText, [72, 770]],
      [OPS.showText, [1]],
      [OPS.endText, []],
      [OPS.beginText, []],
      [OPS.moveText, [72, 740]],
      [OPS.showText, [1]],
    ])
    expect(traceTextRuns(ops).map((run) => [run.x, run.y])).toEqual([
      [72, 770],
      [72, 740],
    ])
  })
})

describe('countImages', () => {
  it('counts painted images but not text-render masks', () => {
    const ops = opList([
      [OPS.showText, [1]],
      [OPS.paintImageXObject, []],
      [OPS.paintSolidColorImageMask, []],
      [OPS.paintInlineImageXObjectGroup, []],
    ])
    expect(countImages(ops)).toBe(2)
    expect(countImages(opList([]))).toBe(0)
  })
})

describe('assignColors', () => {
  it('gives every item the colour of its nearest run', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.setFillRGBColor, ['#ff0000']],
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
      [OPS.setFillRGBColor, ['#0000ff']],
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.endText, []],
    ])
    const items = [{ transform: [11, 0, 0, 11, 10, 700] }, { transform: [11, 0, 0, 11, 10, 686] }]
    expect(assignColors(ops, items)).toEqual(['#ff0000', '#0000ff'])
  })

  it('keeps split items on the colour of the run that produced them', () => {
    const ops = opList([
      [OPS.beginText, []],
      [OPS.setFillRGBColor, ['#ff0000']],
      [OPS.moveText, [10, 700]],
      [OPS.showText, [1]],
      [OPS.setFillRGBColor, ['#0000ff']],
      [OPS.setLeadingMoveText, [0, -14]],
      [OPS.showText, [1]],
      [OPS.endText, []],
    ])
    // pdf.js split the first run into two items (whitespace normalisation).
    const items = [
      { transform: [11, 0, 0, 11, 10, 700] },
      { transform: [11, 0, 0, 11, 60, 700] },
      { transform: [11, 0, 0, 11, 10, 686] },
    ]
    expect(assignColors(ops, items)).toEqual(['#ff0000', '#ff0000', '#0000ff'])
  })

  it('returns nulls when the page paints no text', () => {
    expect(assignColors(opList([[OPS.paintImageXObject, []]]), [{ transform: [1, 0] }])).toEqual([
      null,
    ])
  })
})

describe('classifyFontName', () => {
  it('recognises the base-14 fonts as not embedded', () => {
    expect(classifyFontName('Helvetica')).toBe('standard')
    expect(classifyFontName('/Times-BoldItalic')).toBe('standard')
    expect(classifyFontName('CourierNewPSMT')).toBe('standard')
  })

  it('treats subset prefixes as embedded', () => {
    expect(classifyFontName('ABCDEF+ArialMT')).toBe('embedded')
    expect(classifyFontName('ABCDEF+Helvetica')).toBe('embedded')
  })

  it('treats Type3 fonts as embedded (their glyphs live in the file)', () => {
    expect(classifyFontName('Whatever', { isType3: true })).toBe('embedded')
  })

  it('uses the missing-file flag as a non-embedded fallback', () => {
    expect(classifyFontName('MyCustomFont', { missingFile: true })).toBe('standard')
    expect(classifyFontName('MyCustomFont')).toBe('other')
    expect(classifyFontName(undefined)).toBe('other')
  })
})

describe('addFont', () => {
  it('folds classifications into totals, once per font id', () => {
    let stats = emptyFontStats()
    const seen = new Set<string>()
    stats = addFont(stats, seen, 'f1', 'embedded')
    stats = addFont(stats, seen, 'f2', 'standard')
    stats = addFont(stats, seen, 'f1', 'embedded')
    expect(stats).toEqual({ distinct: 2, embedded: 1, standard: 1, other: 0 })
  })
})
