/**
 * Undo / redo controller.
 *
 * The store owns the stacks, Dexie owns the data; this module is the only
 * place that moves a command from one stack to the other while writing the
 * matching state back to IndexedDB.
 */

import { redoCommand, undoCommand } from './commands'
import { useEditorStore } from './store'
import type { EditorCommand } from './types'

export interface UndoResult {
  ok: boolean
  command: EditorCommand | null
  /** `undo` moved backwards, `redo` moved forwards. */
  direction: 'undo' | 'redo'
}

export async function undo(): Promise<UndoResult> {
  const store = useEditorStore.getState()
  const cmd = store.popUndo()
  if (!cmd) return { ok: false, command: null, direction: 'undo' }
  await undoCommand(cmd)
  useEditorStore.getState().pushRedo(cmd)
  return { ok: true, command: cmd, direction: 'undo' }
}

export async function redo(): Promise<UndoResult> {
  const store = useEditorStore.getState()
  const cmd = store.popRedo()
  if (!cmd) return { ok: false, command: null, direction: 'redo' }
  await redoCommand(cmd)
  useEditorStore.getState().push(cmd)
  return { ok: true, command: cmd, direction: 'redo' }
}

/** True while either stack has an entry (drives the toolbar buttons). */
export function historyState(): { canUndo: boolean; canRedo: boolean } {
  const state = useEditorStore.getState()
  return { canUndo: state.undoStack.length > 0, canRedo: state.redoStack.length > 0 }
}
