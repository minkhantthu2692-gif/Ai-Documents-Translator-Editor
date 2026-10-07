/**
 * Translation memory + local cache.
 *
 * Two layers, both obeying the Cache tab's switches:
 *
 *  1. **Translation memory** (Dexie `translationMemory`) — exact source match,
 *     keyed by source hash + language pair, survives quality/model changes.
 *  2. **Translation cache** (Dexie `cache`, kind `translation`) — keyed by
 *     `hash(source + src + tgt + quality + model family)`, so a Basic-quality
 *     result is never replayed for a High-quality run.
 *
 * Both are read-only fast paths: a hit skips the provider entirely, and a miss
 * is written back after the batch succeeds.
 */

import { hashText } from '@/db/repo-common'
import { cacheRepo } from '@/db/repo-cache'
import { translationMemoryRepo } from '@/db/repo-knowledge'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type { QualityLevel } from './types'

export interface CacheLookupInput {
  sourceText: string
  sourceLang: string
  targetLang: string
  quality: QualityLevel
  model: string
}

export interface CacheWriteInput extends CacheLookupInput {
  targetText: string
  provider: string
  /** 0..1 — low-confidence results are not worth caching. */
  confidence: number
}

/** `deepseek/deepseek-chat-v3.1:free` → `deepseek`, `llama-3.3-70b` → `llama`. */
export function modelFamily(model: string): string {
  const head = model.split('/')[0]
  const family = head.split('-')[0].split(':')[0]
  return (family || head || 'unknown').toLowerCase()
}

export function cacheKeyFor(input: CacheLookupInput): string {
  const payload = [
    input.sourceLang,
    input.targetLang,
    input.quality,
    modelFamily(input.model),
    input.sourceText,
  ].join(' ')
  return `tr:${hashText(payload)}`
}

/** Reads the Cache tab switches (enabled + TTL in days). */
export async function cacheSettings(): Promise<{ enabled: boolean; ttlDays: number }> {
  const enabled = await settingsRepo.get<boolean>(SETTING_KEYS.cacheEnabled, true)
  const ttlDays = await settingsRepo.get<number>(SETTING_KEYS.cacheTtl, 30)
  return { enabled: enabled !== false, ttlDays: Number(ttlDays) > 0 ? Number(ttlDays) : 30 }
}

/** Cache first, then exact-match translation memory. */
export async function lookupTranslation(
  input: CacheLookupInput,
): Promise<{ text: string; source: 'cache' | 'memory' } | null> {
  const settings = await cacheSettings()
  if (!settings.enabled) return null

  const cached = await cacheRepo.get<string>('translation', cacheKeyFor(input))
  if (typeof cached === 'string' && cached.trim().length > 0) {
    return { text: cached, source: 'cache' }
  }

  const memory = await translationMemoryRepo.find(
    input.sourceText,
    input.sourceLang,
    input.targetLang,
  )
  if (memory && memory.targetText.trim().length > 0) {
    return { text: memory.targetText, source: 'memory' }
  }
  return null
}

export async function storeTranslation(input: CacheWriteInput): Promise<void> {
  if (input.confidence < 0.7) return
  const settings = await cacheSettings()
  if (!settings.enabled) return

  const ttlMs = settings.ttlDays * 24 * 60 * 60 * 1000
  try {
    await cacheRepo.put('translation', cacheKeyFor(input), input.targetText, { ttlMs })
    await translationMemoryRepo.put({
      sourceText: input.sourceText,
      targetText: input.targetText,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      provider: input.provider,
      model: input.model,
    })
  } catch {
    // Cache writes are best-effort: a full quota must not fail the batch.
  }
}
