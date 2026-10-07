import { describe, expect, it } from 'vitest'
import {
  cleanFontName,
  groupItemsIntoLines,
  medianFontSize,
  type TextItemLike,
} from './lineGrouping'

interface ItemOptions {
  x?: number
  y?: number
  width?: number
  size?: number
  font?: string
  dir?: string
  rotation?: number
}

function item(str: string, options: ItemOptions = {}): TextItemLike {
  const size = options.size ?? 12
  const rotation = options.rotation ?? 0
  const radians = (rotation * Math.PI) / 180
  const a = Math.cos(radians) * size
  const b = Math.sin(radians) * size
  const c = -Math.sin(radians) * size
  const d = Math.cos(radians) * size
  return {
    str,
    transform: [a, b, c, d, options.x ?? 0, options.y ?? 700],
    width: options.width ?? str.length * size * 0.5,
    height: size,
    fontName: options.font ?? 'ABCDEF+Helvetica',
    dir: options.dir ?? 'ltr',
  }
}

describe('groupItemsIntoLines', () => {
  it('merges runs that share a baseline and keeps word gaps', () => {
    const lines = groupItemsIntoLines(
      [item('Hello', { x: 50, width: 30 }), item('world', { x: 90, width: 30 })],
      { pageIndex: 0, pageHeight: 800 },
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('Hello world')
    expect(lines[0].itemIndexes).toEqual([0, 1])
  })

  it('does not insert a space between tightly kerned runs', () => {
    const lines = groupItemsIntoLines(
      [item('Hello', { x: 50, width: 30 }), item('world', { x: 81, width: 30 })],
      { pageIndex: 0, pageHeight: 800 },
    )
    expect(lines[0].text).toBe('Helloworld')
  })

  it('splits runs on different baselines into separate lines', () => {
    const lines = groupItemsIntoLines(
      [item('first', { x: 50, y: 740 }), item('second', { x: 50, y: 700 })],
      { pageIndex: 0, pageHeight: 800 },
    )
    expect(lines).toHaveLength(2)
    // Top-to-bottom order: the higher line (y=740) comes first.
    expect(lines.map((line) => line.text)).toEqual(['first', 'second'])
  })

  it('converts to top-left coordinates using the page height', () => {
    const lines = groupItemsIntoLines([item('abc', { x: 100, y: 700, size: 10, width: 30 })], {
      pageIndex: 3,
      pageHeight: 800,
    })
    const [line] = lines
    expect(line.bbox.x).toBe(100)
    expect(line.bbox.w).toBe(30)
    // baseline 700 + ascent 10 → top at 710 → 800 − 710 = 90
    expect(line.bbox.y).toBeCloseTo(90, 1)
    expect(line.bbox.h).toBeCloseTo(10, 1)
  })

  it('keeps rotated text out of horizontal clusters', () => {
    const lines = groupItemsIntoLines(
      [item('side', { x: 20, y: 400, rotation: 90 }), item('main', { x: 60, y: 400 })],
      { pageIndex: 0, pageHeight: 800 },
    )
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.style.rotation).sort()).toEqual([0, 90])
  })

  it('is stable across tiny float jitter (same ids on re-parse)', () => {
    const base = [
      item('Chapter One', { x: 72, y: 720, size: 18, width: 110, font: 'ABCDEF+Times-Bold' }),
      item('Body copy', { x: 72, y: 690, width: 60 }),
    ]
    const jittered = [
      item('Chapter One', {
        x: 72.07,
        y: 719.95,
        size: 18.03,
        width: 110.04,
        font: 'ABCDEF+Times-Bold',
      }),
      item('Body copy', { x: 71.94, y: 690.11, width: 60.02 }),
    ]
    const first = groupItemsIntoLines(base, { pageIndex: 0, pageHeight: 800 })
    const second = groupItemsIntoLines(jittered, { pageIndex: 0, pageHeight: 800 })
    expect(second.map((line) => line.id)).toEqual(first.map((line) => line.id))
  })

  it('derives style from the font name and reports bold/italic', () => {
    const lines = groupItemsIntoLines([item('styled', { font: 'XYZABC+NewYork-BoldItalic' })], {
      pageIndex: 0,
      pageHeight: 800,
      colors: ['#333333'],
    })
    expect(lines[0].style.fontFamily).toBe('NewYork-BoldItalic')
    expect(lines[0].style.bold).toBe(true)
    expect(lines[0].style.italic).toBe(true)
    expect(lines[0].style.color).toBe('#333333')
    expect(lines[0].style.fontSize).toBe(12)
  })

  it('orders right-to-left runs correctly', () => {
    const lines = groupItemsIntoLines(
      [
        item('שלום', { x: 120, width: 40, dir: 'rtl' }),
        item('עולם', { x: 60, width: 40, dir: 'rtl' }),
      ],
      { pageIndex: 0, pageHeight: 800 },
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('שלום עולם')
  })

  it('ignores empty and non-finite items', () => {
    const broken: TextItemLike = {
      str: 'x',
      transform: [Number.NaN, 0, 0, 12, 0, 0],
      width: 5,
      height: 12,
    }
    const lines = groupItemsIntoLines([item('   '), item(''), broken], {
      pageIndex: 0,
      pageHeight: 800,
    })
    expect(lines).toEqual([])
  })

  it('returns nothing for an empty page', () => {
    expect(groupItemsIntoLines([], { pageIndex: 0, pageHeight: 800 })).toEqual([])
  })
})

describe('cleanFontName', () => {
  it('strips subset prefixes and leading slashes', () => {
    expect(cleanFontName('ABCDEF+Arial-BoldMT')).toBe('Arial-BoldMT')
    expect(cleanFontName('/Helvetica')).toBe('Helvetica')
    expect(cleanFontName(undefined)).toBe('Helvetica')
    expect(cleanFontName('ABCDEF+Calibri')).toBe('Calibri')
  })
})

describe('medianFontSize', () => {
  it('is the middle size (average of the two middle values for even counts)', () => {
    const lines = groupItemsIntoLines(
      [
        item('small', { y: 740, size: 10 }),
        item('big', { y: 700, size: 20 }),
        item('mid', { y: 660, size: 14 }),
      ],
      { pageIndex: 0, pageHeight: 800 },
    )
    expect(medianFontSize(lines)).toBe(14)
    expect(medianFontSize([])).toBe(0)
  })
})
