/**
 * Export worker transport (Phase 4).
 *
 * The main thread never builds a file itself: it sends one `ExportBuildRequest`
 * (plain data + Blobs, all structured-cloneable) and listens for progress and
 * a single terminal message. The worker is terminated as soon as the promise
 * settles, so a cancelled or failed export leaks nothing.
 *
 * The worker is imported *lazily* — importing this module stays free of worker
 * side effects, which is what lets the orchestration be unit tested.
 */

import type { ExportBuildRequest, ExportWorkerResponse } from './protocol'
import type { ExportArtifact } from './types'
import { ExportBuildError, stageProgress, type ExportProgressHandler } from './progress'

export { ExportBuildError, overallRatio, stageProgress } from './progress'
export type { ExportProgressHandler } from './progress'

async function createWorker(): Promise<Worker> {
  const module = await import('@/workers/export.worker?worker')
  return new module.default()
}

/**
 * Runs one build to completion. `onProgress` may be omitted (headless tests);
 * the promise rejects with an `ExportBuildError` carrying the issue code the
 * UI turns into an actionable message.
 */
export async function buildInWorker(
  request: ExportBuildRequest,
  onProgress?: ExportProgressHandler,
): Promise<ExportArtifact> {
  let worker: Worker
  try {
    worker = await createWorker()
  } catch (error) {
    throw new ExportBuildError(
      'EXPORT_FAILED',
      `export worker unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return new Promise<ExportArtifact>((resolve, reject) => {
    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      run()
    }

    worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      const message = event.data
      if (!message || message.id !== request.id) return
      if (message.kind === 'progress') {
        onProgress?.(stageProgress(message.stage, message.done, message.total))
        return
      }
      if (message.kind === 'done') {
        finish(() => resolve(message.artifact))
        return
      }
      finish(() => reject(new ExportBuildError(message.code, message.detail, message.fonts)))
    }

    worker.onerror = (event: ErrorEvent) => {
      finish(() =>
        reject(new ExportBuildError('EXPORT_FAILED', event.message || 'export worker failed')),
      )
    }

    try {
      worker.postMessage(request)
    } catch (error) {
      finish(() =>
        reject(
          new ExportBuildError(
            'EXPORT_FAILED',
            `request could not be sent: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      )
    }
  })
}
