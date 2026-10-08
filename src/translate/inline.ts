/**
 * Inline re-translation (Phase 4).
 *
 * The queue owns whole-document runs; this module serves the editor's
 * one-off requests — re-translate a page, re-translate the selection, or ask a
 * *different* model for an alternative wording. It reuses the same worker
 * session, key pool, rate limits and glossary as the queue, so an inline run
 * can never bypass the protection Phase 3 put in place.
 *
 * Nothing here writes to the blocks: the caller decides whether a result is
 * applied (re-translate) or parked as a suggestion (alternative).
 */

import { vaultPassphrase } from '@/core/vault'
import { apiKeyRepo } from '@/db/repo-apiKeys'
import { blockRepo } from '@/db/repo-content'
import { glossaryRepo } from '@/db/repo-knowledge'
import type { BlockRecord, TranslationFlag } from '@/db/types'
import {
  TranslationRunCancelled,
  TranslationRunError,
  translationRunner,
} from './translationClient'
import { buildBatches } from './batching'
import { limitsFor, loadGlossary, modelChain, persistKeyStates } from './translateQueue'
import { storeTranslation } from './tm'
import type { BatchLine, GlossarySpec, PromptContext, TranslateRunConfig } from './types'

export interface InlineLineResult {
  /** `BlockRecord.id` of the line this result belongs to. */
  id: string
  text: string
  confidence: number
  flag: TranslationFlag | null
}

export interface InlineTranslateOptions {
  projectId: string
  config: TranslateRunConfig
  /** Blocks to translate, in reading order. Empty → returns immediately. */
  blocks: BlockRecord[]
  /** Page index of a block (progress + per-page terminology scope). */
  pageIndexOf?: (block: BlockRecord) => number
  /** Neighbouring text for the prompt (improves consistency). */
  context?: PromptContext | null
  /** Persist the results into translation memory (applied results only). */
  writeTm?: boolean
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface InlineTranslateResult {
  lines: InlineLineResult[]
  model: string
  requests: number
  tokensIn: number
  tokensOut: number
}

/** Lines per request — same budget the document queue uses. */
const INLINE_BATCH_SIZE = 20

export async function translateInline(
  options: InlineTranslateOptions,
): Promise<InlineTranslateResult> {
  const { projectId, config, blocks } = options
  if (blocks.length === 0) {
    return { lines: [], model: config.model, requests: 0, tokensIn: 0, tokensOut: 0 }
  }

  const keys = (await apiKeyRepo.listRowsByProvider(config.provider)).filter(
    (row) => row.enabled !== false,
  )
  if (keys.length === 0) {
    throw new TranslationRunError(
      'NO_API_KEY',
      `No enabled API key for provider "${config.provider}"`,
    )
  }

  const epoch = Date.now()
  const lines: BatchLine[] = blocks.map((block) => ({
    id: block.id,
    text: block.sourceText,
    pageIndex: options.pageIndexOf?.(block) ?? 0,
    order: block.order,
    listMarker: block.listMarker,
    kind: block.kind,
    placeholders: block.placeholders,
  }))

  const glossary: GlossarySpec[] = await loadGlossary(projectId)
  const models = modelChain(config)
  const limits = limitsFor(config)
  const sessionId = `${projectId}#inline#${epoch}`
  const session = {
    sessionId,
    config,
    models,
    limits,
    keys,
    passphrase: vaultPassphrase(),
  }

  await translationRunner.open(session)

  // Keep glossary rows in scope even if the caller built them by hand.
  if (glossary.length === 0) {
    const [globalRows, projectRows] = await Promise.all([
      glossaryRepo.list(null),
      glossaryRepo.list(projectId),
    ])
    for (const row of [...globalRows, ...projectRows]) {
      glossary.push({
        sourceTerm: row.sourceTerm,
        targetTerm: row.targetTerm,
        caseSensitive: row.caseSensitive,
      })
    }
  }

  const batches = buildBatches(projectId, epoch, options.pageIndexOf?.(blocks[0]) ?? 0, lines, {
    maxLines: INLINE_BATCH_SIZE,
  })
  const results: InlineLineResult[] = []
  let requests = 0
  let tokensIn = 0
  let tokensOut = 0
  const byId = new Map(blocks.map((block) => [block.id, block]))
  const positionOf = new Map(lines.map((line, index) => [line.id, index]))

  for (const batch of batches) {
    if (options.signal?.aborted) throw new TranslationRunCancelled('inline run cancelled')

    const position = positionOf.get(batch.lines[0]?.id ?? '') ?? 0
    const context: PromptContext | null =
      options.context ??
      (position > 0
        ? {
            before: lines[position - 1].text,
            after: lines[position + 1]?.text ?? '',
          }
        : null)

    const outcome = await translationRunner.run(
      {
        ...session,
        id: `${sessionId}#${batch.index}`,
        batch,
        glossary,
        context,
        seenPage: [],
        seenDocument: [],
      },
      {
        onStates: (states) => {
          void persistKeyStates(states)
        },
      },
    )

    requests += outcome.result.requests
    tokensIn += outcome.result.tokensIn
    tokensOut += outcome.result.tokensOut

    for (const line of outcome.result.lines) {
      results.push({
        id: line.id,
        text: line.text,
        confidence: line.confidence,
        flag: line.flag,
      })
      if (options.writeTm !== false) {
        const block = byId.get(line.id)
        if (block && line.text.trim().length > 0) {
          await storeTranslation({
            sourceText: block.sourceText,
            sourceLang: config.sourceLang,
            targetLang: config.targetLang,
            quality: config.quality,
            model: outcome.result.model || config.model,
            targetText: line.text,
            provider: config.provider,
            confidence: line.confidence,
          }).catch(() => undefined)
        }
      }
    }
    options.onProgress?.(
      Math.min(lines.length, (batch.index + 1) * INLINE_BATCH_SIZE),
      lines.length,
    )
  }

  return {
    lines: results,
    model: config.model,
    requests,
    tokensIn,
    tokensOut,
  }
}

/**
 * Loads the blocks of one page (or an explicit id list) ready for an inline
 * run. Locked and skipped blocks are excluded — the inspector's "re-translate"
 * button never overrides a lock.
 */
export async function loadReTranslatableBlocks(
  projectId: string,
  target: { pageId?: string; blockIds?: string[] },
): Promise<BlockRecord[]> {
  const blocks = target.pageId
    ? await blockRepo.listByPage(target.pageId)
    : await blockRepo.listByProject(projectId)
  const wanted = target.blockIds ? new Set(target.blockIds) : null
  return blocks
    .filter((block) => (wanted ? wanted.has(block.id) : true))
    .filter((block) => block.status !== 'locked' && block.status !== 'skipped')
    .filter((block) => block.skipRule === null && block.sourceText.trim().length > 0)
    .sort((a, b) => a.order - b.order)
}
