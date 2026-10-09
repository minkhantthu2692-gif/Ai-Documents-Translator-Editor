import { describe, expect, it, vi } from 'vitest'
import {
  createCanvasMeasurer,
  fitBlockText,
  measureBlock,
  type TextMeasurer,
  wrapLines,
} from './autofit'

/** Deterministic measurer: 1 char = 1 point at 1 pt font size. */
const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize

const box = { width: 100, height: 100 }

function request(text: string, overrides: Partial<Parameters<typeof fitBlockText>[0]> = {}) {
  return {
    text,
    box,
    fontFamily: 'Noto Sans',
    bold: false,
    italic: false,
    originalSize: 10,
    lineHeight: 1.5,
    measure,
    ...overrides,
  }
}

describe('wrapLines', () => {
  it('keeps a line that already fits', () => {
    expect(wrapLines('hello', 100, (chunk) => chunk.length)).toEqual(['hello'])
  })

  it('wraps greedily at spaces', () => {
    const lines = wrapLines('one two three four five', 10, (chunk) => chunk.length)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10)
    expect(lines.join(' ')).toBe('one two three four five')
  })

  it('never splits a word that fits the box', () => {
    const lines = wrapLines('short aaaalong', 7, (chunk) => chunk.length)
    expect(lines).toEqual(['short', 'aaaalong'])
  })

  it('breaks CJK runs between characters', () => {
    const lines = wrapLines('日本語テキスト', 5, (chunk) => chunk.length)
    expect(lines.length).toBe(2)
    expect(lines.join('')).toBe('日本語テキスト')
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(5)
  })

  it('honours explicit newlines', () => {
    expect(wrapLines('a\n\nb', 50, (chunk) => chunk.length)).toEqual(['a', '', 'b'])
  })
})

describe('fitBlockText', () => {
  it('leaves text that already fits untouched', () => {
    const result = fitBlockText(request('hi'))
    expect(result.reason).toBe('fits')
    expect(result.fontSize).toBe(10)
    expect(result.scaled).toBe(false)
    expect(result.fits).toBe(true)
  })

  it('reports an empty block without measuring', () => {
    const result = fitBlockText(request('   '))
    expect(result.reason).toBe('empty')
    expect(result.lines).toEqual([])
  })

  it('shrinks to the largest size that fits the box', () => {
    // 30pt tall box: two lines at 10pt (30pt) exceed it, so auto-fit shrinks.
    const result = fitBlockText(request('hello world', { box: { width: 100, height: 12 } }))
    expect(result.reason).toBe('shrunk')
    expect(result.fits).toBe(true)
    expect(result.scaled).toBe(true)
    expect(result.fontSize).toBeLessThan(10)
    expect(result.fontSize).toBeGreaterThan(4)
    expect(result.width).toBeLessThanOrEqual(100)
    expect(result.height).toBeLessThanOrEqual(12)
  })

  it('cannot shrink past the minimum and reports an overflow', () => {
    const result = fitBlockText(request('x'.repeat(300), { minSize: 4 }))
    expect(result.reason).toBe('overflow')
    expect(result.fits).toBe(false)
    expect(result.fontSize).toBe(4)
  })

  it('measures height as lines × line-height × size', () => {
    const block = measureBlock('aaaa bbbb', { width: 9, height: 100 }, 10, 1.7, measure, {
      fontFamily: 'Noto Sans',
      bold: false,
      italic: false,
    })
    expect(block.lines.length).toBe(2)
    expect(block.height).toBeCloseTo(2 * 1.7 * 10)
  })

  it('respects a caller-provided max size', () => {
    const result = fitBlockText(
      request('hello world', { box: { width: 100, height: 12 }, maxSize: 6 }),
    )
    expect(result.fontSize).toBeLessThanOrEqual(6)
    expect(result.fits).toBe(true)
  })
})

describe('createCanvasMeasurer', () => {
  it('falls back to a metric-free estimate when no 2D context exists', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const width = createCanvasMeasurer()({
      text: 'မြန်မာစာ',
      fontFamily: 'Noto Sans Myanmar',
      fontSize: 12,
      bold: false,
      italic: false,
    })
    expect(Number.isFinite(width)).toBe(true)
    expect(width).toBeGreaterThan(0)
  })

  it('measures through the 2D context when one is available', () => {
    const ctx = {
      font: '',
      measureText: (text: string) => ({ width: text.length * 10 }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    )
    const measurer = createCanvasMeasurer()
    expect(
      measurer({ text: 'abcd', fontFamily: 'Noto Sans', fontSize: 12, bold: false, italic: false }),
    ).toBeCloseTo((4 * 10 * 72) / 96)
    // 12pt → 16px font.
    expect(ctx.font).toContain('16px')
  })

  it('reports the fallback once, not once per measured line', () => {
    const onFallback = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const measurer = createCanvasMeasurer(undefined, onFallback)

    measurer({ text: 'abc', fontFamily: 'Noto Sans', fontSize: 10, bold: false, italic: false })
    measurer({ text: 'defgh', fontFamily: 'Noto Sans', fontSize: 10, bold: false, italic: false })

    // An export measures every line of every block; the reason has not
    // changed between them.
    expect(onFallback).toHaveBeenCalledTimes(1)
  })

  it('says nothing when a context does open', () => {
    const onFallback = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (text: string) => ({ width: text.length * 10 }),
    } as unknown as CanvasRenderingContext2D)
    const measurer = createCanvasMeasurer(undefined, onFallback)

    measurer({ text: 'abc', fontFamily: 'Noto Sans', fontSize: 12, bold: false, italic: false })

    expect(onFallback).not.toHaveBeenCalled()
  })
})
