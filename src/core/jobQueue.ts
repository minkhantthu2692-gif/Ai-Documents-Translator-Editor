/**
 * Generic job queue with pause / resume / cancel, a concurrency limit and
 * persistence after every item.
 *
 * Parsing uses it now (page windows of a 300+ page PDF) and translation will
 * reuse it in Phase 3 — both need the same guarantees: the UI must survive a
 * reload mid-run (persist after every item) and the user must be able to stop,
 * pause and continue without losing progress.
 *
 * Pure TypeScript with injected I/O (`run`, `persist`) so it is unit-testable
 * without timers, workers or IndexedDB.
 */

export type QueuePhase = 'idle' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed'

export interface QueueSnapshot {
  phase: QueuePhase
  total: number
  completed: number
  failed: number
  active: number
  pendingIds: string[]
  failedIds: string[]
}

export type QueueEvent<T> =
  | { type: 'phase'; phase: QueuePhase; snapshot: QueueSnapshot }
  | { type: 'item-start'; item: T; snapshot: QueueSnapshot }
  | { type: 'item-done'; item: T; snapshot: QueueSnapshot }
  | { type: 'item-error'; item: T; error: string; snapshot: QueueSnapshot }
  | { type: 'persisted'; snapshot: QueueSnapshot }

export interface JobQueueOptions<T> {
  /** Maximum items running at the same time (≥ 1). */
  concurrency?: number
  /** Executes one item; the signal aborts on cancel(). */
  run: (item: T, signal: AbortSignal) => Promise<void>
  /** Called after *every* item so a reload can resume where it stopped. */
  persist?: (snapshot: QueueSnapshot, item: T | null) => void | Promise<void>
}

interface InFlight<T> {
  item: T
  controller: AbortController
  cancelled: boolean
}

export class JobQueue<T extends { id: string }> {
  private readonly concurrency: number
  private readonly run: (item: T, signal: AbortSignal) => Promise<void>
  private readonly persist:
    ((snapshot: QueueSnapshot, item: T | null) => void | Promise<void>) | null
  private readonly listeners = new Set<(event: QueueEvent<T>) => void>()

  private pending: T[] = []
  private readonly items = new Map<string, T>()
  private readonly inFlight = new Map<string, InFlight<T>>()
  private completedIds: string[] = []
  private failedIds: string[] = []
  private currentPhase: QueuePhase = 'idle'
  private persistChain: Promise<void> = Promise.resolve()
  private idleWaiters: Array<() => void> = []

