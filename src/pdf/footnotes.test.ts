import { describe, expect, it } from 'vitest'
import {
  FOOTNOTE_MAX_SIZE_RATIO,
  FOOTNOTE_ZONE_TOP,
  footnoteMarker,
  inFootnoteZone,
  isFootnoteStart,
  isSmallType,
  markFootnoteRegions,
  type FootnoteContext,
} from './footnotes'
import type { GroupedLine, LineStyle } from './lineGrouping'
import { lineId, type BBox } from './stableId'

const BODY: LineStyle = {
  fontFamily: 'Helvetica',
  fontSize: 10,
  bold: false,
  italic: false,
  color: '#000000',
  rotation: 0,
}

function line(text: string, bbox: BBox, style: Partial<LineStyle> = {}): GroupedLine {
  const merged = { ...BODY, ...style }
  return { id: lineId(0, bbox, text), text, bbox, style: merged, itemIndexes: [] }
}

/** A 792pt page whose body is set at 10pt — the reference every test uses. */
const CTX: FootnoteContext = { pageHeight: 792, medianSize: 10 }
const NOTE = { fontSize: 9 }
/** First y the footnote zone accepts on this page. */
const ZONE_TOP = 792 * FOOTNOTE_ZONE_TOP

describe('footnoteMarker', () => {
  it('recognises the callout forms a real note opens with', () => {
    expect(footnoteMarker('1 Smith (2001) argues')).toBe('1')
    expect(footnoteMarker('12 See the appendix')).toBe('12')
    expect(footnoteMarker('1) Smith (2001) argues')).toBe('1)')
    expect(footnoteMarker('1. Install the package')).toBe('1.')
    expect(footnoteMarker('[3] Cross-referenced above')).toBe('[3]')
    expect(footnoteMarker('(a) See Jones (2003)')).toBe('(a)')
    expect(footnoteMarker('(ii) See Jones (2003)')).toBe('(ii)')
    expect(footnoteMarker('* See Smith')).toBe('*')
    expect(footnoteMarker('** See Smith')).toBe('**')
    expect(footnoteMarker('† See Smith')).toBe('†')
    expect(footnoteMarker('၄ အောက်ပါအတိုင်း')).toBe('၄')
    expect(footnoteMarker('၂) ကြည့်ပါ')).toBe('၂)')
  })

  it('refuses text that merely begins near a marker', () => {
    expect(footnoteMarker('')).toBeNull()
    expect(footnoteMarker('   ')).toBeNull()
    expect(footnoteMarker('Figure 3 shows the result')).toBeNull()
    expect(footnoteMarker('Chapter 3 begins here')).toBeNull()
    expect(footnoteMarker('1994 The constitution')).toBeNull()
    expect(footnoteMarker('100 patients died in the arm')).toBeNull()
    expect(footnoteMarker('3.14 is the ratio we want')).toBeNull()
    expect(footnoteMarker('**bold** starts this line')).toBeNull()
    expect(footnoteMarker('(did) not a marker at all')).toBeNull()
    expect(footnoteMarker('(the result) of the test')).toBeNull()
  })
})

