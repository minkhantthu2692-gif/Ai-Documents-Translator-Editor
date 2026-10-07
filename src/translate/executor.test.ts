/**
 * Rotation-executor acceptance tests.
 *
 * The 429-storm scenarios drive the loop on a virtual clock with an injected
 * `sleep`, so nothing here touches a real timer or a real network.
 */
import { describe, expect, it } from 'vitest'
import { emptyRateLimit, type RateLimitInfo } from '@/providers/rateLimit'
import { ProviderError, type TranslateCall } from '@/providers/types'
import {
  defaultSleep,
  executeWithRotation,
  type BatchTransport,
  type ExecutorHooks,
  type TransportOk,
  type WaitingReason,
} from './executor'
import { KeyPool, type KeySeed } from './keyPool'
import type { BatchLine } from './types'

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

function ok(text: string): TransportOk {
  const rate: RateLimitInfo = emptyRateLimit()
  return { text, tokensIn: 12, tokensOut: 8, latencyMs: 5, rate }
}

function lines(count: number): BatchLine[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `proj#42#0#0#l${index}`,
    text: `source line ${index}`,
    pageIndex: 0,
    order: index,
    listMarker: null,
    placeholders: [],
  }))
}

function idsIn(user: string): string[] {
  const ids: string[] = []
  for (const match of user.matchAll(/\[id=([^\]]+)\]/g)) ids.push(match[1])
  return ids
}

function promptFor(ids: string[]): TranslateCall {
  const user = ids.map((id, index) => `${index + 1}. [id=${id}] source line ${index}`).join('\n')
  return { model: 'model-1', system: 'system', user, temperature: 0.2 }
}

function rateLimitError(retryAfterMs: number | null = null): ProviderError {
  return new ProviderError('rate_limit', '429 too many requests', {
    status: 429,
    retryAfterMs,
  })
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error: unknown) {
    return error
  }
}

describe('429 rotation', () => {
  it('a 429 storm on key A rotates to key B mid-call and re-runs the same batch with no duplicate or missing lines', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    const wanted = lines(3).map((line) => line.id)
    const response = JSON.stringify({ items: wanted.map((id) => ({ id, t: `translated ${id}` })) })
    const call = promptFor(wanted)

    const attempts: Array<{ keyId: string; ids: string[] }> = []
    const transport: BatchTransport = async ({ call: sent, lease }) => {
      attempts.push({ keyId: lease.keyId, ids: idsIn(sent.user) })
      if (lease.keyId === 'key-a') throw rateLimitError(10_000)
      return ok(response)
    }

    let rebuilt = 0
    const result = await executeWithRotation(
      () => {
        rebuilt += 1
        return call
      },
      {
        pool,
        models: ['model-1'],
        transport,
        now: () => clock.now,
        sleep: async () => undefined,
      },
    )

    expect(result.keyId).toBe('key-b')
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
    expect(result.text).toBe(response)
    expect(rebuilt).toBe(2)
    expect(attempts.map((attempt) => attempt.keyId)).toEqual(['key-a', 'key-b'])
    // Same batch, re-run: every id exactly once and in the original order.
    for (const attempt of attempts) expect(attempt.ids).toEqual(wanted)
    expect(pool.health('key-a', clock.now)).toBe('cooling-down')
  })

  it('a 429 on every key parks the call, reports onWaiting(until, reason) and resumes after the injected sleep', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    const sleeps: number[] = []
    const waits: Array<{ until: number; reason: WaitingReason }> = []
    const hooks: ExecutorHooks = {
      onWaiting: (until, reason) => waits.push({ until, reason }),
    }

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      if (calls <= 2) throw rateLimitError(30_000)
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      hooks,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock.now += ms
      },
    })

    expect(calls).toBe(3)
    expect(sleeps).toEqual([30_000])
    expect(waits).toEqual([{ until: T0 + 30_000, reason: 'ALL_KEYS_COOLING_DOWN' }])
    expect(clock.now).toBe(T0 + 30_000)
    expect(result.attempts).toBe(3)
    expect(result.retries).toBe(2)
    expect(result.keyId).toBe('key-a')
  })

  it('a quota 429 parks the call with reason QUOTA_EXHAUSTED and waits out the quota window', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({
      now: () => clock.now,
      random: () => 0.5,
      quotaFallbackMs: 5_000,
    })
    pool.setKeys([seed('key-a')])

    const waits: Array<{ until: number; reason: WaitingReason }> = []
    const sleeps: number[] = []
    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      if (calls === 1) {
        throw new ProviderError('quota', '429 quota exceeded', {
          status: 429,
          retryAfterMs: 1_000,
        })
      }
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      hooks: { onWaiting: (until, reason) => waits.push({ until, reason }) },
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock.now += ms
      },
    })

    expect(waits).toEqual([{ until: T0 + 5_000, reason: 'QUOTA_EXHAUSTED' }])
    expect(sleeps).toEqual([5_000])
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
  })
})

