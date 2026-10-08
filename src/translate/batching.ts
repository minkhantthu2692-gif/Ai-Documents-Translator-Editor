/**
 * Batch construction.
 *
 * A page is cut into batches of at most `maxLines` lines or `maxTokens` source
 * tokens, whichever comes first — big enough to amortise the round trip, small
 * enough that a retry after a malformed response is cheap, and always small
 * enough to fit the model's window, because `maxTokens` arrives from the run's
 * `BudgetProfile` rather than from a constant.
 *
 * Batches are packed from **units**, not raw lines. A heading travels with the
 * body it introduces, a caption with the figure above it, and a run of table
 * rows or list items stays together — so a request never asks the model to
 * translate the orphaned half of a structure. A batch may only end where a unit
 * ends; a unit that cannot fit is cut at *line* boundaries, never inside one.
 *
 * Batch ids are *derived, never random*: `project#epoch#page#index`, and the
 * retry ladder produces `…#0`, `…#1`, `…#l3`, `…#s0` from a parent id. Re-running the
 * same batch therefore always targets the same lines — the property that makes
 * "rotate mid-batch with zero duplicate/missing lines" achievable.
 */

import type { BlockKind } from '@/db/types'
import { estimateTokens } from './tokenEstimate'
import type { BatchLine, TranslationBatch } from './types'

export interface BuildOptions {
  maxLines?: number
  /**
   * Content budget for one request, in estimated source tokens. The run passes
   * the model's real budget here (`BudgetProfile.fillTargetTokens`) instead of
   * the flat 1500 this module used to assume — which was simultaneously too
   * much for a free tier's TPM window and far too little for a big-context
   * model, where timid batches multiply the request count.
   */
  maxTokens?: number
}

export const BATCH_DEFAULTS: Required<BuildOptions> = {
  maxLines: 25,
  maxTokens: 1500,
}

/** Kinds where consecutive blocks are one structure, not a sequence. */
const RUN_KINDS: readonly BlockKind[] = ['table', 'list']

function batchId(projectId: string, epoch: number, pageIndex: number, index: number): string {
  return `${projectId}#${epoch}#${pageIndex}#${index}`
}

export function tokensOf(lines: BatchLine[]): number {
  return lines.reduce((sum, line) => sum + estimateTokens(line.text), 0)
}

function makeBatch(
  id: string,
  pageIndex: number,
  index: number,
  lines: BatchLine[],
): TranslationBatch {
  return {
    id,
    pageIndex,
    index,
    lines,
    tokens: tokensOf(lines),
  }
}

/**
 * Groups lines into the structures the packer must not cut across.
 *
 * - a `heading` binds **forward**: the next line joins it, so the title and its
 *   body are translated in one request and the model knows which section it is
 *   working on;
 * - a `caption` binds **backward**: it joins the figure/table it labels;
 * - consecutive `table` rows and `list` items form one run.
 *
 * Everything else is its own unit. Reading order is never changed.
 */
export function buildUnits(lines: BatchLine[]): BatchLine[][] {
  const units: BatchLine[][] = []
  /** The line just placed was a heading — the next one belongs to it. */
  let headingOpen = false

  for (const line of lines) {
    const previous = units[units.length - 1]
    const joinsPrevious =
      previous !== undefined &&
      (headingOpen ||
        line.kind === 'caption' ||
        (line.kind === previous[previous.length - 1].kind && RUN_KINDS.includes(line.kind)))

    if (joinsPrevious) previous.push(line)
    else units.push([line])

    headingOpen = line.kind === 'heading'
  }
  return units
}

/**
 * Cuts a unit that cannot fit in one request at **line** boundaries.
 *
 * Never inside a line: half a sentence is worse than the oversized request it
 * replaces, and a line that alone exceeds the budget has nothing to split
 * against here — the retry ladder owns that case.
 */
function subdivide(unit: BatchLine[], maxLines: number, maxTokens: number): BatchLine[][] {
  if (unit.length <= maxLines && tokensOf(unit) <= maxTokens) return [unit]

  const pieces: BatchLine[][] = []
  let current: BatchLine[] = []
  let tokens = 0

  for (const line of unit) {
    const lineTokens = estimateTokens(line.text)
    if (current.length > 0 && (current.length >= maxLines || tokens + lineTokens > maxTokens)) {
      pieces.push(current)
      current = []
      tokens = 0
    }
    current.push(line)
    tokens += lineTokens
  }
  if (current.length > 0) pieces.push(current)
  return pieces
}

