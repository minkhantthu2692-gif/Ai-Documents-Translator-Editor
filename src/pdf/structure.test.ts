import { describe, expect, it } from 'vitest'
import {
  countColumns,
  detectColumns,
  detectRepeatingMargins,
  normalizeMarginText,
  structurePage,
  type StructureOptions,
} from './structure'
import { orderBodyLines } from './readingOrder'
import {
  groupItemsIntoLines,
  type GroupedLine,
  type LineStyle,
  type TextItemLike,
} from './lineGrouping'
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

  it('ranks a page’s own headings when the document ladder is missing', () => {
    const body = Array.from({ length: 6 }, (_, index) =>
      line(`Body copy line number ${index} follows the heading.`, {
        x: 72,
        y: 660 + index * 18,
        w: 320,
        h: 14,
      }),
    )
    const blocks = structurePage(
      [
        line('Chapter Four', { x: 72, y: 600, w: 240, h: 30 }, { fontSize: 30, bold: true }),
        line('4.1 Background', { x: 72, y: 640, w: 200, h: 20 }, { fontSize: 20, bold: true }),
        ...body,
      ],
      options(),
    )
    const levels = blocks
      .filter((block) => block.kind === 'heading')
      .map((block) => block.headingLevel)
    expect(levels).toEqual([1, 2])
    // Nothing that is not a heading claims a level.
    const paragraphs = blocks.filter((block) => block.kind === 'paragraph')
    expect(paragraphs.length).toBeGreaterThan(0)
    expect(paragraphs.every((block) => block.headingLevel === null)).toBe(true)
  })

  it('levels a heading against the whole document, not just this page', () => {
    // The classic failure: a chapter title appears once, so page after page
    // holds only the sections beneath it — and without a document ladder each
    // of those sections would be promoted to level 1.
    const ladder = [30, 20]
    const onlySubsection = structurePage(
      [
        line('4.2 Method', { x: 72, y: 640, w: 180, h: 20 }, { fontSize: 20, bold: true }),
        line('Body copy follows the heading on the page.', { x: 72, y: 620, w: 320, h: 14 }),
        line('More body copy below it.', { x: 72, y: 600, w: 240, h: 14 }),
      ],
      options({ headingSizes: ladder }),
    )
    const heading = onlySubsection.find((block) => block.kind === 'heading')
    expect(heading?.text).toBe('4.2 Method')
    expect(heading?.headingLevel).toBe(2)
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

  it('reads a two-column page with a full-width title in column order', () => {
    // One line bridging the gutter used to disable column detection for the
    // entire page, leaving the two columns interleaved line by line — and each
    // interleaved pair then refused to merge, so the page fell apart too.
    const title = line(
      'Chapter Four',
      { x: 72, y: 60, w: 468, h: 28 },
      { fontSize: 24, bold: true },
    )
    const left = Array.from({ length: 6 }, (_u, index) =>
      line(`Left column line ${index}`, { x: 72, y: 120 + index * 20, w: 220, h: 14 }),
    )
    const right = Array.from({ length: 6 }, (_u, index) =>
      line(`Right column line ${index}`, { x: 320, y: 120 + index * 20, w: 220, h: 14 }),
    )

    const blocks = structurePage([...left, ...right, title], options())

    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'paragraph'])
    expect(blocks[0].text).toBe('Chapter Four')
    // The whole left column must precede the whole right column.
    expect(blocks[1].lines).toHaveLength(6)
    expect(blocks[1].text).toMatch(/^Left column line 0/)
    expect(blocks[2].lines).toHaveLength(6)
    expect(blocks[2].text).toMatch(/^Right column line 0/)
    expect(blocks[1].bbox.x).toBe(72)
    expect(blocks[2].bbox.x).toBe(320)
  })

  it('reads a three-column page left to right rather than alternating', () => {
    const columns = [40, 226, 412].map((x, column) =>
      Array.from({ length: 6 }, (_u, row) =>
        line(`Column${column} line${row}`, { x, y: 100 + row * 20, w: 160, h: 14 }),
      ),
    )

    const blocks = structurePage(columns.flat(), options())

    expect(blocks).toHaveLength(3)
    expect(blocks.map((block) => Math.round(block.bbox.x))).toEqual([40, 226, 412])
    blocks.forEach((block, index) => {
      expect(block.lines).toHaveLength(6)
      expect(block.text).toMatch(new RegExp(`^Column${index} line0`))
    })
  })
})

