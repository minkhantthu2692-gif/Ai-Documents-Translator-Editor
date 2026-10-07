import { describe, expect, it } from 'vitest'
import { ExportBuildError, STAGE_WINDOW, overallRatio, stageProgress } from './progress'

describe('overallRatio', () => {
  it('maps a stage onto its own window', () => {
    expect(overallRatio({ stage: 'collect', done: 0, total: 10 })).toBeCloseTo(0, 5)
    expect(overallRatio({ stage: 'render', done: 0, total: 10 })).toBeCloseTo(0.08, 5)
    expect(overallRatio({ stage: 'render', done: 5, total: 10 })).toBeCloseTo(0.29, 5)
    expect(overallRatio({ stage: 'write', done: 1, total: 1 })).toBe(1)
  })

  it('never moves backwards when a stage hands over to the next', () => {
    const order = ['collect', 'render', 'build', 'package', 'write'] as const
    let previous = -1
    for (const stage of order) {
      const start = overallRatio({ stage, done: 0, total: 4 })
      const end = overallRatio({ stage, done: 4, total: 4 })
      expect(start).toBeGreaterThanOrEqual(previous)
      expect(end).toBeGreaterThanOrEqual(start)
      previous = end
    }
    expect(previous).toBe(1)
  })

  it('clamps overshoot and empty totals', () => {
    expect(overallRatio({ stage: 'render', done: 99, total: 10 })).toBeCloseTo(0.5, 5)
    expect(overallRatio({ stage: 'build', done: 1, total: 0 })).toBeCloseTo(0.92, 5)
    expect(overallRatio({ stage: 'collect', done: -3, total: 10 })).toBeCloseTo(0, 5)
  })

  it('keeps windows aligned with the protocol', () => {
    expect(STAGE_WINDOW.collect[0]).toBe(0)
    expect(STAGE_WINDOW.write[1]).toBe(1)
  })
})

describe('stageProgress', () => {
  it('carries the stage counters and the overall ratio', () => {
    expect(stageProgress('build', 2, 8)).toEqual({
      stage: 'build',
      done: 2,
      total: 8,
      ratio: overallRatio({ stage: 'build', done: 2, total: 8 }),
    })
  })
})

describe('ExportBuildError', () => {
  it('keeps the issue code and fonts for the UI', () => {
    const error = new ExportBuildError('EXPORT_FONT_MISSING', 'gone', ['Noto Sans'])
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ExportBuildError')
    expect(error.code).toBe('EXPORT_FONT_MISSING')
    expect(error.fonts).toEqual(['Noto Sans'])
    expect(error.message).toBe('gone')
  })

  it('defaults to no fonts', () => {
    expect(new ExportBuildError('EXPORT_EMPTY', 'nothing').fonts).toEqual([])
  })
})