/** Splits one page's lines into batches (never reordering them). */
export function buildBatches(
  projectId: string,
  epoch: number,
  pageIndex: number,
  lines: BatchLine[],
  options: BuildOptions = {},
): TranslationBatch[] {
  const { maxLines, maxTokens } = { ...BATCH_DEFAULTS, ...options }
  const pieces = buildUnits(lines).flatMap((unit) => subdivide(unit, maxLines, maxTokens))

  const batches: TranslationBatch[] = []
  let current: BatchLine[] = []
  let tokens = 0

  const flush = (): void => {
    if (current.length === 0) return
    batches.push(
      makeBatch(
        batchId(projectId, epoch, pageIndex, batches.length),
        pageIndex,
        batches.length,
        current,
      ),
    )
    current = []
    tokens = 0
  }

  for (const piece of pieces) {
    const pieceTokens = tokensOf(piece)
    // A batch may only end on a piece boundary — crossing one would strand a
    // heading from its body or cut a table between two rows. `maxTokens` stays
    // a hard budget: letting a batch overshoot it was the Phase A root cause.
    if (
      current.length > 0 &&
      (current.length + piece.length > maxLines || tokens + pieceTokens > maxTokens)
    ) {
      flush()
    }
    current.push(...piece)
    tokens += pieceTokens
  }
  flush()
  return batches
}

/** The retry ladder: a batch that failed validation is halved first. */
export function splitBatch(batch: TranslationBatch): TranslationBatch[] {
  if (batch.lines.length < 2) return []
  const middle = Math.ceil(batch.lines.length / 2)
  return [
    makeBatch(`${batch.id}#0`, batch.pageIndex, batch.index, batch.lines.slice(0, middle)),
    makeBatch(`${batch.id}#1`, batch.pageIndex, batch.index, batch.lines.slice(middle)),
  ]
}

/** Last resort of the ladder: one line per request, ids stay derived. */
export function splitToLines(batch: TranslationBatch): TranslationBatch[] {
  return batch.lines.map((line, position) =>
    makeBatch(`${batch.id}#l${position}`, batch.pageIndex, batch.index, [line]),
  )
}

/** A line rescued by cutting it along its own structure. */
export interface LineSplit {
  /** The line being rescued — its id is what the queue will persist under. */
  parent: BatchLine
  /** Fragments in source order, ids derived as `${parentId}#s${n}`. */
  lines: BatchLine[]
  /** Joins the fragment results back into one translation of `parent`. */
  separator: string
  /** The batch the ladder requests next. */
  batch: TranslationBatch
}

const SENTENCE_BOUNDARY = /([.!?。！？]+["'”’)\]]*\s+)/

/**
 * Splits prose at sentence boundaries, keeping each terminator with the
 * sentence it closes. Requires whitespace after the terminator, so `3.14` and
 * `A.B` are left alone; a line with no sentence ends is not a candidate.
 */
function proseParts(text: string): string[] {
  const segments = text.split(SENTENCE_BOUNDARY)
  const parts: string[] = []
  for (let index = 0; index < segments.length; index += 2) {
    const chunk = `${segments[index]}${segments[index + 1] ?? ''}`.trim()
    if (chunk.length > 0) parts.push(chunk)
  }
  return parts
}

/**
 * The ladder's last resort for a single line: cut it along the boundaries its
 * own structure implies — table rows and list items at their newlines, prose at
 * sentence ends — so a very large block the model keeps answering badly can be
 * rescued in pieces instead of silently keeping its source text.
 *
 * Returns `null` when the line is already atomic, which is the normal case and
 * keeps the existing "keep the original" terminal untouched. The fragments are
 * contiguous slices of `text`; joining their results with `separator` rebuilds
 * the line, so nothing is invented, dropped or reordered.
 */
export function splitLineForRetry(batch: TranslationBatch): LineSplit | null {
  if (batch.lines.length !== 1) return null
  const parent = batch.lines[0]

  const byRow = parent.kind === 'table' || parent.kind === 'list'
  const separator = byRow ? '\n' : ' '
  const parts = (byRow ? parent.text.split('\n') : proseParts(parent.text))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (parts.length < 2) return null

  const lines: BatchLine[] = parts.map((text, index) => ({
    ...parent,
    id: `${parent.id}#s${index}`,
    text,
    // Only placeholders that occur in *this* fragment: the rest belong to
    // siblings, and reporting them as dropped would be a lie.
    placeholders: parent.placeholders.filter((placeholder) => text.includes(placeholder.token)),
  }))

  return {
    parent,
    separator,
    lines,
    batch: {
      id: `${batch.id}#s`,
      pageIndex: batch.pageIndex,
      index: batch.index,
      lines,
      tokens: tokensOf(lines),
    },
  }
}

/** Total lines across a set of batches (progress reporting). */
export function countLines(batches: TranslationBatch[]): number {
  return batches.reduce((sum, batch) => sum + batch.lines.length, 0)
}
