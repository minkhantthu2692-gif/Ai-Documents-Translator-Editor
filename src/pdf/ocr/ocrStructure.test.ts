import { describe, expect, it } from 'vitest'
import type { OcrBBox, OcrLine, OcrPageData } from '@/ocr/ocrTypes'
import {
  mergeOcrBlocks,
  ocrLines,
  ocrToBlocks,
  ocrToLines,
  OCR_MIN_CONFIDENCE,
} from './ocrStructure'
import type { PageBlock } from '../structure'

/** Scale 4 → 4 pixels per point; page 612×792 as rendered. */
const OPTIONS = { pageIndex: 0, pageWidth: 612, pageHeight: 792, scale: 4 }

const box = (x0: number, y0: number, x1: number, y1: number): OcrBBox => ({ x0, y0, x1, y1 })

const line = (text: string, confidence: number, bbox: OcrBBox): OcrLine => ({
  text,
  confidence,
  bbox,
})

const page = (...lines: OcrLine[]): OcrPageData => ({
  blocks: [{ paragraphs: [{ lines }] }],
  confidence: 81,
})

function block(order: number, x: number, y: number, w: number, h: number, text = 'x'): PageBlock {
  return {
    id: `b${order}`,
    kind: 'paragraph',
    region: 'body',
    order,
    text,
    bbox: { x, y, w, h },
    lines: [],
    alignment: 'left',
    skipRule: null,
    placeholders: [],
    listMarker: null,
    lineSpacing: 1.2,
    fontFamily: 'Helvetica',
    fontSize: 10,
    bold: false,
    italic: false,
    color: '#000000',
  }
}

describe('ocrLines', () => {
  it('flattens the block tree and drops noise (low confidence, blanks, junk boxes)', () => {
    const data: OcrPageData = {
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                line('kept', 80, box(10, 10, 100, 30)),
                line('unsure', 9, box(10, 40, 90, 60)),
              ],
            },
            {
              lines: [
                line('   ', 90, box(10, 70, 90, 90)),
                line('zero width', 90, box(10, 10, 10, 30)),
              ],
            },
          ],
        },
        {
          paragraphs: [
            { lines: [line('also kept', Number.NaN, box(10, 100, 120, 120))] },
            { lines: [line('nan box', 90, box(Number.NaN, 10, 50, 30))] },
          ],
        },
      ],
    }
    expect(ocrLines(data).map((entry) => entry.text)).toEqual(['kept', 'also kept'])
  })

  it('keeps a line exactly at the confidence floor', () => {
    const data = page(line('on the line', OCR_MIN_CONFIDENCE, box(0, 0, 50, 20)))
    expect(ocrLines(data)).toHaveLength(1)
  })

  it('handles missing or empty recognition output', () => {
    expect(ocrLines(null)).toEqual([])
    expect(ocrLines({ blocks: null })).toEqual([])
    expect(ocrLines({ blocks: [] })).toEqual([])
    expect(ocrLines(page())).toEqual([])
  })
})

describe('ocrToLines', () => {
  it('converts pixel boxes to page points with the top-left round trip intact', () => {
    const lines = ocrToLines(page(line('Hello scan', 90, box(40, 80, 440, 104))), OPTIONS)
    expect(lines).toHaveLength(1)
    expect(lines[0].bbox).toEqual({ x: 10, y: 20, w: 100, h: 6 })
    expect(lines[0].text).toBe('Hello scan')
  })

  it('stamps every line with the OCR style but keeps geometry-derived sizes', () => {
    const lines = ocrToLines(
      page(
        line('small', 90, box(0, 0, 40, 24)),
        line('a much taller headline', 90, box(0, 40, 400, 96)),
      ),
      OPTIONS,
    )
    expect(lines).toHaveLength(2)
    for (const entry of lines) {
      expect(entry.style.fontFamily).toBe('OCR')
      expect(entry.style.color).toBe('#000000')
      expect(entry.style.rotation).toBe(0)
    }
    expect(lines[0].style.fontSize).toBe(6) // 24px ÷ 4
    expect(lines[1].style.fontSize).toBe(14) // 56px ÷ 4 — the headline really is bigger
  })

  it('returns lines ordered top to bottom', () => {
    const lines = ocrToLines(
      page(line('lower', 90, box(0, 200, 100, 224)), line('upper', 90, box(0, 40, 100, 64))),
      OPTIONS,
    )
    expect(lines.map((entry) => entry.text)).toEqual(['upper', 'lower'])
  })

  it('respects a custom confidence floor', () => {
    const data = page(line('shaky', 50, box(0, 0, 80, 24)))
    expect(ocrToLines(data, { ...OPTIONS, minConfidence: 60 })).toHaveLength(0)
    expect(ocrToLines(data, { ...OPTIONS, minConfidence: 40 })).toHaveLength(1)
  })
})

