/**
 * Annotation notes.
 *
 * Three things are tested separately because they fail differently: which
 * annotations say something is a reading of the PDF spec, where a note lands is
 * geometry — and the two are decided by different rules on purpose — and what
 * the block looks like is a presentation decision every exporter inherits.
 * `pdfExtract.test.ts` then drives the whole thing against
 * `fixtures/annotations.pdf`, which is written by hand so every rectangle in
 * it is exact.
 */
import { describe, expect, it } from 'vitest'
import { annotationNotes, attachAnnotationNotes, type AnnotationNote } from './annotations'
import type { BBox } from './stableId'
import type { PageBlock } from './structure'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

function block(order: number, text: string, bbox: BBox, extra: Partial<PageBlock> = {}): PageBlock {
  return {
    id: `block-${order}`,
    kind: 'paragraph',
    region: 'body',
    order,
    text,
    bbox,
    lines: [],
    alignment: 'left',
    skipRule: null,
    placeholders: [],
    listMarker: null,
    tableCells: null,
    tableSpans: null,
    headingLevel: null,
    links: [],
    figures: [],
    lineSpacing: 1.4,
    fontFamily: 'Helvetica',
    fontSize: 10,
    bold: false,
    italic: false,
    color: '#000000',
    ...extra,
  }
}

const attach = (blocks: PageBlock[], notes: AnnotationNote[]) =>
  attachAnnotationNotes(blocks, notes, {
    pageIndex: 0,
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
  })

describe('annotationNotes', () => {
  it("reads a note's /Contents and flips its rectangle into page space", () => {
    const notes = annotationNotes(
      [
        {
          subtype: 'Highlight',
          contents: 'Confirm this against the ledger.',
          rect: [70, 655, 350, 669],
        },
      ],
      PAGE_HEIGHT,
    )
    expect(notes).toHaveLength(1)
    // PDF rects are bottom-left origin: 792 − 669 = 123, 792 − 655 = 137.
    expect(notes[0].anchor).toEqual({ x: 70, y: 123, w: 280, h: 14 })
    expect(notes[0].text).toBe('Confirm this against the ledger.')
  })

  it('falls back to /QuadPoints when the annotation carries no /Rect', () => {
    const notes = annotationNotes(
      [
        {
          subtype: 'Highlight',
          contents: 'Marked.',
          quadPoints: [70, 655, 70, 669, 350, 669, 350, 655],
        },
      ],
      PAGE_HEIGHT,
    )
    expect(notes).toHaveLength(1)
    expect(notes[0].anchor).toEqual({ x: 70, y: 123, w: 280, h: 14 })
  })

  it('leaves a link, a widget and a popup to the passes that own them', () => {
    const notes = annotationNotes(
      [
        { subtype: 'Link', contents: 'A link that also talks.', rect: [70, 655, 350, 669] },
        { subtype: 'Widget', contents: 'The label of a field.', rect: [70, 600, 350, 620] },
        // The popup repeats its parent's words at a *different* rectangle, so
        // only the subtype keeps it from printing the note twice.
        { subtype: 'Popup', contents: 'The highlight says this.', rect: [70, 540, 350, 640] },
        { subtype: 'Text', contents: '', rect: [70, 500, 86, 516] },
        { subtype: 'Text', rect: [70, 480, 86, 496] },
        { subtype: 'Text', contents: '   ', rect: [70, 460, 86, 476] },
        { contents: 'No subtype at all.', rect: [70, 440, 86, 456] },
        {
          subtype: 'Text',
          contents: 'Nobody is meant to see this.',
          rect: [70, 420, 86, 436],
          hidden: true,
        },
        {
          subtype: 'Highlight',
          contentsObj: { str: 'Hidden behind the flag word.', dir: 'ltr' },
          annotationFlags: 2,
          rect: [70, 400, 300, 416],
        },
        { subtype: 'Text', contents: 'Nowhere to put it.' },
      ],
      PAGE_HEIGHT,
    )
    expect(notes).toEqual([])
  })

  it('takes /Contents out of the object pdf.js parsed it into', () => {
    const notes = annotationNotes(
      [
        {
          subtype: 'Highlight',
          contentsObj: { str: 'Confirm this against the ledger.', dir: 'ltr' },
          rect: [70, 655, 350, 669],
        },
      ],
      PAGE_HEIGHT,
    )
    expect(notes.map((note) => note.text)).toEqual(['Confirm this against the ledger.'])
  })

  it('keeps one note out of a rectangle drawn twice', () => {
    const doubled = [
      { subtype: 'Text', contents: 'Same words.', rect: [70, 600, 86, 616] },
      { subtype: 'Text', contents: 'Same words.', rect: [70, 600, 86, 616] },
    ]
    expect(annotationNotes(doubled, PAGE_HEIGHT)).toHaveLength(1)
    // Different words at the same rectangle are two notes, not one.
    expect(
      annotationNotes(
        [
          { subtype: 'Text', contents: 'Same words.', rect: [70, 600, 86, 616] },
          { subtype: 'Text', contents: 'Other words.', rect: [70, 600, 86, 616] },
        ],
        PAGE_HEIGHT,
      ),
    ).toHaveLength(2)
  })

  it('costs nothing when a page has no annotations at all', () => {
    expect(annotationNotes(undefined, PAGE_HEIGHT)).toEqual([])
    expect(annotationNotes([], PAGE_HEIGHT)).toEqual([])
  })
})

