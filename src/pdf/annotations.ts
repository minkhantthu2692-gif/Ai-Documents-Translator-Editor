/**
 * Annotation notes: the text an annotation carries and the page never prints.
 *
 * A reviewed PDF keeps its marginalia in the annotation dictionary rather than
 * in the content stream. The words you can *see* — a heading, a paragraph, a
 * table cell — are show-text operators and reach the translator through the
 * normal line → block path. The words an annotation carries are not operators
 * at all:
 *
 *   - `/Contents`, the note itself: a sticky note's message, the reason a
 *     passage was highlighted, what the reviewer wrote on the callout;
 *   - a `/FreeText`'s body, which is drawn by its *appearance* stream, so a
 *     reader that only walks operators sees an empty box;
 *   - a stamp's legend.
 *
 * None of it is in the content stream, so no other pass in the pipeline —
 * grouping, reading order, footnotes, links, figures, form labels — can ever
 * translate it. This module is what does: it turns each note into an ordinary
 * `annotation` block, which means it enters the queue like any other text, is
 * editable in the workspace, and reaches every exporter with no exporter
 * knowing that review markup exists.
 *
 * Three subtypes are deliberately not read. `/Link` belongs to `links.ts`,
 * `/Widget` to `formFields.ts` — and `/Popup` is the window a viewer opens to
 * *display* its parent's `/Contents`, so reading it would print the same note
 * twice, once at a rectangle that is a viewer artefact. A note whose author
 * (`/T`) or date (`/M`) is recorded is deliberately *not* prefixed with either:
 * a name is not for translating. An annotation with nothing to say, or one the
 * author hid behind `/F 2`, yields no block. Nothing here ever removes or
 * rewrites printed text.
 */

import { rectToBBox } from './links'
import { tokenizePlaceholders } from './placeholders'
import { classifyLine } from './skipRules'
import { blockId, lineId, type BBox } from './stableId'
import type { LineStyle } from './lineGrouping'
import type { BlockLine, PageBlock } from './structure'
import { insertIndex, type AttachFieldOptions } from './formFields'

/**
 * What a note is printed in, in every format.
 *
 * The same grey and italic a form label gets: a second voice on the page, not
 * the page's own, so a reader can tell it from text the PDF actually printed.
 */
const NOTE_COLOR = '#6b7280'

/**
 * Average advance of one glyph, in em.
 *
 * A little over the Latin ~0.5 on purpose. Wrapping with this makes a line the
 * estimate says fits come back a character *shorter* than the box rather than
 * a character wider: an extra line costs a couple of points of empty space, a
 * line too long costs an overlap with whatever the note sits above.
 */
const CHAR_EM = 0.6

/**
 * The annotations this pass reads.
 *
 * Declared structurally rather than imported from `pdfExtract.ts`: that module
 * is the caller, and a value import in one direction plus a type import in the
 * other is a cycle lint has to be told about. `AnnotationLike` satisfies this
 * as it stands.
 */
export interface NoteAnnotation {
  subtype?: string
  /** pdf.js's parse of `/Contents`: `{ str, dir }`. */
  contentsObj?: { str?: string; dir?: string } | null
  /** `/Contents`, for a producer that hands the string over as-is. */
  contents?: string
  /** `/F` — the annotation flags: 0x02 is "hidden". */
  annotationFlags?: number
  /** Set by pdf.js on widgets; read here for completeness. */
  hidden?: boolean
  /** PDF rectangle, bottom-left origin. */
  rect?: number[]
  /** `/QuadPoints` — eight numbers, for markup drawn without a `/Rect`. */
  quadPoints?: number[]
}

/** One note's text and the rectangle it points at. */
export interface AnnotationNote {
  /** What the note is about, top-left origin, page points. */
  anchor: BBox
  /** What the translator sees: `/Contents`, verbatim. */
  text: string
}

/**
 * Handled by another pass, or a viewer artefact carrying the same words.
 *
 * `subtype === undefined` is skipped too: pdf.js always fills it in, and a
 * note with no subtype is one this pass cannot tell from a widget — taking it
 * would risk reading a field's text twice.
 */