describe('ocrToBlocks', () => {
  const data = page(
    line('Chapter One', 88, box(40, 40, 440, 96)),
    line(
      'The quick brown fox jumps over the lazy dog and keeps running.',
      92,
      box(40, 120, 560, 144),
    ),
    line('It never stops along the open road.', 85, box(40, 150, 400, 174)),
  )

  it('produces ordered, non-empty blocks through the structure pass', () => {
    const content = ocrToBlocks(data, OPTIONS)
    expect(content.blocks.length).toBeGreaterThanOrEqual(1)
    expect(content.blocks.map((entry) => entry.order)).toEqual(
      content.blocks.map((_, index) => index),
    )
    for (const entry of content.blocks) {
      expect(entry.text.trim().length).toBeGreaterThan(0)
      expect(entry.bbox.x).toBeGreaterThanOrEqual(0)
      expect(entry.bbox.y).toBeGreaterThanOrEqual(0)
      expect(entry.bbox.x + entry.bbox.w).toBeLessThanOrEqual(OPTIONS.pageWidth + 0.01)
      expect(entry.bbox.y + entry.bbox.h).toBeLessThanOrEqual(OPTIONS.pageHeight + 0.01)
    }
  })

  it('reports line and character counts matching the grouped lines', () => {
    const lines = ocrToLines(data, OPTIONS)
    const content = ocrToBlocks(data, OPTIONS)
    expect(content.lineCount).toBe(lines.length)
    expect(content.charCount).toBe(
      lines.reduce((sum, entry) => sum + entry.text.replace(/\s+/g, '').length, 0),
    )
    expect(content.charCount).toBeGreaterThan(0)
  })

  it('returns nothing for an unreadable page', () => {
    const content = ocrToBlocks(null, OPTIONS)
    expect(content.blocks).toEqual([])
    expect(content.lineCount).toBe(0)
    expect(content.charCount).toBe(0)
  })
})

describe('mergeOcrBlocks', () => {
  it('passes each side through untouched when the other is empty', () => {
    const text = [block(0, 0, 0, 100, 20)]
    const ocr = [block(0, 0, 100, 100, 20)]
    expect(mergeOcrBlocks(text, [])).toBe(text)
    expect(mergeOcrBlocks([], ocr)).toBe(ocr)
  })

  it('appends OCR blocks the text layer does not cover and renumbers the order', () => {
    const text = [block(0, 0, 0, 200, 40), block(1, 0, 60, 200, 40)]
    // Inside a text block (re-reading the page's own type) vs. a caption in
    // the image area: dropped vs. kept.
    const noise = block(0, 10, 8, 120, 16, 're-read text')
    const caption = block(1, 40, 400, 300, 24, 'Figure 1 — the pipeline')
    const merged = mergeOcrBlocks(text, [noise, caption])

    expect(merged).toHaveLength(3)
    expect(merged.map((entry) => entry.order)).toEqual([0, 1, 2])
    expect(merged.map((entry) => entry.text)).toEqual([
      text[0].text,
      text[1].text,
      'Figure 1 — the pipeline',
    ])
  })

  it('keeps OCR blocks that only graze the text layer', () => {
    const text = [block(0, 0, 0, 100, 100)]
    const graze = block(0, 80, 0, 100, 100, 'sidebar note')
    expect(mergeOcrBlocks(text, [graze])).toHaveLength(2)
  })

  it('is stable when both sides carry many blocks', () => {
    const text = Array.from({ length: 5 }, (_, index) => block(index, 0, index * 60, 300, 40))
    const ocr = Array.from({ length: 3 }, (_, index) => block(index, 320, index * 60, 200, 40))
    const merged = mergeOcrBlocks(text, ocr)
    expect(merged).toHaveLength(8)
    expect(merged.map((entry) => entry.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})