describe('footnote placement', () => {
  it('accepts only the lower part of a known page', () => {
    const low = line('1 See Smith', { x: 72, y: ZONE_TOP, w: 200, h: 11 }, NOTE)
    const high = line('1 See Smith', { x: 72, y: ZONE_TOP - 40, w: 200, h: 11 }, NOTE)
    expect(inFootnoteZone(low, CTX)).toBe(true)
    expect(inFootnoteZone(high, CTX)).toBe(false)
    // An unknown page height is "cannot tell", never "everywhere".
    expect(inFootnoteZone(low, { ...CTX, pageHeight: 0 })).toBe(false)
  })

  it('accepts only type set below the body size', () => {
    const small = line('1 See Smith', { x: 72, y: 600, w: 200, h: 11 }, NOTE)
    const bodySized = line('1 See Smith', { x: 72, y: 600, w: 200, h: 12 })
    expect(isSmallType(small, CTX)).toBe(true)
    expect(isSmallType(bodySized, CTX)).toBe(false)
    expect(isSmallType(small, { ...CTX, medianSize: 0 })).toBe(false)
    expect(isSmallType({ ...small, style: { ...small.style, fontSize: 0 } }, CTX)).toBe(false)
    // The boundary itself: type set to exactly the ratio still counts as a note.
    const edge = { ...small, style: { ...small.style, fontSize: 10 * FOOTNOTE_MAX_SIZE_RATIO } }
    expect(isSmallType(edge, CTX)).toBe(true)
    const justOver = {
      ...small,
      style: { ...small.style, fontSize: 10 * FOOTNOTE_MAX_SIZE_RATIO + 0.1 },
    }
    expect(isSmallType(justOver, CTX)).toBe(false)
  })

  it('requires a marker, small type and the lower zone together', () => {
    const marked = line('1 Smith (2001) argues', { x: 72, y: 600, w: 300, h: 11 }, NOTE)
    expect(isFootnoteStart(marked, CTX)).toBe(true)
    expect(isFootnoteStart({ ...marked, text: 'Smith (2001) argues' }, CTX)).toBe(false)
    expect(isFootnoteStart({ ...marked, style: { ...marked.style, fontSize: 10 } }, CTX)).toBe(
      false,
    )
    expect(isFootnoteStart({ ...marked, bbox: { ...marked.bbox, y: 300 } }, CTX)).toBe(false)
  })
})

describe('markFootnoteRegions', () => {
  const note = (text: string, y: number): GroupedLine =>
    line(text, { x: 72, y, w: 420, h: 11 }, NOTE)

  it('returns nothing for an empty page', () => {
    expect(markFootnoteRegions([], CTX).size).toBe(0)
  })

  it('marks a note opener and the unmarked lines that continue it', () => {
    const lines = [note('1 Smith (2001) argues', 640), note('that the effect persists.', 652)]
    expect([...markFootnoteRegions(lines, CTX)]).toEqual([lines[0].id, lines[1].id])
  })

  it('keeps two adjacent notes apart — each opener opens its own region', () => {
    const lines = [
      note('1 Smith (2001) argues', 640),
      note('that the effect persists.', 652),
      note('2 Jones (2003) disagrees', 670),
      note('with the reading above.', 682),
    ]
    const marked = markFootnoteRegions(lines, CTX)
    expect([...marked]).toEqual(lines.map((entry) => entry.id))
    // Both openers are marked, but never as each other's continuation: the
    // second marker is what ended the first region.
    expect(footnoteMarker(lines[1].text)).toBeNull()
    expect(footnoteMarker(lines[2].text)).toBe('2')
  })

  it('stops where the type returns to body size', () => {
    const lines = [
      note('1 Smith (2001) argues', 640),
      line('The paragraph continues here.', { x: 72, y: 652, w: 420, h: 12 }),
    ]
    expect([...markFootnoteRegions(lines, CTX)]).toEqual([lines[0].id])
  })

  it('stops at a gap wider than a note line', () => {
    const lines = [note('1 Smith (2001) argues', 640), note('A separate note far below.', 700)]
    expect([...markFootnoteRegions(lines, CTX)]).toEqual([lines[0].id])
  })

  it('stops at an indent jump', () => {
    const lines = [
      note('1 Smith (2001) argues', 640),
      line('set well to the right of the note', { x: 140, y: 652, w: 340, h: 11 }, NOTE),
    ]
    expect([...markFootnoteRegions(lines, CTX)]).toEqual([lines[0].id])
  })

  it('ignores a note-shaped line that sits above the footnote zone', () => {
    const lines = [note('1 Smith (2001) argues', 300)]
    expect(markFootnoteRegions(lines, CTX).size).toBe(0)
  })

  it('ignores a low, marked line that is not set small', () => {
    const lines = [line('1 Smith (2001) argues', { x: 72, y: 640, w: 420, h: 12 })]
    expect(markFootnoteRegions(lines, CTX).size).toBe(0)
  })

  it('ignores a three-digit count at the foot of the page', () => {
    const lines = [line('100 patients died in the arm', { x: 72, y: 640, w: 420, h: 11 }, NOTE)]
    expect(markFootnoteRegions(lines, CTX).size).toBe(0)
  })
})
