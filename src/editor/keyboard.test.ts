import { describe, expect, it } from 'vitest'
import {
  EDITOR_SHORTCUTS,
  matches,
  shouldPreventDefault,
  shortcutFor,
  shortcutLabel,
  type KeyEventLike,
} from './keyboard'

function key(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial }
}

describe('matches', () => {
  it('requires the modifier to be held', () => {
    expect(matches(key({ key: 'z', ctrlKey: true }), EDITOR_SHORTCUTS.undo)).toBe(true)
    expect(matches(key({ key: 'z' }), EDITOR_SHORTCUTS.undo)).toBe(false)
  })

  it('separates undo from redo by shift', () => {
    expect(shortcutFor(key({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(shortcutFor(key({ key: 'z', ctrlKey: true }))).toBe('undo')
  })

  it('treats Cmd as Ctrl so the bindings work on macOS', () => {
    expect(matches(key({ key: 'f', metaKey: true }), EDITOR_SHORTCUTS.find)).toBe(true)
  })

  it('ignores a bare letter that has a modified binding', () => {
    expect(shortcutFor(key({ key: 'f' }))).toBeNull()
    expect(shortcutFor(key({ key: 'b' }))).toBeNull()
  })

  it('matches named keys exactly', () => {
    expect(shortcutFor(key({ key: 'Escape' }))).toBe('escape')
    expect(shortcutFor(key({ key: 'Enter', ctrlKey: true }))).toBe('acceptSuggestion')
    expect(shortcutFor(key({ key: 'Enter', shiftKey: true }))).toBe('prevMatch')
  })

  it('is case-insensitive for printable keys', () => {
    expect(matches(key({ key: 'F', ctrlKey: true }), EDITOR_SHORTCUTS.find)).toBe(true)
  })
})

describe('shortcutLabel', () => {
  it('renders a readable combo on non-mac platforms', () => {
    expect(shortcutLabel(EDITOR_SHORTCUTS.redo)).toBe('Ctrl+Shift+Z')
    expect(shortcutLabel(EDITOR_SHORTCUTS.escape)).toBe('Esc')
  })
})

describe('shouldPreventDefault', () => {
  it('swallows browser-level combos only', () => {
    expect(shouldPreventDefault('find')).toBe(true)
    expect(shouldPreventDefault('undo')).toBe(true)
    expect(shouldPreventDefault('nextBlock')).toBe(false)
    expect(shouldPreventDefault('escape')).toBe(false)
  })
})