/**
 * Footnotes are the one kind of body text that must *not* behave like body
 * text: they are set small, they sit where a caption could sit, and they are
 * close enough to the paragraph above to be swallowed by the merger. Each of
 * the three signals has to hold on its own — size alone would eat captions,
 * placement alone would eat any small print, a marker alone would eat every
 * numbered section — so each test below removes exactly one of them.
 */
describe('structurePage footnote regions', () => {
  const BODY: Partial<LineStyle> = { fontSize: 10 }
  const NOTE: Partial<LineStyle> = { fontSize: 9 }

  /**
   * Body 10pt, notes 9pt — one point apart, which is exactly the awkward
   * case: close enough for `canMerge`'s size check to wave the note through,
   * so only the region marking can keep it out of the paragraph.
   */
  function footnotePage(): GroupedLine[] {
    return [
      line(
        'The question then becomes whether the model generalises',
        { x: 72, y: 407, w: 420, h: 12 },
        BODY,
      ),
      line('beyond the training distribution at all', { x: 72, y: 421, w: 420, h: 12 }, BODY),
      line('and, if so, under exactly which assumptions', { x: 72, y: 435, w: 420, h: 12 }, BODY),
      line(
        'the guarantee is supposed to survive the shift',
        { x: 72, y: 449, w: 420, h: 12 },
        BODY,
      ),
      line(
        '1 Smith (2001) argues that the effect persists',
        { x: 72, y: 463, w: 420, h: 11 },
        NOTE,
      ),
      line(
        '2 Jones (2003) disagrees with the reading above',
        { x: 72, y: 477, w: 420, h: 11 },
        NOTE,
      ),
    ]
  }

  it('keeps notes out of the paragraph above and labels them footnotes', () => {
    const blocks = structurePage(footnotePage(), options())

    expect(blocks).toHaveLength(3)
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'footnote', 'footnote'])
    expect(blocks.map((block) => block.order)).toEqual([0, 1, 2])
    // The paragraph keeps its four lines: the note is not swallowed, so its
    // marker cannot vanish mid-sentence and its text cannot be translated as
    // part of the body.
    expect(blocks[0].lines).toHaveLength(4)
    expect(blocks[0].text).not.toContain('Smith')
    expect(blocks[1].lines).toHaveLength(1)
    expect(blocks[1].text).toBe('1 Smith (2001) argues that the effect persists')
    expect(blocks[1].region).toBe('body')
    expect(blocks[2].text).toBe('2 Jones (2003) disagrees with the reading above')
  })

  it('never turns a note marker into a list marker', () => {
    const blocks = structurePage(footnotePage(), options())
    // `1 Smith…` would have matched the bullet pattern had the note stayed a
    // list block, and exports re-attach `listMarker` *in front of* the text —
    // the marker would print twice. It stays inside the text instead, where a
    // reader sees it even before translation.
    for (const block of blocks.filter((entry) => entry.kind === 'footnote')) {
      expect(block.listMarker).toBeNull()
      expect(block.text.trim()).toMatch(/^[\d၀-၉][.)]?\s/)
    }
  })

  it('reads a full-width note after both columns it sits under', () => {
    const left = Array.from({ length: 6 }, (_u, index) =>
      line(`Left column line ${index}`, { x: 72, y: 100 + index * 20, w: 200, h: 14 }, BODY),
    )
    const right = Array.from({ length: 6 }, (_u, index) =>
      line(`Right column line ${index}`, { x: 330, y: 100 + index * 20, w: 200, h: 14 }, BODY),
    )
    const note = line(
      '1 Full references appear in the appendix.',
      { x: 72, y: 470, w: 468, h: 11 },
      NOTE,
    )

    const blocks = structurePage([...left, ...right, note], options())

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph', 'footnote'])
    expect(blocks[0].lines).toHaveLength(6)
    expect(blocks[1].lines).toHaveLength(6)
    expect(blocks[2].text).toContain('Full references')
    expect(blocks[2].order).toBe(2)
  })

  it('starts a new block where body text resumes after a note', () => {
    // The mirror image of the swallowing case: here the note is already its
    // own block, and the body-size line under it shares its indent, its
    // leading and a 10-vs-9pt size difference small enough for `canMerge` to
    // accept. Without the region boundary the paragraph would be re-absorbed
    // into the note and inherit the footnote label.
    const blocks = structurePage(
      [
        line(
          'The ablation study removes one component at a time',
          {
            x: 72,
            y: 400,
            w: 420,
            h: 12,
          },
          BODY,
        ),
        line(
          'and reports the drop in accuracy for each removal',
          {
            x: 72,
            y: 414,
            w: 420,
            h: 12,
          },
          BODY,
        ),
        line(
          'across the three benchmark datasets we care about',
          {
            x: 72,
            y: 428,
            w: 420,
            h: 12,
          },
          BODY,
        ),
        line(
          'that the paper is built to defend at length',
          {
            x: 72,
            y: 442,
            w: 420,
            h: 12,
          },
          BODY,
        ),
        line('1 Smith (2001) argues the opposite', { x: 72, y: 456, w: 420, h: 11 }, NOTE),
        line(
          'The appendix then lists every dataset used',
          {
            x: 72,
            y: 468,
            w: 420,
            h: 12,
          },
          BODY,
        ),
      ],
      options(),
    )

    expect(blocks).toHaveLength(3)
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'footnote', 'paragraph'])
    expect(blocks[1].lines).toHaveLength(1)
    expect(blocks[2].text).toBe('The appendix then lists every dataset used')
  })

  it('leaves a caption alone — small and low is not enough without a marker', () => {
    const blocks = structurePage(
      [
        line(
          'The ablation study removes one component at a time',
          { x: 72, y: 300, w: 420, h: 12 },
          BODY,
        ),
        line(
          'and reports the drop in accuracy for each removal',
          { x: 72, y: 314, w: 420, h: 12 },
          BODY,
        ),
        line(
          'across the three benchmark datasets we care about',
          { x: 72, y: 328, w: 420, h: 12 },
          BODY,
        ),
        line(
          'Figure 3: Results of the ablation study',
          { x: 72, y: 460, w: 420, h: 10 },
          { fontSize: 8 },
        ),
      ],
      options(),
    )

    expect(blocks).toHaveLength(2)
    expect(blocks[1].kind).toBe('caption')
  })

  it('leaves a marked line alone when it sits above the footnote zone', () => {
    const blocks = structurePage(
      [
        line(
          'The ablation study removes one component at a time',
          { x: 72, y: 300, w: 420, h: 12 },
          BODY,
        ),
        line(
          'and reports the drop in accuracy for each removal',
          { x: 72, y: 314, w: 420, h: 12 },
          BODY,
        ),
        line(
          'across the three benchmark datasets we care about',
          { x: 72, y: 328, w: 420, h: 12 },
          BODY,
        ),
        line('1 Smith (2001) argues the opposite', { x: 72, y: 350, w: 420, h: 11 }, NOTE),
      ],
      options(),
    )

    expect(blocks).toHaveLength(2)
    expect(blocks[1].kind).toBe('paragraph')
    expect(blocks.map((block) => block.kind)).not.toContain('footnote')
  })
})

