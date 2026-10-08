/**
 * Layer 7 — merge integrity verification.
 *
 * The merge is already exactly-once per block by construction: per-block writes,
 * an id-set validation in `batchValidation`, and a plan rebuilt from Dexie on
 * every restore. What was missing was a way to *see* that it held.
 *
 * The trick here is that "missing" and "duplicated" are not derived from a
 * second, parallel notion of the document — they are derived by **re-planning**
 * with the same `buildTranslatePlan` the run used. Re-run after the queue
 * settles, its pending jobs are exactly the in-scope blocks that never landed,
 * and its line ids are exactly what the run would send, so the two lists can
 * never disagree with the queue about what counts as work.
 *
 * A `missing` id is already `pending` in Dexie, so the next run re-plans and
 * re-translates it automatically — the invariant is self-healing; this makes
 * the gap *visible*, and tells the user whether a document is actually whole.
 */

import { buildTranslatePlan } from './translateQueue'
import type { IntegrityReport, TranslateRunConfig } from './types'

export type { IntegrityReport }

/**
 * Checks that the document is whole after a run.
 *
 * @param projectId — the project to inspect.
 * @param config — the run configuration; its scope rules decide what counts.
 *
 * @returns `ok` when nothing is missing and nothing was sent twice.
 */
export async function verifyDocumentIntegrity(
  projectId: string,
  config: TranslateRunConfig,
): Promise<IntegrityReport> {
  // Epoch is only used to name batches; nothing here is persisted, so a fixed
  // value keeps the result independent of which run produced the data.
  const plan = await buildTranslatePlan(projectId, config, 0)

  const seen = new Set<string>()
  const missing: string[] = []
  const duplicated: string[] = []

  for (const job of plan.jobs) {
    for (const line of job.batch.lines) {
      if (seen.has(line.id)) {
        // Only report each id once — a triple duplicate is still one problem.
        if (!duplicated.includes(line.id)) duplicated.push(line.id)
        continue
      }
      seen.add(line.id)
      // Still in the plan ⇒ still `todo` ⇒ the merge never reached it.
      missing.push(line.id)
    }
  }

  return {
    ok: missing.length === 0 && duplicated.length === 0,
    checked: plan.total,
    missing,
    duplicated,
  }
}
