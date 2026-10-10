/**
 * Form-field labels: the text a widget carries and the page never prints.
 *
 * A fillable PDF keeps its instructions in two different places. The words you
 * can *see* — `Full Name:`, `Country:` — are ordinary content-stream text and
 * reach the translator through the normal line → block path with nothing done
 * to them at all. The words you cannot see live on the widget itself:
 *
 *   - `/TU`, the alternate field name, is what a screen reader announces and
 *     what a tooltip shows;
 *   - `/Opt`, a choice field's option captions, are the things a reader picks
 *     from, and they are printed nowhere on the page.
 *
 * Neither string is in the content stream, so no other pass in the pipeline —
 * grouping, reading order, footnotes, links, figures — can ever translate them.
 * This module is what does: it turns both into ordinary `form-field` blocks,
 * which means they enter the queue like any other text, are editable in the
 * workspace, and reach every exporter with no exporter knowing about forms.
 *
 * A widget with nothing to say yields no block: a bare push button, a hidden
 * field, a text box that was never described, a radio kid whose label lives on
 * its group. Nothing here ever *removes* or rewrites printed text.
 */

import { rectToBBox } from './links'
import { tokenizePlaceholders } from './placeholders'
import { classifyLine, type SkipContext } from './skipRules'
import { blockId, lineId, type BBox } from './stableId'
import type { LineStyle } from './lineGrouping'
import type { BlockLine, PageBlock } from './structure'

/**
 * What a field description is printed in, in every format.
 *
 * The same grey the flow stylesheet already uses for a bilingual document's
 * source column — this is a second voice on the page, not the page's own.
 */
const FIELD_COLOR = '#6b7280'

/**
 * The annotation fields this pass reads.
 *
 * Declared structurally rather than imported from `pdfExtract.ts`: that module
 * is the caller, and a value import in one direction plus a type import in the
 * other is a cycle lint has to be told about. `AnnotationLike` satisfies this
 * as it stands.
 */
export interface FieldAnnotation {
  subtype?: string
  /** `/TU` — the accessible name. */
  alternativeText?: string
  /** `/F` hidden bit: never shown, never announced. */
  hidden?: boolean
  /** `/Opt` — a choice field's captions, in document order. */
  options?: ReadonlyArray<{ exportValue?: string; displayValue?: string } | null | undefined> | null
  /** PDF rectangle, bottom-left origin. */
  rect?: number[]
}

/** One widget's translatable text and where the widget sits. */
export interface FieldLabel {
  /** The widget's own rectangle, top-left origin, page points. */
  widget: BBox
  /** What the translator sees: the `/TU` description, then any option captions. */
  text: string
}

/**
 * Every widget on a page that has something to translate, in annotation order.
 *
 * Annotation order rather than reading order on purpose: where each one lands
 * is decided against the block list later, and two labels in the same gap must
 * keep the order the PDF declared them in.
 */
export function fieldLabels(
  annotations: ReadonlyArray<FieldAnnotation> | undefined,
  pageHeight: number,
): FieldLabel[] {
  if (annotations === undefined || annotations.length === 0) return []
  const labels: FieldLabel[] = []
  const seen = new Set<string>()
  for (const annotation of annotations) {
    const label = fieldLabelOf(annotation, pageHeight)
    if (label === null) continue
    // Two widgets at the same rectangle carrying the same words are the same
    // field drawn twice (templates do this); one block, one id, one queue row.
    const key = `${label.widget.x},${label.widget.y},${label.widget.w},${label.widget.h},${label.text}`
    if (seen.has(key)) continue
    seen.add(key)
    labels.push(label)
  }
  return labels
}

function fieldLabelOf(annotation: FieldAnnotation, pageHeight: number): FieldLabel | null {
  // Only widgets are fields. `/Link` rectangles belong to `links.ts`, and no
  // other subtype carries a string worth translating.
  if (annotation.subtype !== undefined && annotation.subtype !== 'Widget') return null
  // A hidden field is shown to nobody and announced to nobody: its `/TU` is a
  // note the form's designer left for themselves, not content.
  if (annotation.hidden === true) return null
  const widget = rectToBBox(annotation.rect, pageHeight)
  if (widget === null) return null

  const lines: string[] = []
  const description = (annotation.alternativeText ?? '').trim()
  if (description.length > 0) lines.push(description)
  for (const option of annotation.options ?? []) {
    const caption = (option?.displayValue ?? '').trim()
    if (caption.length > 0) lines.push(caption)
  }
  const text = lines.join('\n')
  return text.length > 0 ? { widget, text } : null
}

export interface AttachFieldOptions {
  pageIndex: number
  pageWidth: number
  pageHeight: number
  ctx?: SkipContext | undefined
}

/**
 * Places one `form-field` block per label into the page's reading order.
 *
 * The blocks above have already been grouped, ordered, linked and anchored, so
 * this runs **after** every one of them: a field description must never become
 * the paragraph a `/Link` wraps or the neighbour a figure is paired with, and
 * printed text is never re-merged because a widget appeared beside it.
 *
 * Returns the same array untouched when there is nothing to add, so a document
 * with no forms takes no cost at all.
 */
