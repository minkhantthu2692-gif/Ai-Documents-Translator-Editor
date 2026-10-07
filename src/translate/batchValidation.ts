/**
 * Strict validation of a provider response.
 *
 * The prompt demands `{"items":[{"id":"…","t":"…"}]}`; the model frequently
 * answers with fences, prose around the JSON, a missing or duplicated line, or
 * a completely different id set. The ladder in `engine.ts` decides what to do
 * next (halve → line-by-line → keep the original) purely on the verdict made
 * here, so every check is explicit and reports *why* it failed.
 *
 * Checks, in order:
 *   1. the payload is JSON (code fences and stray prose are stripped first);
 *   2. every entry has a string `id` and a non-empty string `t`;
 *   3. the count matches the batch;
 *   4. the id checksum (FNV-1a over the sorted ids) matches;
 *   5. the id *set* matches exactly — same ids, nothing unknown, no duplicates.
 *
 * Output order is never trusted: results are rebuilt in the input order, which
 * is what keeps "no line dropped, none reordered" true even when the model
 * answers out of sequence.
 */

import type { BatchResultLine, TranslationBatch } from './types'

export type ValidationFailure =
  'empty' | 'not-json' | 'shape' | 'count' | 'checksum' | 'ids' | 'missing-text'

export interface Validation {
  ok: boolean
  /** Entries in *input* order; empty when `ok` is false. */
  lines: BatchResultLine[]
  reason: ValidationFailure | null
  detail: string
}

const FAILURE_LABELS: Record<ValidationFailure, string> = {
  empty: 'empty response',
  'not-json': 'response is not JSON',
  shape: 'entries are not {id, t} pairs',
  count: 'wrong number of lines',
  checksum: 'id checksum mismatch',
  ids: 'id set mismatch',
  'missing-text': 'empty translation for a line',
}

export function validationDetail(result: Validation): string {
  return result.reason
    ? `${FAILURE_LABELS[result.reason]}${result.detail ? ` — ${result.detail}` : ''}`
    : 'ok'
}

/**
 * Removes ```json fences and any prose around the outermost JSON value.
 *
 * The value may be an object (`{"items":[…]}`) or a bare array (`[{…}]`), so
 * whichever bracket opens *first* owns the slice — taking the object branch
 * first would cut the brackets off a perfectly good array response.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed)
  if (fenced) return fenced[1].trim()

  const objectStart = trimmed.indexOf('{')
  const arrayStart = trimmed.indexOf('[')
  const objectSlice =
    objectStart >= 0 && trimmed.lastIndexOf('}') > objectStart
      ? trimmed.slice(objectStart, trimmed.lastIndexOf('}') + 1)
      : null
  const arraySlice =
    arrayStart >= 0 && trimmed.lastIndexOf(']') > arrayStart
      ? trimmed.slice(arrayStart, trimmed.lastIndexOf(']') + 1)
      : null
  const arrayOpensFirst = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)
  const candidates = arrayOpensFirst ? [arraySlice, objectSlice] : [objectSlice, arraySlice]

  for (const candidate of [...candidates, trimmed]) {
    if (candidate === null) continue
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      /* try the next slice */
    }
  }
  return objectSlice ?? arraySlice ?? trimmed
}

/** FNV-1a (32-bit) over the sorted id list — order-independent fingerprint. */
export function checksumOf(ids: string[]): string {
  let hash = 0x811c9dc5
  for (const id of [...ids].sort()) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0x7c
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function failure(reason: ValidationFailure, detail = ''): Validation {
  return { ok: false, lines: [], reason, detail }
}

interface RawEntry {
  id: unknown
  t: unknown
}

function parseEntries(payload: string): RawEntry[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed as RawEntry[]
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { items?: unknown }).items)
  ) {
    return (parsed as { items: RawEntry[] }).items
  }
  return null
}

export function validateResponse(text: string, target: TranslationBatch): Validation {
  const payload = stripCodeFences(text ?? '')
  if (payload.length === 0) return failure('empty')

  const entries = parseEntries(payload)
  if (entries === null) return failure('not-json', payload.slice(0, 120))

  const wantedIds = target.lines.map((line) => line.id)

  if (entries.length !== wantedIds.length) {
    return failure('count', `${entries.length} of ${wantedIds.length}`)
  }

  const answerIds: string[] = []
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.t !== 'string') {
      return failure('shape', `entry ${index + 1}`)
    }
    answerIds.push(entry.id)
  }

  if (checksumOf(answerIds) !== checksumOf(wantedIds)) {
    return failure('checksum', `${checksumOf(answerIds)} ≠ ${checksumOf(wantedIds)}`)
  }

  const byId = new Map<string, string>()
  for (const entry of entries) {
    const id = entry.id as string
    if (byId.has(id)) return failure('ids', `duplicate id "${id}"`)
    byId.set(id, entry.t as string)
  }
  for (const id of wantedIds) {
    if (!byId.has(id)) return failure('ids', `missing id "${id}"`)
  }
  for (const id of byId.keys()) {
    if (!wantedIds.includes(id)) return failure('ids', `unknown id "${id}"`)
  }

  const lines: BatchResultLine[] = []
  for (const [index, line] of target.lines.entries()) {
    const translated = byId.get(line.id) ?? ''
    if (translated.trim().length === 0) {
      return failure('missing-text', `line ${index + 1} (${line.id})`)
    }
    lines.push({ id: line.id, text: translated.trim(), confidence: 1, flag: null })
  }

  return { ok: true, lines, reason: null, detail: '' }
}