describe('credential failures', () => {
  it('a 401 marks the key invalid and rotates to the next key', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    const retries: Array<{ keyId: string; kind: string }> = []
    const transport: BatchTransport = async ({ lease }) => {
      if (lease.keyId === 'key-a') {
        throw new ProviderError('unauthorized', '401 invalid x-api-key', { status: 401 })
      }
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      now: () => clock.now,
      sleep: async () => undefined,
      hooks: { onRetry: ({ keyId, kind }) => retries.push({ keyId, kind }) },
    })

    expect(result.keyId).toBe('key-b')
    expect(result.attempts).toBe(2)
    expect(pool.health('key-a', T0)).toBe('invalid')
    expect(pool.health('key-b', T0)).toBe('healthy')
    expect(retries).toEqual([{ keyId: 'key-a', kind: 'unauthorized' }])
  })

  it('a 403 marks the key invalid too', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    const transport: BatchTransport = async () => {
      throw new ProviderError('forbidden', '403 forbidden', { status: 403 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    expect(pool.health('key-a', T0)).toBe('invalid')
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('unauthorized')
  })

  it('all keys invalid → throws ProviderError(unauthorized) instead of waiting', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      throw new ProviderError('unauthorized', '401 invalid key', { status: 401 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    expect(calls).toBe(1)
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('unauthorized')
    expect(error.message).toBe('Every configured key was rejected')
  })
})

describe('model fallback chain', () => {
  it('advances the chain on model_missing and reports the new model', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    const fallbacks: string[] = []
    const transport: BatchTransport = async ({ model }) => {
      if (model === 'model-primary') {
        throw new ProviderError('model_missing', '404 model not found', { status: 404 })
      }
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-primary', 'model-fallback'],
      transport,
      now: () => clock.now,
      sleep: async () => undefined,
      hooks: { onModelFallback: (model) => fallbacks.push(model) },
    })

    expect(result.model).toBe('model-fallback')
    expect(result.attempts).toBe(2)
    expect(fallbacks).toEqual(['model-fallback'])
  })

  it('an exhausted model chain fails with model_missing instead of burning quota forever', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      throw new ProviderError('model_missing', '404 model not found', { status: 404 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['only-model'],
        transport,
        maxConsecutiveFailures: 3,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    expect(calls).toBe(3)
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('model_missing')
  })
})

describe('abort', () => {
  it('an already-aborted signal cancels before any provider call', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      return ok('{"items":[]}')
    }
    const controller = new AbortController()
    controller.abort()

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        signal: controller.signal,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    expect(calls).toBe(0)
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })

  it('aborting mid-flight cancels the in-flight call promptly', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    const transport: BatchTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        })
      })

    const controller = new AbortController()
    const promise = executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      signal: controller.signal,
      now: () => clock.now,
      sleep: async () => undefined,
    })
    controller.abort()

    const error = await captureError(promise)
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })

  it('defaultSleep resolves once the delay elapses and rejects when aborted', async () => {
    await expect(defaultSleep(0)).resolves.toBeUndefined()

    const controller = new AbortController()
    controller.abort()
    const error = await captureError(defaultSleep(60_000, controller.signal))
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })
})