describe('detectColumns vs orderBodyLines', () => {
  it('the conservative split still refuses a page whose title bridges the gutter', () => {
    // This is deliberate and must stay that way: `detectColumns` feeds layout
    // complexity scoring, where "I cannot see a clean gutter" is the honest
    // answer. Reading order needs the opposite instinct — the bridging line is
    // a title, not a reason to give up — which is why `structurePage` orders
    // through `orderBodyLines` and must not be "simplified" back onto this.
    const bridging = [
      line('Chapter Four', { x: 72, y: 60, w: 468, h: 28 }, { fontSize: 24, bold: true }),
      ...Array.from({ length: 6 }, (_u, index) =>
        line(`Left ${index}`, { x: 72, y: 120 + index * 20, w: 220, h: 14 }),
      ),
      ...Array.from({ length: 6 }, (_u, index) =>
        line(`Right ${index}`, { x: 320, y: 120 + index * 20, w: 220, h: 14 }),
      ),
    ]

    expect(detectColumns(bridging, 612).columns).toHaveLength(1)
    expect(orderBodyLines(bridging, 612)[0].text).toBe('Chapter Four')
    expect(orderBodyLines(bridging, 612)[1].text).toMatch(/^Left/)
  })
})

/**
 * The case the previous two tests only gesture at: on a real page the
 * two columns are usually laid out on a shared grid, so clustering is free to
 * fuse each row into ONE line spanning the fold. At that point the gutter is
 * not merely undetected — it is absent from the bounding box, so no ordering
 * strategy can recover it. Only the sub-line runs still know where it is.
 */
