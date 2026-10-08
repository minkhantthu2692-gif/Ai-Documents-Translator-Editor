/**
 * Batch construction.
 *
 * A page is cut into batches of at most `maxLines` lines or `maxTokens` source
 * tokens, whichever comes first — big enough to amortise the round trip, small
 * enough that a retry after a malformed response is cheap, and always small
 * enough to fit the model's window, because `maxTokens` arrives from the run's
 * `BudgetProfile` rather than from a constant.
 *
 * Batch ids are *derived, never random*: `project#epoch#page#index`, and the
 * retry ladder produces `…#0`, `…#1`, `…#l3` from a parent id. Re-running the
 * same batch therefore always targets the same lines — the property that makes
 * "rotate mid-batch with zero duplicate/missing lines" achievable.
 */

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
  const { maxLines, maxTokens } = { ...BATCH_DEFAULTS, ...options }
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
    // `maxTokens` is a hard budget. A page of long lines used to be allowed to
    // overshoot it (a "minimum lines" floor was consulted first), which is how
    // a request could end up larger than the model's window. A single line that
    // alone exceeds the budget is still sent whole: there is nothing to split
    // it against, and the retry ladder owns what comes next.
    const overTokenBudget = tokens + lineTokens > maxTokens
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
