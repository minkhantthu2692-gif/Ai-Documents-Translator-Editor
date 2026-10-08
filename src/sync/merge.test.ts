import { describe, expect, it } from 'vitest'
import { lwwWins, mergeRemote, recordsDiffer } from './merge'
import type { WireChange } from './protocol'

function change(overrides: Partial<WireChange> = {}): WireChange {
  return {
    entity: 'projects',
    id: 'prj_1',
    op: 'upsert',
    record: { id: 'prj_1', name: 'Remote', updatedAt: 200, version: 2, deviceId: 'dev_b' },
    updatedAt: 200,
    version: 2,
    deviceId: 'dev_b',
    ...overrides,
  }
}

const localRow = {
  id: 'prj_1',
  name: 'Local',
  updatedAt: 100,
  version: 1,
  deviceId: 'dev_a',
}

describe('lwwWins — mirrors incomingWins_ in Code.gs', () => {
  it('prefers the newer updatedAt', () => {
    expect(
      lwwWins(
        { updatedAt: 2, version: 1, deviceId: 'a' },
        { updatedAt: 1, version: 9, deviceId: 'z' },
      ),
    ).toBe(true)
    expect(
      lwwWins(
        { updatedAt: 1, version: 9, deviceId: 'z' },
        { updatedAt: 2, version: 1, deviceId: 'a' },
      ),
    ).toBe(false)
  })

  it('breaks timestamp ties with the version', () => {
    expect(
      lwwWins(
        { updatedAt: 1, version: 2, deviceId: 'a' },
        { updatedAt: 1, version: 1, deviceId: 'z' },
      ),
    ).toBe(true)
  })

  it('breaks full ties with deviceId string order', () => {
    expect(
      lwwWins(
        { updatedAt: 1, version: 1, deviceId: 'b' },
        { updatedAt: 1, version: 1, deviceId: 'a' },
      ),
    ).toBe(true)
    expect(
      lwwWins(
        { updatedAt: 1, version: 1, deviceId: 'a' },
        { updatedAt: 1, version: 1, deviceId: 'b' },
      ),
    ).toBe(false)
  })

  it('does not win on full equality', () => {
    expect(
      lwwWins(
        { updatedAt: 1, version: 1, deviceId: 'a' },
        { updatedAt: 1, version: 1, deviceId: 'a' },
      ),
    ).toBe(false)
  })
})

describe('recordsDiffer — key order and null-vs-empty are irrelevant', () => {
  it('ignores key order', () => {
    expect(recordsDiffer({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
  })

  it('treats null, undefined and empty string as the same empty value', () => {
    expect(
      recordsDiffer({ notes: null, archivedAt: undefined }, { notes: '', archivedAt: '' }),
    ).toBe(false)
  })

  it('sees real changes, including inside arrays', () => {
    expect(recordsDiffer({ name: 'a' }, { name: 'b' })).toBe(true)
    expect(recordsDiffer({ lines: ['x'] }, { lines: ['y'] })).toBe(true)
  })
})

describe('mergeRemote — policy matrix', () => {
  it('applies a remote row when nothing exists locally', () => {
    const out = mergeRemote(undefined, change(), { policy: 'newest', localPending: false })
    expect(out.action).toBe('apply')
    expect(out.conflict).toBeNull()
  })

  it('never resurrects a placeholder for a remote tombstone without a local row', () => {
    const out = mergeRemote(undefined, change({ op: 'delete' }), {
      policy: 'newest',
      localPending: false,
    })
    expect(out.action).toBe('skip')
    expect(out.conflict).toBeNull()
  })

  it('skips identical metadata (idempotent re-pull)', () => {
    const out = mergeRemote(
      { ...localRow, updatedAt: 200, version: 2, deviceId: 'dev_b' },
      change(),
      { policy: 'newest', localPending: true },
    )
    expect(out.action).toBe('skip')
    expect(out.conflict).toBeNull()
  })

  it('newest + remote newer + unsynced local work → apply and log the loss', () => {
    const out = mergeRemote(localRow, change(), { policy: 'newest', localPending: true })
    expect(out.action).toBe('apply')
    expect(out.conflict?.winner).toBe('remote')
    expect(out.conflict?.loser).toMatchObject({ name: 'Local' })
  })

  it('newest + remote newer + local fully pushed → routine catch-up, no conflict', () => {
    const out = mergeRemote(localRow, change(), { policy: 'newest', localPending: false })
    expect(out.action).toBe('apply')
    expect(out.conflict).toBeNull()
  })

  it('newest + local newer → local survives, no conflict', () => {
    const incoming = change({ updatedAt: 50, version: 1, deviceId: 'dev_b' })
    const out = mergeRemote(localRow, incoming, { policy: 'newest', localPending: true })
    expect(out.action).toBe('skip')
    expect(out.conflict).toBeNull()
  })

  it("policy 'local' rejects a newer cloud copy and logs the conflict", () => {
    const out = mergeRemote(localRow, change(), { policy: 'local', localPending: false })
    expect(out.action).toBe('skip')
    expect(out.conflict?.winner).toBe('local')
    expect(out.conflict?.loser).toMatchObject({ name: 'Remote' })
  })

  it("policy 'remote' overrides an older LWW outcome and logs the conflict", () => {
    const incoming = change({ updatedAt: 50, version: 1, deviceId: 'dev_b' })
    const out = mergeRemote(localRow, incoming, { policy: 'remote', localPending: false })
    expect(out.action).toBe('apply')
    expect(out.conflict?.winner).toBe('remote')
    expect(out.conflict?.loser).toMatchObject({ name: 'Local' })
  })

  it('remote tombstone over a fresh local row deletes it and logs the loss', () => {
    const out = mergeRemote(localRow, change({ op: 'delete' }), {
      policy: 'newest',
      localPending: true,
    })
    expect(out.action).toBe('apply')
    expect(out.conflict?.winner).toBe('remote')
    expect(out.conflict?.loser).toMatchObject({ name: 'Local' })
  })

  it('remote tombstone over an untouched local row is routine cleanup', () => {
    const out = mergeRemote(localRow, change({ op: 'delete' }), {
      policy: 'newest',
      localPending: false,
    })
    expect(out.action).toBe('apply')
    expect(out.conflict).toBeNull()
  })
})