describe('structurePage on grid-aligned columns', () => {
  function item(
    str: string,
    options: { x: number; y: number; width?: number; size?: number },
  ): TextItemLike {
    const size = options.size ?? 12
    return {
      str,
      transform: [size, 0, 0, size, options.x, options.y],
      width: options.width ?? str.length * size * 0.5,
      height: size,
      fontName: 'ABCDEF+Helvetica',
      dir: 'ltr',
    }
  }

  function gridPage(): TextItemLike[] {
    const items: TextItemLike[] = []
    for (let row = 0; row < 6; row += 1) {
      items.push(item(`Left ${row}`, { x: 72, y: 690 - row * 20, width: 220 }))
      items.push(item(`Right ${row}`, { x: 320, y: 690 - row * 20, width: 220 }))
    }
    return items
  }

  it('cuts the fused rows apart and reads each column as a single block', () => {
    const lines = groupItemsIntoLines(gridPage(), { pageIndex: 0, pageHeight: 792 })

    // The premise, asserted: six rows, each one line spanning 72 → 540.
    expect(lines).toHaveLength(6)
    expect(lines[0].bbox.w).toBeCloseTo(468, 6)
    expect(lines[0].text).toBe('Left 0 Right 0')

    const blocks = structurePage(lines, options())

    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toMatch(/^Left 0/)
    expect(blocks[0].text).toMatch(/Left 5$/)
    expect(blocks[0].text).not.toContain('Right')
    expect(blocks[1].text).toMatch(/^Right 0/)
    expect(blocks[1].text).not.toContain('Left')
    expect(Math.round(blocks[0].bbox.x)).toBe(72)
    expect(Math.round(blocks[1].bbox.x)).toBe(320)
    expect(blocks[0].order).toBe(0)
    expect(blocks[1].order).toBe(1)
  })

  it('does not invent blocks when the page really is one column', () => {
    const items: TextItemLike[] = []
    for (let row = 0; row < 6; row += 1) {
      items.push(item(`Paragraph ${row}`, { x: 72, y: 690 - row * 20, width: 468 }))
    }
    const lines = groupItemsIntoLines(items, { pageIndex: 0, pageHeight: 792 })

    const blocks = structurePage(lines, options())

    expect(lines).toHaveLength(6)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].lines).toHaveLength(6)
  })
})

describe('normalizeMarginText', () => {
  it('collapses digits and whitespace so page labels match across pages', () => {
    expect(normalizeMarginText('Annual Report 2026')).toBe('annual report #')
    expect(normalizeMarginText('Page  12')).toBe('page #')
    expect(normalizeMarginText('  Mixed   Spacing ')).toBe('mixed spacing')
  })
})

describe('countColumns', () => {
  /** Ten aligned lines at each x offset (130pt wide → ≥8pt gutters between columns). */
  const at = (...xs: number[]): GroupedLine[] =>
    xs.flatMap((x, column) =>
      Array.from({ length: 10 }, (_, row) =>
        line(`Column ${column + 1} line ${row + 1}`, { x, y: 500 + row * 16, w: 130, h: 14 }),
      ),
    )

  it('reports one column for a single block of lines', () => {
    expect(countColumns(at(72), 612)).toBe(1)
    expect(countColumns(at(72, 100), 612)).toBe(1) // same column, slight indent
  })

  it('reports two columns for the newspaper split', () => {
    expect(countColumns(at(40, 330), 612)).toBe(2)
  })

  it('recurses to three and four columns', () => {
    expect(countColumns(at(40, 226, 412), 612)).toBe(3)
    expect(countColumns(at(30, 170, 310, 450), 612)).toBe(4)
  })

  it('never exceeds the cap and ignores tiny samples', () => {
    expect(countColumns(at(30, 170, 310, 450), 612, 2)).toBe(2)
    expect(countColumns(at(40, 226, 412).slice(0, 4), 612)).toBe(1)
    expect(countColumns([], 612)).toBe(1)
    expect(countColumns(at(40, 226, 412), 0)).toBe(1)
  })
})