describe('attachAnnotationNotes', () => {
  const printed = () => [
    block(0, 'Revenue rose twelve percent against the quarter.', { x: 72, y: 124, w: 280, h: 25 }),
    block(1, 'Operating costs were held flat for the period.', { x: 72, y: 174, w: 280, h: 25 }),
  ]

  it('files a note after the block it marks, in that block’s column', () => {
    const merged = attach(printed(), [
      {
        anchor: { x: 70, y: 123, w: 280, h: 14 },
        text: 'Confirm this against the ledger before filing.',
      },
    ])
    expect(merged.map((entry) => entry.kind)).toEqual(['paragraph', 'annotation', 'paragraph'])
    const note = merged[1]
    // The block's own depth and the block's own width: the note reads as a
    // remark under the passage, in the same column.
    expect(note.bbox).toEqual({ x: 72, y: 149, w: 280, h: 13.5 })
    expect(note.text).toBe('Confirm this against the ledger before filing.')
    // One line, because the sentence fits the column: wrapping is what an
    // overflow costs, not what every note pays.
    expect(note.lines.map((line) => line.text)).toEqual([
      'Confirm this against the ledger before filing.',
    ])
    expect(note.italic).toBe(true)
    expect(note.color).toBe('#6b7280')
    expect(note.fontFamily).toBe('Helvetica')
    expect(note.fontSize).toBe(10)
    // Printed text is exactly where it was, in the same order.
    expect(merged.filter((entry) => entry.kind === 'paragraph').map((entry) => entry.text)).toEqual(
      [
        'Revenue rose twelve percent against the quarter.',
        'Operating costs were held flat for the period.',
      ],
    )
    expect(merged.map((entry) => entry.order)).toEqual([0, 1, 2])
  })

  it('hangs a note with no block under it at its own rectangle', () => {
    // A callout sitting in the gap between two paragraphs: nothing overlaps
    // it, so it has no block to belong to and keeps the box it was given.
    const merged = attach(printed(), [
      { anchor: { x: 72, y: 400, w: 40, h: 20 }, text: 'Call out' },
    ])
    const note = merged.find((entry) => entry.kind === 'annotation')
    expect(note?.bbox).toEqual({ x: 72, y: 420, w: 54, h: 13.5 })
    expect(note?.lines.map((line) => line.text)).toEqual(['Call out'])
    // Filed by where it sits: below both paragraphs, in the page's order.
    expect(merged.map((entry) => entry.kind)).toEqual(['paragraph', 'paragraph', 'annotation'])
  })

  it('narrows a margin note to the space there is, and wraps what will not fit', () => {
    // 560 → 608: a sticky note parked in the right margin, where the page ends
    // twelve points later. The box can only be 48 pt wide, so the sentence is
    // cut on word boundaries rather than run off the edge of the page.
    const merged = attach(printed(), [
      {
        anchor: { x: 560, y: 156, w: 16, h: 16 },
        text: 'Check this figure with the finance team.',
      },
    ])
    const note = merged.find((entry) => entry.kind === 'annotation') as PageBlock
    expect(note.bbox.x).toBe(560)
    expect(note.bbox.w).toBe(48)
    expect(note.bbox.x + note.bbox.w).toBeLessThanOrEqual(PAGE_WIDTH)
    expect(note.lines.map((line) => line.text)).toEqual([
      'Check',
      'this',
      'figure',
      'with the',
      'finance',
      'team.',
    ])
    // One line per wrapped line, so the box is as tall as the text in it.
    expect(note.bbox.h).toBe(13.5 * 6)
    // Filing it does not depend on it: it sits in the page's reading order.
    expect(merged.map((entry) => entry.kind)).toEqual(['paragraph', 'annotation', 'paragraph'])
  })

  it('flips above the rectangle when the page has no room below it', () => {
    const merged = attach(printed(), [
      { anchor: { x: 72, y: 780, w: 40, h: 10 }, text: 'Off the bottom' },
    ])
    const note = merged.find((entry) => entry.kind === 'annotation') as PageBlock
    expect(note.bbox.y + note.bbox.h).toBeLessThanOrEqual(PAGE_HEIGHT)
    expect(note.bbox.y).toBe(780 - note.bbox.h)
  })

  it('leaves the page alone when nobody has reviewed it', () => {
    const blocks = printed()
    expect(attach(blocks, [])).toBe(blocks)
    expect(blocks.map((entry) => entry.order)).toEqual([0, 1])
  })

  it('keeps two notes in the same gap in the order the PDF declared them', () => {
    const merged = attach(printed(), [
      { anchor: { x: 72, y: 400, w: 40, h: 20 }, text: 'First note.' },
      { anchor: { x: 72, y: 402, w: 40, h: 20 }, text: 'Second note.' },
    ])
    expect(
      merged.filter((entry) => entry.kind === 'annotation').map((entry) => entry.text),
    ).toEqual(['First note.', 'Second note.'])
    expect(merged.map((entry) => entry.order)).toEqual([0, 1, 2, 3])
  })
})
