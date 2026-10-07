/**
 * Export progress mapping (Phase 4).
 *
 * Pure helpers shared by the main thread and its tests — no worker, no DOM —
 * so the progress bar maths is unit tested rather than eyeballed.
 */

import type { ExportIssueCode, ExportProgress, ExportStage } from './types'

/** Failure surfaced by the export pipeline, carrying an actionable issue code. */
export class ExportBuildError extends Error {
  readonly code: ExportIssueCode
  readonly fonts: string[]
  constructor(code: ExportIssueCode, detail: string, fonts: string[] = []) {
    super(detail)
    this.name = 'ExportBuildError'
    this.code = code
    this.fonts = fonts
  }
}

export type ExportProgressHandler = (progress: ExportProgress) => void

/**
 * Stage window inside the 0..1 bar. Collecting is instant, rendering the page
 * artwork is the long pole, building is everything the export worker does
 * afterwards.
 */
export const STAGE_WINDOW: Record<ExportStage, readonly [number, number]> = {
  collect: [0, 0.08],
  render: [0.08, 0.5],
  build: [0.5, 0.92],
  package: [0.92, 0.97],
  write: [0.97, 1],
}

/** Maps a stage-local `done/total` onto the whole-run ratio (always 0..1). */
export function overallRatio(progress: Omit<ExportProgress, 'ratio'> | ExportProgress): number {
  const [from, to] = STAGE_WINDOW[progress.stage]
  const fraction = progress.total > 0 ? Math.min(1, Math.max(0, progress.done / progress.total)) : 1
  return Math.min(1, Math.max(0, from + (to - from) * fraction))
}

/** Builds an `ExportProgress` (with the whole-run ratio) for one stage tick. */
export function stageProgress(stage: ExportStage, done: number, total: number): ExportProgress {
  const base = { stage, done, total }
  return { ...base, ratio: overallRatio(base) }
}
