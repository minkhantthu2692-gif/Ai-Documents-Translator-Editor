/**
 * Keyboard shortcuts (Phase 4).
 *
 * The map is data so the help sheet, the aria labels and the handler all come
 * from one place, and `matches` is pure so it can be unit tested without a
 * real `KeyboardEvent`.
 */

export interface Shortcut {
  /** Lower-case `KeyboardEvent.key` (single characters and named keys). */
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  /** Cmd on macOS, Ctrl elsewhere — resolved by `matches`. */
  meta?: boolean
}

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export const EDITOR_SHORTCUTS = {
  undo: { key: 'z', ctrl: true },
  redo: { key: 'z', ctrl: true, shift: true },
  find: { key: 'f', ctrl: true },
  replace: { key: 'h', ctrl: true },
  selectAll: { key: 'a', ctrl: true },
  bold: { key: 'b', ctrl: true },
  italic: { key: 'i', ctrl: true },
  zoomIn: { key: '=', ctrl: true },
  zoomOut: { key: '-', ctrl: true },
  zoomReset: { key: '0', ctrl: true },
  export: { key: 'e', ctrl: true, shift: true },
  save: { key: 's', ctrl: true },
  escape: { key: 'Escape' },
  nextMatch: { key: 'Enter' },
  prevMatch: { key: 'Enter', shift: true },
  nextBlock: { key: 'ArrowDown' },
  prevBlock: { key: 'ArrowUp' },
  acceptSuggestion: { key: 'Enter', ctrl: true },
  rejectSuggestion: { key: 'Backspace', ctrl: true },
} as const satisfies Record<string, Shortcut>

export type ShortcutId = keyof typeof EDITOR_SHORTCUTS

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
}

/** `Ctrl` and `Cmd` are interchangeable: either one satisfies the binding. */
export function matches(event: KeyEventLike, shortcut: Shortcut): boolean {
  const wantedCtrl = shortcut.ctrl === true
  const wantedMeta = shortcut.meta === true
  const mod = event.ctrlKey || event.metaKey
  if (wantedCtrl && !mod) return false
  if (wantedMeta && !mod) return false
  if (!wantedCtrl && !wantedMeta && (event.ctrlKey || event.metaKey)) return false
  if ((shortcut.shift ?? false) !== event.shiftKey) return false
  if ((shortcut.alt ?? false) !== event.altKey) return false
  const key = shortcut.key.length === 1 ? shortcut.key.toLowerCase() : shortcut.key
  const pressed = event.key.length === 1 ? event.key.toLowerCase() : event.key
  return key === pressed
}

/** The shortcut bound to this event, if any. */
export function shortcutFor(event: KeyEventLike): ShortcutId | null {
  for (const [id, shortcut] of Object.entries(EDITOR_SHORTCUTS)) {
    if (matches(event, shortcut)) return id as ShortcutId
  }
  return null
}

/** Human label for a tooltip: `Ctrl+Shift+Z` (or `⌘⇧Z` on macOS). */
export function shortcutLabel(shortcut: Shortcut): string {
  const mac = isMac()
  const parts: string[] = []
  if (shortcut.ctrl || shortcut.meta) parts.push(mac ? '⌘' : 'Ctrl')
  if (shortcut.alt) parts.push(mac ? '⌥' : 'Alt')
  if (shortcut.shift) parts.push(mac ? '⇧' : 'Shift')
  const key =
    shortcut.key === 'Escape'
      ? 'Esc'
      : shortcut.key.length === 1
        ? shortcut.key.toUpperCase()
        : shortcut.key
  parts.push(key)
  return parts.join(mac ? '' : '+')
}

/** Should the editor swallow this event (so the browser's own handler is off)? */
export function shouldPreventDefault(id: ShortcutId): boolean {
  return (
    id === 'undo' ||
    id === 'redo' ||
    id === 'find' ||
    id === 'replace' ||
    id === 'selectAll' ||
    id === 'zoomIn' ||
    id === 'zoomOut' ||
    id === 'zoomReset' ||
    id === 'export' ||
    id === 'save'
  )
}
