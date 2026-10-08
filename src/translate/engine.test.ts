/**
 * Batch-engine acceptance tests: ordered results, the retry ladder, and the
 * flags/confidence the coverage report is built from. Transport is a mock and
 * sleep is injected, so no clock and no network are involved.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Placeholder } from '@/pdf/placeholders'
import { emptyRateLimit } from '@/providers/rateLimit'
import { runBatch, type EngineOptions } from './engine'
import type { BatchTransport, TransportOk } from './executor'
import { KeyPool, type KeySeed } from './keyPool'
import { resetTokenScale, tokenScale } from './tokenEstimate'
import type { BatchLine, GlossarySpec, TranslationBatch } from './types'

const T0 = 1_700_000_000_000

function seed(id: string): KeySeed {
  return {
    id,
    provider: 'openrouter',
    nickname: id,
    lastFour: '1234',
    enabled: true,
    secret: `sk-${id}`,
  }
}

function makePool(): KeyPool {
  const pool = new KeyPool({ now: () => T0, random: () => 0.5 })
  pool.setKeys([seed('key-a')])
  return pool
}

function line(id: string, text: string, placeholders: Placeholder[] = []): BatchLine {
  return { id, text, pageIndex: 0, order: 0, listMarker: null, placeholders }
}

function batchOf(lines: BatchLine[], id = 'proj#1#0#0'): TranslationBatch {
  return {
    id,
    pageIndex: 0,
    index: 0,
    lines,
    tokens: lines.reduce((sum, entry) => sum + Math.ceil(entry.text.length / 3), 0),
  }
}

function ok(text: string): TransportOk {
  return { text, tokensIn: 12, tokensOut: 8, latencyMs: 4, rate: emptyRateLimit() }
}

function idsIn(user: string): string[] {
  const ids: string[] = []
  for (const match of user.matchAll(/\[id=([^\]]+)\]/g)) ids.push(match[1])
  return ids
}

/** Builds the protocol answer for exactly the ids the prompt asked for. */
function answer(user: string, translate: (id: string) => string, reverse = false): string {
  const items = idsIn(user).map((id) => ({ id, t: translate(id) }))
  if (reverse) items.reverse()
  return JSON.stringify({ items })
}

function engineOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    quality: 'medium',
    sourceLang: 'en',
    targetLang: 'my',
    terminologyScope: 'first',
    glossary: [],
    models: ['model-1'],
    pool: makePool(),
    transport: async ({ call }) => ok(answer(call.user, (id) => `translated ${id}`)),
    seenPage: new Set<string>(),
    seenDocument: new Set<string>(),
    now: () => T0,
    sleep: async () => undefined,
    ...overrides,
  }
}

describe('happy path', () => {
  it('returns one result per line, in input order, from a single request', async () => {
    const batch = batchOf([
      line('b1', 'first source'),
      line('b2', 'second source'),
      line('b3', 'third source'),
    ])
    const requests: string[] = []
    const transport: BatchTransport = async ({ call }) => {
      requests.push(call.user)
      return ok(answer(call.user, (id) => `translated ${id}`, true))
    }

    const result = await runBatch(batch, engineOptions({ transport }))

    expect(result.batchId).toBe('proj#1#0#0')
    expect(result.lines.map((entry) => entry.id)).toEqual(['b1', 'b2', 'b3'])
    // The model answered out of order; the engine rebuilt the input order.
    expect(result.lines.map((entry) => entry.text)).toEqual([
      'translated b1',
      'translated b2',
      'translated b3',
    ])
    expect(result.lines.every((entry) => entry.flag === null && entry.confidence === 1)).toBe(true)
    expect(result.requests).toBe(1)
    expect(result.tokensIn).toBe(12)
    expect(result.tokensOut).toBe(8)
    expect(result.keyId).toBe('key-a')
    expect(result.model).toBe('model-1')
    expect(requests).toHaveLength(1)
  })
})