const HANDLED: ReadonlySet<string> = new Set(['Link', 'Widget', 'Popup'])

/**
 * Every annotation on a page that has something to translate, in annotation
 * order.
 *
 * Annotation order rather than reading order on purpose: where each one lands
 * is decided against the block list later, and two notes in the same gap must
 * keep the order the PDF declared them in.
 */
export function annotationNotes(
  annotations: ReadonlyArray<NoteAnnotation> | undefined,
  pageHeight: number,
): AnnotationNote[] {
  if (annotations === undefined || annotations.length === 0) return []
  const notes: AnnotationNote[] = []
  const seen = new Set<string>()
  for (const annotation of annotations) {
    const note = noteOf(annotation, pageHeight)
    if (note === null) continue
    // A markup annotation and its popup carry the same words at two
    // rectangles, and a document with two identical sticky notes is one note
    // drawn twice. One block, one id, one queue row.
    const key = `${note.anchor.x},${note.anchor.y},${note.anchor.w},${note.anchor.h},${note.text}`
    if (seen.has(key)) continue
    seen.add(key)
    notes.push(note)
  }
  return notes
}

function noteOf(annotation: NoteAnnotation, pageHeight: number): AnnotationNote | null {
  const subtype = annotation.subtype
  if (subtype === undefined || HANDLED.has(subtype)) return null
  if (isHidden(annotation)) return null
  const text = contentsOf(annotation).trim()
  if (text.length === 0) return null
  const anchor =
    rectToBBox(annotation.rect, pageHeight) ?? quadBBox(annotation.quadPoints, pageHeight)
  if (anchor === null) return null
  return { anchor, text }
}

/**
 * What the note says.
 *
 * pdf.js parses `/Contents` into `contentsObj` — `{ str, dir }` — for every
 * annotation, and hands the raw string over only for the subtypes where
 * nothing needed parsing. Both are read, because the note is the whole point
 * of this pass and a producer that says it differently must not make it
 * disappear.
 */
function contentsOf(annotation: NoteAnnotation): string {
  const str = annotation.contentsObj?.str
  return typeof str === 'string' ? str : (annotation.contents ?? '')
}

/** `AnnotationFlag.HIDDEN` — shown to nobody, announced to nobody. */
const HIDDEN_FLAG = 0x02

/**
 * The hidden bit of `/F`.
 *
 * pdf.js sets `hidden` itself on widgets, where it also walks the AcroForm;
 * everywhere else the reader has to take it off `annotationFlags`, which is
 * the flag word the spec defines. Either one is enough.
 */
function isHidden(annotation: NoteAnnotation): boolean {
  if (annotation.hidden === true) return true
  return ((annotation.annotationFlags ?? 0) & HIDDEN_FLAG) !== 0
}