export function attachFieldLabels(
  blocks: PageBlock[],
  labels: readonly FieldLabel[],
  options: AttachFieldOptions,
): PageBlock[] {
  if (labels.length === 0) return blocks

  // Slots are computed against the *original* array, so two labels in the same
  // gap cannot displace each other's anchor.
  const slots = new Map<number, FieldLabel[]>()
  for (const label of labels) {
    const index = insertIndex(blocks, label.widget)
    const bucket = slots.get(index)
    if (bucket === undefined) slots.set(index, [label])
    else bucket.push(label)
  }

  const merged: PageBlock[] = []
  for (let index = 0; index <= blocks.length; index += 1) {
    const styleFrom = index > 0 ? blocks[index - 1] : blocks[0]
    for (const label of slots.get(index) ?? []) {
      merged.push(fieldBlock(label, options, styleFrom))
    }
    if (index < blocks.length) merged.push(blocks[index])
  }
  merged.forEach((block, index) => {
    block.order = index
  })
  return merged
}

function overlap(a: number, aSize: number, b: number, bSize: number): number {
  return Math.max(0, Math.min(a + aSize, b + bSize) - Math.max(a, b))
}

/**
 * Reading-order slot for one widget: the index it is *inserted at*, so
 * `blocks[index - 1]` is the block it follows.
 *
 * A widget belongs to the row it sits in, which is decided by shared vertical
 * space rather than by centre — a label and its box are the same row even when
 * the label is drawn well above the box's middle. Between several candidates
 * the **same column** wins first: on a two-column page the block nearest by
 * `y` alone is routinely a whole column away, and a widget belongs to its own
 * column's row. When nothing shares the row at all the widget is in a gap, and
 * the first block that starts below it is where it would have been written.
 */
function insertIndex(blocks: readonly PageBlock[], widget: BBox): number {
  if (blocks.length === 0) return 0
  const midY = widget.y + widget.h / 2

  const scored = blocks
    .map((block, index) => ({
      index,
      v: overlap(block.bbox.y, block.bbox.h, widget.y, widget.h),
      h: overlap(block.bbox.x, block.bbox.w, widget.x, widget.w),
    }))
    .filter((entry) => entry.v > 0)
  const column = scored.filter((entry) => entry.h > 0)
  const pool = column.length > 0 ? column : scored
  // Strict `>` keeps the earliest index on a tie, so the answer never depends
  // on how the page happened to be ordered.
  const best = pool.reduce<Field | null>(
    (winner, entry) => (winner === null || entry.v > winner.v ? entry : winner),
    null,
  )

  if (best === null) {
    for (let index = 0; index < blocks.length; index += 1) {
      const bbox = blocks[index].bbox
      if (bbox.y + bbox.h / 2 > midY) return index
    }
    return blocks.length
  }
  const anchor = blocks[best.index].bbox
  return anchor.y + anchor.h / 2 > midY ? best.index : best.index + 1
}

type Field = { index: number; v: number; h: number }

/**
 * Builds one block from a widget's words.
 *
 * The box hangs **under** its own widget rather than inside it: a widget is an
 * empty rectangle the description would otherwise be printed across, and a
 * 12 pt checkbox beside its caption would put the description straight through
 * the caption already on the page. The face and the size come from the block it
 * follows so it reads as part of the row it belongs to; the italic and the grey
 * are the one thing set deliberately, because this text was never printed and a
 * reader has to be able to tell it apart from text that was — otherwise the
 * description looks like a second, clumsier copy of the label beside it.
 *
 * The width grows to fit the longest line and the height to fit every line, so
 * a dropdown's option captions do not wrap inside a 16 pt box. Both are
 * estimates — no measurer exists this early — and an estimate that is a little
 * wide only means the text declines to wrap where it could have. When the page
 * has no room below the widget the box goes above it instead of off the page.
 */
function fieldBlock(
  label: FieldLabel,
  options: AttachFieldOptions,
  styleFrom: PageBlock | undefined,
): PageBlock {
  const text = label.text
  const content = text.split('\n')
  const fontSize = styleFrom?.fontSize ?? 10
  const fontFamily = styleFrom?.fontFamily ?? 'sans-serif'
  // Grey, never the page's own colour: every exporter paints on white, and a
  // description the same colour as the label beside it reads as a duplicate
  // rather than as the tooltip it is.
  const color = FIELD_COLOR
  const pitch = Math.max(9, Math.round(fontSize * 1.35 * 10) / 10)
  const longest = content.reduce((max, line) => Math.max(max, line.length), 0)
  const measured = Math.ceil(longest * fontSize * 0.55) + 6
  const room = Math.max(48, options.pageWidth - label.widget.x - 12)
  const w = Math.min(Math.max(label.widget.w, measured), room)
  const h = pitch * content.length

  const below = label.widget.y + label.widget.h
  const y = below + h <= options.pageHeight ? below : Math.max(0, label.widget.y - h)
  const bbox: BBox = { x: label.widget.x, y, w, h }

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

  // The same two calls `structurePage` makes for every other block: a `/TU` is
  // text like any other, so it gets the same skip rules and the same
  // placeholder tokenisation rather than a privileged path to the model.
  const decision = classifyLine(text.replace(/\n/g, ' ').trim(), options.ctx ?? {})
  const tokenized = tokenizePlaceholders(text)

  return {
    id: blockId(options.pageIndex, bbox, text),
    kind: 'form-field',
    region: 'body',
    order: 0,
    text,
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