describe('retry ladder on a hopeless response', () => {
  it('halves, then goes line-by-line, then keeps every source line flagged kept-original', async () => {
    const source = ['source one', 'source two', 'source three', 'source four']
    const batch = batchOf(source.map((text, index) => line(`b${index + 1}`, text)))
    const idCounts: number[] = []
    const transport: BatchTransport = async ({ call }) => {
      idCounts.push(idsIn(call.user).length)
      return ok('I am afraid I cannot produce JSON today.')
    }

    const result = await runBatch(batch, engineOptions({ transport }))

    // whole batch → two halves → one line per request → repair attempt each
    expect(idCounts).toEqual([4, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1])
    expect(result.requests).toBe(11)

    expect(result.lines.map((entry) => entry.id)).toEqual(['b1', 'b2', 'b3', 'b4'])
    expect(result.lines.map((entry) => entry.text)).toEqual(source)
    expect(result.lines.every((entry) => entry.flag === 'kept-original')).toBe(true)
    expect(result.lines.every((entry) => entry.confidence > 0 && entry.confidence <= 0.2)).toBe(
      true,
    )
  })
})

describe('placeholders', () => {
  const placeholders: Placeholder[] = [{ token: '{{0}}', kind: 'math', original: '$E=mc^2$' }]
  const source = 'Physics {{0}} is required'

  it('flags placeholder-miss and cuts confidence when a token is dropped', async () => {
    const batch = batchOf([line('b1', source, placeholders)])
    const transport: BatchTransport = async ({ call }) =>
      ok(answer(call.user, () => 'ရူပဗေဒ လိုအပ်သည်'))

    const result = await runBatch(batch, engineOptions({ transport }))

    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].flag).toBe('placeholder-miss')
    expect(result.lines[0].confidence).toBeCloseTo(0.65, 3)
    expect(result.lines[0].text).not.toContain('$E=mc^2$')
  })

  it('restores a surviving placeholder and leaves the line clean', async () => {
    const batch = batchOf([line('b1', source, placeholders)])
    const transport: BatchTransport = async ({ call }) =>
      ok(answer(call.user, () => 'ရူပဗေဒ {{0}} လိုအပ်သည်'))

    const result = await runBatch(batch, engineOptions({ transport }))

    expect(result.lines[0].text).toBe('ရူပဗေဒ $E=mc^2$ လိုအပ်သည်')
    expect(result.lines[0].flag).toBeNull()
    expect(result.lines[0].confidence).toBe(1)
  })
})

describe('glossary', () => {
  const glossary: GlossarySpec[] = [
    { sourceTerm: 'API key', targetTerm: 'API သော့', caseSensitive: false },
  ]

  it('flags glossary-miss (and drops confidence) when the required term is absent', async () => {
    const batch = batchOf([line('b1', 'Store the API key safely')])
    const transport: BatchTransport = async ({ call }) =>
      ok(answer(call.user, () => 'စကားဝှက်ကို သိမ်းပါ'))

    const result = await runBatch(batch, engineOptions({ transport, glossary }))

    expect(result.lines[0].flag).toBe('glossary-miss')
    expect(result.lines[0].confidence).toBeCloseTo(0.7, 3)
  })

  it('flags glossary-miss with a smaller penalty when the term was repaired', async () => {
    const batch = batchOf([line('b1', 'Store the API key safely')])
    const transport: BatchTransport = async ({ call }) =>
      ok(answer(call.user, () => 'API key ကို သိမ်းပါ'))

    const result = await runBatch(batch, engineOptions({ transport, glossary }))

    expect(result.lines[0].text).toBe('API သော့ ကို သိမ်းပါ')
    expect(result.lines[0].flag).toBe('glossary-miss')
    expect(result.lines[0].confidence).toBeCloseTo(0.9, 3)
  })
})

describe('token calibration', () => {
  afterEach(() => resetTokenScale())

  /** A batch the provider claims cost 1000× more than we predicted. */
  async function runWithUsage(overrides: Partial<EngineOptions>): Promise<void> {
    const batch = batchOf([line('b1', 'a'.repeat(300))]) // 100 source tokens
    const transport: BatchTransport = async ({ call }) => ({
      ...ok(answer(call.user, () => 'translated')),
      tokensIn: 100_000,
    })
    await runBatch(batch, engineOptions({ transport, ...overrides }))
  }

  it('folds the provider usage into the estimator when the run opts in', async () => {
    await runWithUsage({ calibrate: true })

    expect(tokenScale()).toBeGreaterThan(1)
  })

  it('leaves the estimator alone by default, so tests and previews stay stable', async () => {
    await runWithUsage({})

    expect(tokenScale()).toBe(1)
  })
})
