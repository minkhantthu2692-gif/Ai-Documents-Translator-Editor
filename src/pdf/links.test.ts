/**
 * Link-annotation matching.
 *
 * The pieces are tested separately because they fail differently: the URL
 * filter is a security boundary, the anchor slice is geometry, and the block
 * assignment is bookkeeping. `pdfExtract.test.ts` then drives the whole thing
 * against `fixtures/links.pdf`, which is written by hand in Courier so every
 * rectangle in it is exact.
 */
import { describe, expect, it } from 'vitest'
import { groupItemsIntoLines, type TextItemLike } from './lineGrouping'
import {
  attachLinks,
  internalDestinations,
  linkAnchors,
  linksFromAnnotations,
  safeLinkUrl,
} from './links'
import { structurePage, type PageBlock } from './structure'

const PAGE_HEIGHT = 792
const SIZE = 10
/** Courier's advance width at `SIZE` — the fixture's whole point. */
const CH = SIZE * 0.6

function item(str: string, x: number, baseline: number): TextItemLike {
  return {
    str,
    transform: [SIZE, 0, 0, SIZE, x, baseline],
    width: str.length * CH,
    height: SIZE,
    fontName: 'ABCDEF+Courier',
    dir: 'ltr',
  }
}

function link(x1: number, y1: number, x2: number, y2: number, url: string) {
  return { subtype: 'Link', url, rect: [x1, y1, x2, y2] }
}

/** A body line whose words are exactly `CH` points apart. */
function line(text: string, baseline: number) {
  return item(text, 72, baseline)
}