  constructor(options: JobQueueOptions<T>) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2))
    this.run = options.run
    this.persist = options.persist ?? null
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  subscribe(listener: (event: QueueEvent<T>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get phase(): QueuePhase {
    return this.currentPhase
  }

  snapshot(): QueueSnapshot {
    return {
      phase: this.currentPhase,
      total: this.items.size,
      completed: this.completedIds.length,
      failed: this.failedIds.length,
      active: this.inFlight.size,
      pendingIds: this.pending.map((item) => item.id),
      failedIds: [...this.failedIds],
    }
  }

  enqueue(items: T[]): void {
    for (const item of items) {
      if (this.items.has(item.id)) continue
      this.items.set(item.id, item)
      this.pending.push(item)
    }
    if (
      this.currentPhase === 'done' ||
      this.currentPhase === 'failed' ||
      this.currentPhase === 'cancelled'
    ) {
      this.setPhase('idle')
    }
    this.dispatch()
    this.settleIfIdle()
  }

  /** Starts (or restarts) processing of everything pending. */
  start(): void {
    if (this.currentPhase === 'running') return
    if (this.pending.length === 0 && this.inFlight.size === 0) {
      this.setPhase(this.completedIds.length + this.failedIds.length > 0 ? 'done' : 'idle')
      this.settleIfIdle()
      return
    }
    this.setPhase('running')
    this.dispatch()
  }

  /** Stops dispatching new items; running items finish normally. */
  pause(): void {
    if (this.currentPhase !== 'running') return
    this.setPhase('paused')
    this.settleIfIdle()
  }

  resume(): void {
    if (this.currentPhase !== 'paused') return
    this.setPhase('running')
    this.dispatch()
  }

  /** Aborts running items, drops the pending list and stops dispatching. */
  cancel(): void {
    if (this.currentPhase === 'idle' || this.currentPhase === 'cancelled') return
    for (const entry of this.inFlight.values()) {
      entry.cancelled = true
      entry.controller.abort()
    }
    this.pending = []
    this.setPhase('cancelled')
    void this.flush()
    this.settleIfIdle()
  }

  /**
   * Drops every item, its history and the current phase so the queue can be
   * filled again (a cancelled parse restarting, a project switched).
   * Aborts whatever is still running first.
   */
  reset(): void {
    if (this.currentPhase === 'running' || this.inFlight.size > 0) this.cancel()
    this.pending = []
    this.items.clear()
    this.completedIds = []
    this.failedIds = []
    this.setPhase('idle')
    this.settleIfIdle()
  }

  /** Moves failed items back into the queue (keeps completed work). */
  retryFailed(): T[] {
    if (this.failedIds.length === 0) return []
    const retried: T[] = []
    for (const id of this.failedIds) {
      const item = this.items.get(id)
      if (item) {
        this.pending.push(item)
        retried.push(item)
      }
    }
    this.failedIds = []
    if (this.currentPhase !== 'running')
      this.setPhase(this.pending.length > 0 ? 'idle' : this.currentPhase)
    this.dispatch()
    this.settleIfIdle()
    return retried
  }

  /** Resolves once nothing is running and the queue cannot progress by itself. */
  waitForIdle(): Promise<void> {
    if (this.inFlight.size === 0 && this.currentPhase !== 'running') return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Awaits the persistence chain (used by tests and shutdown paths). */
  flush(): Promise<void> {
    return this.persistChain
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private emit(event: QueueEvent<T>): void {
    for (const listener of this.listeners) listener(event)
  }

  private setPhase(phase: QueuePhase): void {
    if (this.currentPhase === phase) return
    this.currentPhase = phase
    this.emit({ type: 'phase', phase, snapshot: this.snapshot() })
  }

  private dispatch(): void {
    while (
      this.currentPhase === 'running' &&
      this.inFlight.size < this.concurrency &&
      this.pending.length > 0
    ) {
      const item = this.pending.shift() as T
      const controller = new AbortController()
      const entry: InFlight<T> = { item, controller, cancelled: false }
      this.inFlight.set(item.id, entry)
      this.emit({ type: 'item-start', item, snapshot: this.snapshot() })

      void this.run(item, controller.signal).then(
        () => this.handleSettled(entry, null),
        (error: unknown) => this.handleSettled(entry, error),
      )
    }
  }

  private handleSettled(entry: InFlight<T>, error: unknown): void {
    const wasCancelled = entry.cancelled
    this.inFlight.delete(entry.item.id)

    if (!wasCancelled) {
      if (error == null) {
        this.completedIds.push(entry.item.id)
        this.emit({ type: 'item-done', item: entry.item, snapshot: this.snapshot() })
      } else {
        this.failedIds.push(entry.item.id)
        this.emit({
          type: 'item-error',
          item: entry.item,
          error: error instanceof Error ? error.message : String(error),
          snapshot: this.snapshot(),
        })
      }
      this.queuePersist(entry.item)
    }

    if (this.currentPhase === 'running') this.dispatch()
    this.finishIfDone()
    this.settleIfIdle()
  }

  private finishIfDone(): void {
    if (this.inFlight.size > 0) return
    if (this.currentPhase === 'running' && this.pending.length > 0) return
    if (this.currentPhase === 'running') {
      this.setPhase(this.failedIds.length > 0 && this.completedIds.length === 0 ? 'failed' : 'done')
    }
  }

  private settleIfIdle(): void {
    if (this.inFlight.size > 0 || this.currentPhase === 'running') return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private queuePersist(item: T | null): void {
    if (!this.persist) return
    const snapshot = this.snapshot()
    const persist = this.persist
    this.persistChain = this.persistChain.then(async () => {
      await persist(snapshot, item)
      this.emit({ type: 'persisted', snapshot })
    })
  }
}
