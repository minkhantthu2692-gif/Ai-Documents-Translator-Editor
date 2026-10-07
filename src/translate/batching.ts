/**
 * Batch construction.
 *
 * A page is cut into batches of 15–25 lines or ~1500 source tokens (whichever
 * comes first) — big enough to amortise the round trip, small enough that a
 * retry after a malformed response is cheap.
 *
 * Batch ids are *derived, never random*: `project#epoch#page#index`, and the
 * retry ladder produces `…#0`, `…#1`, `…#l3` from a parent id. Re-running the
 * same batch therefore always targets the same lines — the property that makes
 * "rotate mid-batch with zero duplicate/missing lines" achievable.
 */

import { estimateTokens } from './keyPool'
import type { BatchLine, TranslationBatch } from './types'

export interface BuildOptions {
  /** Smallest batch we bother to send (unless the page runs out). */
  minLines?: number
  maxLines?: number
  maxTokens?: number
}

export const BATCH_DEFAULTS: Required<BuildOptions> = {
  minLines: 15,
  maxLines: 25,
  maxTokens: 1500,
}

function batchId(projectId: string, epoch: number, pageIndex: number, index: number): string {
  return `${projectId}#${epoch}#${pageIndex}#${index}`
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
    tokens: lines.reduce((sum, line) => sum + estimateTokens(line.text), 0),
  }
}

/** Splits one page's lines into batches (never reordering them). */
export function buildBatches(
  projectId: string,
  epoch: number,
  pageIndex: number,
  lines: BatchLine[],
  options: BuildOptions = {},
): TranslationBatch[] {
  const { minLines, maxLines, maxTokens } = { ...BATCH_DEFAULTS, ...options }
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

  for (const line of lines) {
    const lineTokens = estimateTokens(line.text)
    const overTokenBudget = current.length >= minLines && tokens + lineTokens > maxTokens
    if (current.length > 0 && (current.length >= maxLines || overTokenBudget)) flush()
    current.push(line)
    tokens += lineTokens
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

/** Total lines across a set of batches (progress reporting). */
export function countLines(batches: TranslationBatch[]): number {
  return batches.reduce((sum, batch) => sum + batch.lines.length, 0)
}
