/**
 * Strict response validation: every rejection reason the ladder depends on.
 */
import { describe, expect, it } from 'vitest'
import {
  checksumOf,
  stripCodeFences,
  validateResponse,
  validationDetail,
  type Validation,
} from './batchValidation'
import type { TranslationBatch } from './types'

const WANTED = ['proj#1#0#0#l0', 'proj#1#0#0#l1', 'proj#1#0#0#l2']

function batchOf(ids: string[] = WANTED): TranslationBatch {
  return {
    id: 'proj#1#0#0',
    pageIndex: 0,
    index: 0,
    tokens: 30,
    lines: ids.map((id, index) => ({
      id,
      text: `source ${index}`,
      pageIndex: 0,
      order: index,
      listMarker: null,
      kind: 'paragraph' as const,
      placeholders: [],
    })),
  }
}

function payload(items: Array<{ id: string; t: string }>): string {
  return JSON.stringify({ items })
}

function goodItems(): Array<{ id: string; t: string }> {
  return WANTED.map((id, index) => ({ id, t: `translated ${index}` }))
}

describe('validateResponse', () => {
  it('accepts a well-formed response and returns the lines in input order', () => {
    const batch = batchOf()
    const shuffled = goodItems().reverse()
    const result = validateResponse(payload(shuffled), batch)

    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.lines.map((line) => line.id)).toEqual(WANTED)
    expect(result.lines.map((line) => line.text)).toEqual([
      'translated 0',
      'translated 1',
      'translated 2',
    ])
    expect(result.lines.every((line) => line.confidence === 1 && line.flag === null)).toBe(true)
  })

  it('rejects a response with the wrong number of lines', () => {
    const result = validateResponse(payload(goodItems().slice(0, 2)), batchOf())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('count')
    expect(result.detail).toBe('2 of 3')
    expect(result.lines).toEqual([])
  })

  it('rejects wrong ids through the id checksum', () => {
    const alien = ['x#1', 'x#2', 'x#3'].map((id, index) => ({ id, t: `t${index}` }))
    const result = validateResponse(payload(alien), batchOf())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('checksum')
    expect(result.detail).toMatch('≠')
  })

  it('rejects duplicated ids', () => {
    const items = [
      { id: WANTED[0], t: 'a' },
      { id: WANTED[0], t: 'b' },
      { id: WANTED[2], t: 'c' },
    ]
    const result = validateResponse(payload(items), batchOf())
    expect(result.ok).toBe(false)
    expect(['checksum', 'ids']).toContain(result.reason)
  })

  it('rejects a missing id (an unknown one stands in for it)', () => {
    const items = [
      { id: WANTED[0], t: 'a' },
      { id: WANTED[1], t: 'b' },
      { id: 'proj#1#0#0#l9', t: 'c' },
    ]
    const result = validateResponse(payload(items), batchOf())
    expect(result.ok).toBe(false)
    expect(['checksum', 'ids']).toContain(result.reason)
  })

  it('rejects a non-JSON response', () => {
    const result = validateResponse('Sorry, I cannot translate that.', batchOf())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-json')
    expect(result.detail).toContain('Sorry')
  })

  it('rejects an empty response', () => {
    expect(validateResponse('', batchOf()).reason).toBe('empty')
    expect(validateResponse('   ', batchOf()).reason).toBe('empty')
  })

  it('rejects entries that are not {id, t} string pairs', () => {
    const items = [
      { id: WANTED[0], t: 'a' },
      { id: WANTED[1], t: 42 },
      { id: WANTED[2], t: 'c' },
    ]
    const result = validateResponse(JSON.stringify({ items }), batchOf())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('shape')
    expect(result.detail).toBe('entry 2')
  })

  it('rejects an empty translation for a line', () => {
    const items = goodItems()
    items[1] = { id: WANTED[1], t: '   ' }
    const result = validateResponse(payload(items), batchOf())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing-text')
    expect(result.detail).toContain('line 2')
  })

  it('passes for fenced-but-valid JSON', () => {
    const fenced = '```json\n' + payload(goodItems()) + '\n```'
    const result = validateResponse(fenced, batchOf())
    expect(result.ok).toBe(true)
    expect(result.lines.map((line) => line.id)).toEqual(WANTED)
  })

  it('passes for valid JSON wrapped in prose', () => {
    const prose = `Here you go:\n${payload(goodItems())}\nLet me know if you need more.`
    expect(validateResponse(prose, batchOf()).ok).toBe(true)
  })

  it('passes for a fenced JSON array as well', () => {
    const fenced = '```json\n' + JSON.stringify(goodItems()) + '\n```'
    expect(validateResponse(fenced, batchOf()).ok).toBe(true)
  })

  it('passes for a bare JSON array (no wrapper object)', () => {
    const bare = JSON.stringify(goodItems())
    const result = validateResponse(bare, batchOf())
    expect(result.ok).toBe(true)
    expect(result.lines.map((line) => line.id)).toEqual(WANTED)
  })

  it('passes for a bare array wrapped in prose', () => {
    const prose = `Here you go:\n${JSON.stringify(goodItems())}\nAnything else?`
    expect(validateResponse(prose, batchOf()).ok).toBe(true)
  })
})

describe('stripCodeFences', () => {
  it('unwraps a fenced JSON object', () => {
    expect(stripCodeFences('```json\n{"items":[]}\n```')).toBe('{"items":[]}')
    expect(stripCodeFences('```\n{"items":[]}\n```')).toBe('{"items":[]}')
  })

  it('extracts the JSON object from prose around it', () => {
    const text = 'Sure! {"items":[{"id":"a","t":"b"}]} Hope that helps.'
    expect(stripCodeFences(text)).toBe('{"items":[{"id":"a","t":"b"}]}')
  })

  it('extracts a JSON array from prose around it', () => {
    expect(stripCodeFences('answer: [1, 2, 3] done')).toBe('[1, 2, 3]')
  })

  it('keeps the brackets of a bare array whose objects contain braces', () => {
    expect(stripCodeFences('[{"id":"a","t":"b"}]')).toBe('[{"id":"a","t":"b"}]')
    expect(stripCodeFences('Here: [{"id":"a","t":"b"}] — done')).toBe('[{"id":"a","t":"b"}]')
  })

  it('still takes the object branch when the object opens first', () => {
    expect(stripCodeFences('{"items":[{"id":"a","t":"b"}]}')).toBe('{"items":[{"id":"a","t":"b"}]}')
    expect(stripCodeFences('{"items":[1,2]} trailing')).toBe('{"items":[1,2]}')
  })

  it('leaves text without any JSON untouched', () => {
    expect(stripCodeFences('  nothing here  ')).toBe('nothing here')
  })
})

describe('checksumOf', () => {
  it('is independent of the id order', () => {
    expect(checksumOf(['a', 'b', 'c'])).toBe(checksumOf(['c', 'a', 'b']))
    expect(checksumOf(['a', 'b', 'c'])).not.toBe(checksumOf(['a', 'b', 'd']))
    expect(checksumOf(['a'])).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('validationDetail', () => {
  it('explains a rejection and reports ok for a pass', () => {
    const ok: Validation = { ok: true, lines: [], reason: null, detail: '' }
    expect(validationDetail(ok)).toBe('ok')

    const failed = validateResponse(payload(goodItems().slice(0, 2)), batchOf())
    expect(validationDetail(failed)).toBe('wrong number of lines — 2 of 3')
  })
})
