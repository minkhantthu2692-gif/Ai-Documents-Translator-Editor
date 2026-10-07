import { describe, expect, it } from 'vitest'
import {
  detectRepeatingMargins,
  normalizeMarginText,
  structurePage,
  type StructureOptions,
} from './structure'
import type { GroupedLine, LineStyle } from './lineGrouping'
import { lineId, type BBox } from './stableId'

const PAGE = { pageWidth: 612, pageHeight: 792 }
const BASE_STYLE: LineStyle = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  color: '#000000',
  rotation: 0,
}

function line(text: string, bbox: BBox, style: Partial<LineStyle> = {}): GroupedLine {
  const merged = { ...BASE_STYLE, ...style }
  return {
    id: lineId(0, bbox, text),
    text,
    bbox,
    style: merged,
    itemIndexes: [],
  }
}

function options(extra: Partial<StructureOptions> = {}): StructureOptions {
  return { pageIndex: 0, ctx: { sourceLang: 'en', targetLang: 'my' }, ...PAGE, ...extra }
}

describe('structurePage', () => {
  it('merges close lines of the same style into one paragraph block', () => {
    const blocks = structurePage(
      [
        line('First paragraph line one.', { x: 72, y: 600, w: 300, h: 14 }),
        line('It continues right here.', { x: 72, y: 616, w: 280, h: 14 }),
        line('A new paragraph starts.', { x: 72, y: 660, w: 240, h: 14 }),
      ],
      options(),
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0].lines).toHaveLength(2)
    expect(blocks[0].kind).toBe('paragraph')
    expect(blocks[0].order).toBe(0)
    expect(blocks[1].text).toBe('A new paragraph starts.')
  })

  it('detects headings from a larger font', () => {
    const blocks = structurePage(
      [
        line('Chapter Four', { x: 72, y: 680, w: 200, h: 28 }, { fontSize: 26, bold: true }),
        line('Body copy follows the heading on the page.', { x: 72, y: 620, w: 320, h: 14 }),
        line('More body copy below it.', { x: 72, y: 600, w: 240, h: 14 }),
      ],
      options(),
    )
    const heading = blocks.find((block) => block.kind === 'heading')
    expect(heading).toBeDefined()
    expect(heading!.text).toBe('Chapter Four')
    expect(heading!.bold).toBe(true)
  })

  it('marks bullet lines as list blocks with their marker', () => {
    const blocks = structurePage(
      [
        line('• First point', { x: 72, y: 620, w: 160, h: 14 }),
        line('• Second point', { x: 72, y: 600, w: 170, h: 14 }),
      ],
      options(),
    )
    expect(blocks).toHaveLength(2)
    expect(blocks.every((block) => block.kind === 'list')).toBe(true)
    expect(blocks[0].listMarker).toBe('•')
  })

  it('moves page labels into the footer band', () => {
    const blocks = structurePage(
      [
        line('Body text of the page.', { x: 72, y: 400, w: 240, h: 14 }),
        line('12', { x: 296, y: 764, w: 20, h: 12 }),
      ],
      options(),
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0].region).toBe('body')
    expect(blocks[1].region).toBe('footer')
    expect(blocks[1].skipRule).toBe('number')
    // Reading order puts the body before the footer.
    expect(blocks.map((block) => block.region)).toEqual(['body', 'footer'])
  })

  it('detects running heads that repeat across pages', () => {
    const pages = [
      {
        lines: [line('Annual Report 2026', { x: 72, y: 20, w: 200, h: 12 }, { fontSize: 9 })],
        pageHeight: 792,
      },
      {
        lines: [line('Annual Report 2027', { x: 72, y: 20, w: 200, h: 12 }, { fontSize: 9 })],
        pageHeight: 792,
      },
    ]
    const { headers, footers } = detectRepeatingMargins(pages)
    expect(headers.has('annual report #')).toBe(true)
    expect(footers.size).toBe(0)

    const blocks = structurePage(
      [
        line('Annual Report 2028', { x: 72, y: 20, w: 200, h: 12 }, { fontSize: 9 }),
        line('Chapter body text.', { x: 72, y: 400, w: 200, h: 14 }),
      ],
      options({ headerTexts: headers, footerTexts: footers }),
    )
    expect(blocks[0].region).toBe('header')
    expect(blocks[1].region).toBe('body')
    expect(blocks.map((block) => block.region)).toEqual(['header', 'body'])
  })

  it('reads a two-column page column by column', () => {
    const lines: GroupedLine[] = [
      line('L1 left column top', { x: 40, y: 520, w: 200, h: 14 }),
      line('L2 left column mid', { x: 40, y: 560, w: 200, h: 14 }),
      line('L3 left column low', { x: 40, y: 600, w: 200, h: 14 }),
      line('R1 right column top', { x: 330, y: 520, w: 200, h: 14 }),
      line('R2 right column mid', { x: 330, y: 560, w: 200, h: 14 }),
      line('R3 right column low', { x: 330, y: 600, w: 200, h: 14 }),
    ]
    const blocks = structurePage(lines, options())
    const order = blocks.map((block) => block.text.split('\n')[0].slice(0, 2))
    expect(order[0]).toBe('L1')
    expect(order[order.length - 1]).toContain('R')
    // All left-column lines must be read before any right-column line.
    const firstRight = blocks.findIndex((block) => block.text.includes('R1'))
    const lastLeft = blocks.map((block) => block.text.includes('L3')).lastIndexOf(true)
    expect(firstRight).toBeGreaterThan(lastLeft)
  })

  it('groups aligned short cells into a table block', () => {
    const blocks = structurePage(
      [
        line('Name    Value', { x: 72, y: 588, w: 200, h: 14 }),
        line('Alpha   12', { x: 72, y: 604, w: 200, h: 14 }),
        line('Beta    34', { x: 72, y: 620, w: 200, h: 14 }),
      ],
      options(),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('table')
    expect(blocks[0].lines).toHaveLength(3)
    expect(blocks[0].text.split('\n')[1]).toContain(' \t ')
  })

  it('propagates skip rules and placeholders from line analysis', () => {
    const blocks = structurePage(
      [
        line('See https://example.com/docs', { x: 72, y: 600, w: 260, h: 14 }),
        line('The link is checked automatically', { x: 72, y: 616, w: 260, h: 14 }),
        line('Use E=mc^2 for the estimate', { x: 72, y: 660, w: 260, h: 14 }),
      ],
      options(),
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0].skipRule).toBe('url')
    expect(blocks[1].skipRule).toBe('formula')
    expect(blocks[1].placeholders.map((placeholder) => placeholder.original)).toEqual(['E=mc^2'])
  })

  it('classifies already-translated target text as skippable', () => {
    const blocks = structurePage(
      [line('မြန်မာနိုင်ငံ ဒီမိုကရေစီ', { x: 72, y: 400, w: 240, h: 14 })],
      options(),
    )
    expect(blocks[0].skipRule).toBe('alreadyTarget')
  })

  it('reports alignment for a centred single line', () => {
    const blocks = structurePage(
      [line('Centre of the page', { x: 206, y: 400, w: 200, h: 14 })],
      options(),
    )
    expect(blocks[0].alignment).toBe('center')
    expect(blocks[0].kind).toBe('paragraph')
  })

  it('estimates line spacing from the block height', () => {
    const blocks = structurePage(
      [
        line('one', { x: 72, y: 620, w: 40, h: 12 }),
        line('two', { x: 72, y: 636, w: 40, h: 12 }),
        line('three', { x: 72, y: 652, w: 40, h: 12 }),
      ],
      options(),
    )
    expect(blocks[0].lines).toHaveLength(3)
    expect(blocks[0].lineSpacing).toBeGreaterThanOrEqual(1)
  })

  it('returns no blocks for an empty page', () => {
    expect(structurePage([], options())).toEqual([])
  })
})

describe('normalizeMarginText', () => {
  it('collapses digits and whitespace so page labels match across pages', () => {
    expect(normalizeMarginText('Annual Report 2026')).toBe('annual report #')
    expect(normalizeMarginText('Page  12')).toBe('page #')
    expect(normalizeMarginText('  Mixed   Spacing ')).toBe('mixed spacing')
  })
})
