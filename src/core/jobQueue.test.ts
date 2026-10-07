import { describe, expect, it } from 'vitest'
import { JobQueue, type QueueSnapshot } from './jobQueue'

interface Item {
  id: string
}

interface Gate {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

function gate(): Gate {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets queued microtasks and promise callbacks run. */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function ids(prefix: string, count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }))
}

describe('JobQueue', () => {
  it('never exceeds the concurrency limit and drains in order', async () => {
    const started: string[] = []
    const gates = new Map<string, Gate>(ids('a', 4).map((item) => [item.id, gate()]))
    const queue = new JobQueue<Item>({
      concurrency: 2,
      run: (item) => {
        started.push(item.id)
        return gates.get(item.id)!.promise
      },
    })

    queue.enqueue(ids('a', 4))
    queue.start()
    await tick()
    expect(started).toEqual(['a0', 'a1'])
    expect(queue.snapshot().active).toBe(2)

    gates.get('a0')!.resolve()
    await tick()
    expect(started).toEqual(['a0', 'a1', 'a2'])

    gates.get('a1')!.resolve()
    gates.get('a2')!.resolve()
    gates.get('a3')!.resolve()
    await tick()

    expect(queue.phase).toBe('done')
    const snapshot = queue.snapshot()
    expect(snapshot.completed).toBe(4)
    expect(snapshot.pendingIds).toEqual([])
    expect(snapshot.active).toBe(0)
  })

  it('persists a snapshot after every item', async () => {
    const persisted: Array<{ id: string | null; completed: number }> = []
    const queue = new JobQueue<Item>({
      concurrency: 1,
      run: async () => undefined,
      persist: (snapshot: QueueSnapshot, item) => {
        persisted.push({ id: item?.id ?? null, completed: snapshot.completed })
      },
    })

    queue.enqueue(ids('p', 3))
    queue.start()
    await queue.waitForIdle()
    await queue.flush()

    expect(persisted.map((entry) => entry.id)).toEqual(['p0', 'p1', 'p2'])
    expect(persisted.map((entry) => entry.completed)).toEqual([1, 2, 3])
  })

  it('stops dispatching while paused and continues on resume', async () => {
    const started: string[] = []
    const gates = new Map<string, Gate>(ids('b', 3).map((item) => [item.id, gate()]))
    const queue = new JobQueue<Item>({
      concurrency: 1,
      run: (item) => {
        started.push(item.id)
        return gates.get(item.id)!.promise
      },
    })

    queue.enqueue(ids('b', 3))
    queue.start()
    await tick()
    expect(started).toEqual(['b0'])

    queue.pause()
    expect(queue.phase).toBe('paused')
    gates.get('b0')!.resolve()
    await tick()
    // The running item finished but nothing new was dispatched.
    expect(started).toEqual(['b0'])
    expect(queue.snapshot().active).toBe(0)

    queue.resume()
    await tick()
    expect(started).toEqual(['b0', 'b1'])

    gates.get('b1')!.resolve()
    gates.get('b2')!.resolve()
    await tick()
    expect(queue.phase).toBe('done')
  })

  it('aborts running work on cancel without recording failures', async () => {
    const aborted: string[] = []
    const queue = new JobQueue<Item>({
      concurrency: 1,
      run: (item, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted.push(item.id)
            reject(new Error('aborted'))
          })
        }),
    })

    queue.enqueue(ids('c', 3))
    queue.start()
    await tick()
    expect(aborted).toEqual([])

    queue.cancel()
    await tick()

    expect(aborted).toEqual(['c0'])
    expect(queue.phase).toBe('cancelled')
    const snapshot = queue.snapshot()
    expect(snapshot.failed).toBe(0)
    expect(snapshot.pendingIds).toEqual([])
    expect(snapshot.active).toBe(0)
  })

  it('isolates failures, keeps going and supports retry', async () => {
    const started: string[] = []
    let failOnce = true
    const queue = new JobQueue<Item>({
      concurrency: 1,
      run: async (item) => {
        started.push(item.id)
        if (item.id === 'd1' && failOnce) {
          failOnce = false
          throw new Error('boom')
        }
      },
    })

    queue.enqueue(ids('d', 3))
    queue.start()
    await queue.waitForIdle()

    expect(started).toEqual(['d0', 'd1', 'd2'])
    expect(queue.snapshot().failedIds).toEqual(['d1'])
    expect(queue.snapshot().completed).toBe(2)
    expect(queue.phase).toBe('done')

    const retried = queue.retryFailed()
    expect(retried.map((item) => item.id)).toEqual(['d1'])
    queue.start()
    await queue.waitForIdle()

    expect(queue.snapshot().failed).toBe(0)
    expect(queue.snapshot().completed).toBe(3)
    expect(queue.phase).toBe('done')
  })

  it('reports a fully failed queue as failed', async () => {
    const queue = new JobQueue<Item>({
      concurrency: 2,
      run: async () => {
        throw new Error('nope')
      },
    })
    queue.enqueue(ids('f', 2))
    queue.start()
    await queue.waitForIdle()
    expect(queue.phase).toBe('failed')
    expect(queue.snapshot().failed).toBe(2)
  })

  it('ignores duplicate ids and emits events to subscribers', async () => {
    const events: string[] = []
    const queue = new JobQueue<Item>({ concurrency: 1, run: async () => undefined })
    queue.subscribe((event) => events.push(event.type))

    queue.enqueue([{ id: 'x' }])
    queue.enqueue([{ id: 'x' }, { id: 'y' }])
    expect(queue.snapshot().total).toBe(2)

    queue.start()
    await queue.waitForIdle()

    expect(events.filter((type) => type === 'item-start')).toHaveLength(2)
    expect(events.filter((type) => type === 'item-done')).toHaveLength(2)
    expect(events).toContain('phase')
  })

  it('resolves waitForIdle immediately when nothing is running', async () => {
    const queue = new JobQueue<Item>({ concurrency: 1, run: async () => undefined })
    await expect(queue.waitForIdle()).resolves.toBeUndefined()
  })

  it('waits for the queue after start()', async () => {
    const queue = new JobQueue<Item>({
      concurrency: 2,
      run: async () => new Promise((resolve) => setTimeout(resolve, 5)),
    })
    queue.enqueue(ids('w', 5))
    queue.start()
    await queue.waitForIdle()
    expect(queue.snapshot().completed).toBe(5)
    expect(queue.phase).toBe('done')
  })
})
