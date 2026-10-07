import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { PAGE_WINDOW, windowsFor } from './parseQueue'

/**
 * The queue is what makes a 500-page document tractable: pages are only ever
 * handed to the worker in small windows, one job at a time. These tests pin
 * the grouping and the id scheme (de-duplication within a run, fresh ids
 * after a restart) without touching IndexedDB.
 */
describe('windowsFor', () => {
  it('groups pages into windows of PAGE_WINDOW', () => {
    expect(PAGE_WINDOW).toBe(12)

    const jobs = windowsFor('p1', [0, 1, 2, 11, 12, 13, 24])
    expect(jobs).toHaveLength(3)
    expect(jobs[0].pageIndexes).toEqual([0, 1, 2, 11])
    expect(jobs[1].pageIndexes).toEqual([12, 13])
    expect(jobs[2].pageIndexes).toEqual([24])
    expect(jobs.every((job) => job.pageIndexes.length <= PAGE_WINDOW)).toBe(true)
  })

  it('covers every requested page exactly once, whatever the input order', () => {
    const requested = [300, 0, 17, 17, 12, 299, 5]
    const jobs = windowsFor('p1', requested)
    const covered = jobs
      .flatMap((job) => job.pageIndexes)
      .slice()
      .sort((a, b) => a - b)

    expect(covered).toEqual([0, 5, 12, 17, 17, 299, 300])
    expect(jobs.map((job) => Math.floor(job.pageIndexes[0] / PAGE_WINDOW))).toEqual([0, 1, 24, 25])
  })

  it('emits windows in reading order', () => {
    const starts = windowsFor('p1', [48, 0, 24, 36, 12]).map((job) => job.pageIndexes[0])
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(starts).toEqual([0, 12, 24, 36, 48])
  })

  it('produces stable ids inside a run so a window is never queued twice', () => {
    const first = windowsFor('p1', [0, 1, 2])
    const second = windowsFor('p1', [0, 1, 2])
    expect(first.map((job) => job.id)).toEqual(second.map((job) => job.id))
    expect(first[0].id).toMatch(/^p1#\d+#0$/)
  })

  it('namespaces ids per project', () => {
    const [a] = windowsFor('project-a', [0])
    const [b] = windowsFor('project-b', [0])
    expect(a.id).not.toBe(b.id)
    expect(a.projectId).toBe('project-a')
    expect(b.projectId).toBe('project-b')
  })

  it('ignores impossible page indexes', () => {
    expect(windowsFor('p1', [])).toEqual([])
    expect(windowsFor('p1', [-1, -12])).toEqual([])
    expect(windowsFor('p1', [-1, 3])).toHaveLength(1)
    expect(windowsFor('p1', [-1, 3])[0].pageIndexes).toEqual([3])
  })
})