/** `/QuadPoints` → the same top-left box `/Rect` would give, or nothing. */
function quadBBox(points: number[] | undefined, pageHeight: number): BBox | null {
  if (points === undefined || points.length < 8) return null
  const xs: number[] = []
  const ys: number[] = []
  for (let index = 0; index + 1 < points.length; index += 2) {
    const x = points[index]
    const y = points[index + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    xs.push(x)
    ys.push(y)
  }
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const bottom = Math.min(...ys)
  const top = Math.max(...ys)
  const box: BBox = { x: left, y: pageHeight - top, w: right - left, h: top - bottom }
  return box.w > 0 && box.h > 0 ? box : null
}

/** Placement context — the same page geometry a form label is filed with. */
export type AttachNoteOptions = AttachFieldOptions

/**
 * Places one `annotation` block per note into the page's reading order.
 *
 * The blocks above have already been grouped, ordered, linked, anchored and
 * given their field labels, so this runs **after every one of them**: a note
 * must never become the paragraph a `/Link` wraps, the neighbour a figure is
 * paired with, or the label a widget is filed beside — and printed text is
 * never re-merged because a note appeared over it.
 *
 * Returns the same array untouched when there is nothing to add, so a document
 * nobody has reviewed takes no cost at all.
 */
export function attachAnnotationNotes(
  blocks: PageBlock[],
  notes: readonly AnnotationNote[],
  options: AttachNoteOptions,
): PageBlock[] {
  if (notes.length === 0) return blocks

  // Slots are computed against the *original* array, so two notes in the same
  // gap cannot displace each other's anchor.
  const slots = new Map<number, FiledNote[]>()
  for (const note of notes) {
    const owner = ownerOf(blocks, note.anchor)
    const index = owner === null ? insertIndex(blocks, note.anchor) : owner + 1
    const filed: FiledNote = { note, owner: owner === null ? undefined : blocks[owner] }
    const bucket = slots.get(index)
    if (bucket === undefined) slots.set(index, [filed])
    else bucket.push(filed)
  }

  const merged: PageBlock[] = []
  for (let index = 0; index <= blocks.length; index += 1) {
    const styleFrom = index > 0 ? blocks[index - 1] : blocks[0]
    for (const filed of slots.get(index) ?? []) {
      merged.push(noteBlock(filed.note, options, styleFrom, filed.owner))
    }
    if (index < blocks.length) merged.push(blocks[index])
  }
  merged.forEach((block, index) => {
    block.order = index
  })
  return merged
}

/** A note, plus the block it is about when it has one. */
interface FiledNote {
  note: AnnotationNote
  owner: PageBlock | undefined
}

function overlap(a: number, aSize: number, b: number, bSize: number): number {
  return Math.max(0, Math.min(a + aSize, b + bSize) - Math.max(a, b))
}

/**
 * The block a note is about: the index of the one covering most of its
 * rectangle, or `null` when it is about none of them.
 *
 * This decides both *where* the note is filed and *what box it draws in*. A
 * note belongs to the text it marks: a highlight's rectangle lies straight
 * over the passage it annotates, so the note goes **after that block**, at the
 * block's own depth — filed by position instead it would land between two
 * lines of the very paragraph it is about, in a gap two points high. A note
 * with no block under it — a sticky note parked in the margin, a stamp in the
 * corner — belongs to its row, which `insertIndex` decides by shared vertical
 * space and, above all, by column.
 *
 * The block has to cover at least 30% of the note to count, the same bargain
 * `links.ts` makes when it files an anchor — a margin note that grazes the
 * corner of a paragraph is beside that paragraph, not about it.
 */
function ownerOf(blocks: readonly PageBlock[], anchor: BBox): number | null {
  const anchorArea = anchor.w * anchor.h
  if (anchorArea <= 0) return null
  let best: { index: number; area: number } | null = null
  for (let index = 0; index < blocks.length; index += 1) {
    const box = blocks[index].bbox
    const area =
      overlap(box.x, box.w, anchor.x, anchor.w) * overlap(box.y, box.h, anchor.y, anchor.h)
    if (area <= 0 || area < 0.3 * anchorArea) continue
    // Strict `>` keeps the earliest block on a tie, so the answer never
    // depends on how the page happened to be ordered.
    if (best === null || area > best.area) best = { index, area }
  }
  return best === null ? null : best.index
}

/**
 * Builds one block from a note's words.
 *
 * A note filed after the block it marks takes that block's column — the same
 * `x` and the same `w` — so it reads as a remark under the passage and wraps
 * where the passage wraps. A note with no block to follow keeps its own
 * rectangle, hanging **under** it the way a form label hangs under its widget:
 * the rectangle is where the reviewer put it, and printing across it would put
 * the note on top of whatever the icon was pointing at.
 *
 * The width is only ever *narrowed* by wrapping: a note whose longest line
 * already fits is left alone, exactly like a form label, and only one that
 * would run past its column or off the page edge is broken into lines. Both
 * the width and the break points are estimates — no measurer exists this
 * early — and an estimate that is a little generous costs a line of empty
 * space rather than an overlap, which is the trade `CHAR_EM` is set for.
 *
 * The face and the size come from the block it follows so it reads as part of
 * the passage it belongs to; the italic and the grey are the one thing set
 * deliberately, because this text was never printed and a reader has to be
 * able to tell it apart from text that was.
 */
function noteBlock(
  note: AnnotationNote,
  options: AttachNoteOptions,
  styleFrom: PageBlock | undefined,
  owner: PageBlock | undefined,
): PageBlock {
  const fontSize = styleFrom?.fontSize ?? 10
  const fontFamily = styleFrom?.fontFamily ?? 'sans-serif'
  const color = NOTE_COLOR
  const pitch = Math.max(9, Math.round(fontSize * 1.35 * 10) / 10)

  const room = Math.max(48, options.pageWidth - note.anchor.x - 12)
  const width =
    owner !== undefined
      ? owner.bbox.w
      : Math.min(Math.max(note.anchor.w, measure(note.text, fontSize)), room)
  const content = wrap(note.text, width, fontSize)
  const h = pitch * content.length

  // Under whatever it hangs from — the block it marks, or its own rectangle —
  // and above the bottom of the page, which is the one line no exporter can
  // cross. A form label's answer when there is no room is to flip above its
  // widget; a note's is to move up along the passage instead, because above a
  // passage it marks would land it *on* the passage.
  const below = owner !== undefined ? owner.bbox.y + owner.bbox.h : note.anchor.y + note.anchor.h
  const y =
    below + h <= options.pageHeight
      ? below
      : owner !== undefined
        ? Math.max(0, options.pageHeight - h)
        : Math.max(0, note.anchor.y - h)
  const x = owner !== undefined ? owner.bbox.x : note.anchor.x
  const bbox: BBox = { x, y, w: width, h }

  const style: LineStyle = {
    fontFamily,
    fontSize,
    bold: false,
    italic: true,
    color,
    rotation: 0,
  }
  const lines: BlockLine[] = content.map((line, index) => {
    const box: BBox = { x: bbox.x, y: bbox.y + index * pitch, w: bbox.w, h: pitch }
    return { id: lineId(options.pageIndex, box, line), text: line, bbox: box, style }
  })

  // The same two calls `structurePage` makes for every other block: a note is
  // text like any other, so it gets the same skip rules and the same
  // placeholder tokenisation rather than a privileged path to the model.
  const decision = classifyLine(note.text.replace(/\n/g, ' ').trim(), options.ctx ?? {})
  const tokenized = tokenizePlaceholders(note.text)

  return {
    id: blockId(options.pageIndex, bbox, note.text),
    kind: 'annotation',
    region: 'body',
    order: 0,
    text: note.text,
    bbox,
    lines,
    alignment: 'left',
    skipRule: decision.skip ? decision.rule : null,
    placeholders: tokenized.placeholders,
    listMarker: null,
    tableCells: null,
    headingLevel: null,
    links: [],
    figures: [],
    lineSpacing: Math.max(1, Math.round((pitch / fontSize) * 100) / 100),
    fontFamily,
    fontSize,
    bold: false,
    italic: true,
    color,
  }
}

/** Width the longest line of `text` would take at `fontSize`. */
function measure(text: string, fontSize: number): number {
  const longest = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
  return Math.ceil(longest * fontSize * CHAR_EM) + 6
}

/**
 * Breaks each paragraph line down to `width`, on word boundaries.
 *
 * Lines that already fit come back untouched, so this is a no-op for the
 * ordinary note and only the one that would overflow is cut. A word longer
 * than the whole line — a URL in a note — is cut hard rather than left to run
 * past the box.
 */
function wrap(text: string, width: number, fontSize: number): string[] {
  // Never 0: a degenerate width must cost lines, not stall the loop below.
  const perLine = Math.max(1, Math.floor(width / (Math.max(fontSize, 1) * CHAR_EM)))
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= perLine) {
      out.push(paragraph)
      continue
    }
    let current = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current.length === 0 ? word : `${current} ${word}`
      if (candidate.length <= perLine) {
        current = candidate
        continue
      }
      if (current.length > 0) out.push(current)
      if (word.length <= perLine) {
        current = word
        continue
      }
      for (let at = 0; at < word.length; at += perLine) {
        const slice = word.slice(at, at + perLine)
        if (at + perLine < word.length) out.push(slice)
        else current = slice
      }
    }
    if (current.length > 0) out.push(current)
  }
  return out.length > 0 ? out : ['']
}
