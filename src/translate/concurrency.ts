/**
 * Adaptive concurrency (AIMD).
 *
 * A global semaphore that sits in front of every provider request:
 *
 *   start at 2 concurrent requests (ceiling 3);
 *   on a clean window of responses → additive increase (+1, capped at 3);
 *   on an error-rate spike → multiplicative decrease (halved, floored at 1).
 *
 * The point is politeness, not throughput: a free-tier key that is already
 * returning 429s must not be hammered by three parallel workers, while a
 * healthy run should keep two/three requests in flight so a 300-page document
 * does not crawl.
 *
 * Pure TypeScript — the tests drive it with explicit `record()` calls, no
 * timers involved.
 */

export const CONCURRENCY_FLOOR = 1
export const CONCURRENCY_CEILING = 3
export const CONCURRENCY_INITIAL = 2
/** Error rate above which the limit is cut (0..1). */
export const ERROR_RATE_THRESHOLD = 0.3
/** Sliding window that decides the error rate. */
export const WINDOW_SIZE = 10

interface Waiter {
  resolve: (release: () => void) => void
}

export class AdaptiveLimiter {
  private limit: number
  private inFlight = 0
  private readonly waiters: Waiter[] = []
  private readonly window: boolean[] = []

  constructor(initial = CONCURRENCY_INITIAL) {
    this.limit = clamp(initial)
  }

  get current(): number {
    return this.limit
  }

  get active(): number {
    return this.inFlight
  }

  get queued(): number {
    return this.waiters.length
  }

  /**
   * Resolves with a release callback once a slot is free.
   * `signal` aborts the wait without consuming a slot.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    if (this.inFlight < this.limit) {
      this.inFlight += 1
      return Promise.resolve(this.releaser())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve }
      const onAbort = (): void => {
        const at = this.waiters.indexOf(waiter)
        if (at >= 0) this.waiters.splice(at, 1)
        reject(new DOMException('aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        // Hand the slot straight to the next waiter (no flicker back to idle).
        next.resolve(this.releaser())
        return
      }
      this.inFlight = Math.max(0, this.inFlight - 1)
    }
  }

  /** Feed every outcome; the limit adapts once per completed window. */
  record(ok: boolean): void {
    this.window.push(ok)
    if (this.window.length < WINDOW_SIZE) return
    const failures = this.window.filter((entry) => !entry).length
    const errorRate = failures / this.window.length
    this.window.length = 0
    if (errorRate > ERROR_RATE_THRESHOLD) this.limit = clamp(Math.floor(this.limit / 2))
    else this.limit = clamp(this.limit + 1)
  }

  /** Snapshot for the UI (`requests/min + active + limit`). */
  snapshot(): { limit: number; inFlight: number; queued: number } {
    return { limit: this.limit, inFlight: this.inFlight, queued: this.waiters.length }
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return CONCURRENCY_INITIAL
  return Math.max(CONCURRENCY_FLOOR, Math.min(CONCURRENCY_CEILING, Math.trunc(value)))
}

/** Rolling requests-per-minute meter (drives the "req/min" read-out). */
export class RateMeter {
  private readonly stamps: number[] = []

  mark(now = Date.now()): void {
    this.stamps.push(now)
    this.trim(now)
  }

  private trim(now: number): void {
    const cutoff = now - 60_000
    while (this.stamps.length > 0 && this.stamps[0] < cutoff) this.stamps.shift()
  }

  perMinute(now = Date.now()): number {
    this.trim(now)
    return this.stamps.length
  }

  reset(): void {
    this.stamps.length = 0
  }
}