describe('safeLinkUrl', () => {
  it('keeps the schemes a browser navigates', () => {
    expect(safeLinkUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c')
    expect(safeLinkUrl('http://example.com')).toBe('http://example.com')
    expect(safeLinkUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    expect(safeLinkUrl('tel:+959123456')).toBe('tel:+959123456')
  })

  it('rejects anything a browser would execute or fetch as markup', () => {
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(safeLinkUrl('JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeLinkUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(safeLinkUrl('vbscript:msgbox')).toBeNull()
    // Escaping does not neutralise a scheme, so it is dropped, not repaired.
    expect(safeLinkUrl('<script>alert(1)</script>')).toBeNull()
    expect(safeLinkUrl('file:///etc/passwd')).toBeNull()
  })

  it('promotes a bare host and refuses a relative path', () => {
    expect(safeLinkUrl('www.example.org/spec')).toBe('https://www.example.org/spec')
    expect(safeLinkUrl('../../index.html')).toBeNull()
    expect(safeLinkUrl('/a/b')).toBeNull()
    expect(safeLinkUrl('#anchor')).toBeNull()
  })

  it('refuses empty, absurd or non-string values', () => {
    expect(safeLinkUrl('')).toBeNull()
    expect(safeLinkUrl('   ')).toBeNull()
    expect(safeLinkUrl(null)).toBeNull()
    expect(safeLinkUrl(42)).toBeNull()
    expect(safeLinkUrl(`https://example.com/${'a'.repeat(4000)}`)).toBeNull()
  })
})

describe('linksFromAnnotations', () => {
  it('takes only /Link annotations with a usable URI', () => {
    const links = linksFromAnnotations(
      [
        link(72, 600, 172, 620, 'https://example.com'),
        // A form field and a highlight carry rects too but are not links.
        { subtype: 'Widget', rect: [0, 0, 10, 10] },
        { subtype: 'Link', rect: [10, 10, 20, 20] }, // internal destination: no URI
        link(200, 600, 300, 620, 'data:text/html;base64,PHNjcmlwdD4='),
      ],
      PAGE_HEIGHT,
    )
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('https://example.com')
  })

  it('flips the rectangle into top-left page points', () => {
    // PDF space is bottom-left; the extractor works top-left.
    const [only] = linksFromAnnotations([link(100, 500, 200, 520, 'https://example.com')], 792)
    expect(only.bbox).toEqual({ x: 100, y: 272, w: 100, h: 20 })
  })

  it('drops a degenerate or missing rectangle', () => {
    expect(
      linksFromAnnotations(
        [{ subtype: 'Link', url: 'https://a.com', rect: [10, 10, 10, 20] }],
        792,
      ),
    ).toEqual([])
    expect(linksFromAnnotations([{ subtype: 'Link', url: 'https://a.com' }], 792)).toEqual([])
  })
})

describe('internalDestinations', () => {
  it('takes only /Link annotations carrying a destination and no URI', () => {
    const found = internalDestinations(
      [
        { subtype: 'Link', dest: 'chapter-7', rect: [72, 600, 172, 620] },
        { subtype: 'Link', dest: [1, 'XYZ', null, null, null], rect: [72, 500, 172, 520] },
        // None of these belong: not a link, no destination, has a URI the
        // PDF chose to navigate instead, or a destination that is neither a
        // name nor an array.
        { subtype: 'Widget', dest: 'chapter-7', rect: [0, 0, 10, 10] },
        { subtype: 'Link', rect: [10, 10, 20, 20] },
        {
          subtype: 'Link',
          dest: 'chapter-7',
          url: 'https://example.com',
          rect: [200, 600, 300, 620],
        },
        { subtype: 'Link', dest: 42, rect: [10, 30, 20, 40] },
      ],
      PAGE_HEIGHT,
    )
    expect(found).toHaveLength(2)
    expect(found[0].dest).toBe('chapter-7')
    expect(found[1].dest).toEqual([1, 'XYZ', null, null, null])
  })

  it('flips the rectangle into top-left page points', () => {
    const [only] = internalDestinations(
      [{ subtype: 'Link', dest: 'a', rect: [100, 500, 200, 520] }],
      792,
    )
    expect(only.bbox).toEqual({ x: 100, y: 272, w: 100, h: 20 })
  })

  it('drops a degenerate or missing rectangle', () => {
    expect(internalDestinations([{ subtype: 'Link', dest: 'a' }], 792)).toEqual([])
    expect(
      internalDestinations([{ subtype: 'Link', dest: 'a', rect: [10, 10, 10, 20] }], 792),
    ).toEqual([])
  })
})

describe('linkAnchors', () => {
  const items = [
    line('Read more at https://example.com/api now', 640),
    line('See the pricing page for details.', 614),
    line('A second line under it.', 588),
  ]
  const lines = groupItemsIntoLines(items, { pageIndex: 0, pageHeight: PAGE_HEIGHT })

  it('cuts the covered words out of a single long run', () => {
    // The line is one pdf.js item 40 glyphs wide; the rectangle covers
    // characters [13, 36) — exactly the URL.
    const x = 72 + 13 * CH
    const w = 23 * CH
    const anchors = linkAnchors(
      [
        {
          url: 'https://example.com/api',
          destPage: null,
          bbox: { x, y: PAGE_HEIGHT - 652, w, h: 20 },
        },
      ],
      lines,
      items,
    )
    expect(anchors.map((anchor) => anchor.text)).toEqual(['https://example.com/api'])
  })

  it('keeps the whole anchor when the rectangle spans several runs', () => {
    const split = [
      item('See the ', 72, 614),
      item('pricing page', 72 + 9 * CH, 614),
      item(' for details.', 72 + 21 * CH, 614),
    ]
    const splitLines = groupItemsIntoLines(split, { pageIndex: 0, pageHeight: PAGE_HEIGHT })
    const [x, w] = [72 + 9 * CH, 12 * CH]
    const anchors = linkAnchors(
      [
        {
          url: 'https://example.com/pricing',
          destPage: null,
          bbox: { x, y: PAGE_HEIGHT - 626, w, h: 20 },
        },
      ],
      splitLines,
      split,
    )
    expect(anchors.map((anchor) => anchor.text)).toEqual(['pricing page'])
  })

  it('ignores lines the rectangle does not reach, and rectangles with no text', () => {
    const only = groupItemsIntoLines([line('Read more at https://example.com/api now', 640)], {
      pageIndex: 0,
      pageHeight: PAGE_HEIGHT,
    })
    // Vertically clear of the line above.
    expect(
      linkAnchors(
        [
          {
            url: 'https://example.com',
            destPage: null,
            bbox: { x: 72, y: PAGE_HEIGHT - 626, w: 200, h: 20 },
          },
        ],
        only,
        [line('Read more at https://example.com/api now', 640)],
      ),
    ).toEqual([])
    // Horizontally clear of every glyph.
    expect(
      linkAnchors(
        [
          {
            url: 'https://example.com',
            destPage: null,
            bbox: { x: 500, y: PAGE_HEIGHT - 652, w: 60, h: 20 },
          },
        ],
        only,
        [line('Read more at https://example.com/api now', 640)],
      ),
    ).toEqual([])
  })

  it('reports one anchor per line for a rectangle that spans the break', () => {
    const twoLines = groupItemsIntoLines(
      [line('Continued onto', 640), line('the second line here.', 614)],
      { pageIndex: 0, pageHeight: PAGE_HEIGHT },
    )
    const anchors = linkAnchors(
      [
        {
          url: 'https://example.com',
          destPage: null,
          bbox: { x: 72, y: PAGE_HEIGHT - 646, w: 300, h: 46 },
        },
      ],
      twoLines,
      [line('Continued onto', 640), line('the second line here.', 614)],
    )
    expect(anchors.map((anchor) => anchor.text)).toEqual([
      'Continued onto',
      'the second line here.',
    ])
  })
})

describe('attachLinks', () => {
  function blocksOf(texts: string[]): PageBlock[] {
    const items = texts.map((text, index) => line(text, 640 - index * 26))
    return structurePage(groupItemsIntoLines(items, { pageIndex: 0, pageHeight: PAGE_HEIGHT }), {
      pageIndex: 0,
      pageWidth: 612,
      pageHeight: PAGE_HEIGHT,
    })
  }

  it('files the anchor under the block the rectangle lands in', () => {
    const blocks = blocksOf([
      'Read more at https://example.com/api now',
      'See the pricing page for details.',
    ])
    const target = blocks.find((block) => block.text.includes('pricing'))!
    attachLinks(blocks, [
      {
        text: 'pricing page',
        url: 'https://example.com/pricing',
        bbox: { x: 72 + 9 * CH, y: PAGE_HEIGHT - 626, w: 12 * CH, h: 20 },
      },
    ])
    expect(target.links).toEqual([{ text: 'pricing page', url: 'https://example.com/pricing' }])
    expect(
      blocks.filter((block) => block !== target).every((block) => block.links.length === 0),
    ).toBe(true)
  })

  it('gives every block a list and never repeats the same anchor', () => {
    const blocks = blocksOf(['Read more at https://example.com/api now'])
    const bbox = { x: 72 + 13 * CH, y: PAGE_HEIGHT - 652, w: 23 * CH, h: 20 }
    attachLinks(blocks, [
      { text: 'https://example.com/api', url: 'https://example.com/api', bbox },
      { text: 'https://example.com/api', url: 'https://example.com/api', bbox },
    ])
    expect(blocks[0].links).toHaveLength(1)
  })

  it('leaves a rectangle that only grazes a block unattached', () => {
    const blocks = blocksOf(['Read more at https://example.com/api now'])
    attachLinks(blocks, [
      {
        text: 'now',
        url: 'https://example.com',
        // One point of overlap against a 40-glyph line: nobody's link.
        bbox: { x: 311, y: PAGE_HEIGHT - 652, w: 60, h: 20 },
      },
    ])
    expect(blocks[0].links).toEqual([])
  })
})
