/**
 * Editor UI state (Phase 4).
 *
 * Everything here is session state: what is selected, which view is active,
 * the zoom, the font controls, the find bar and the undo/redo stacks. The
 * document itself lives in IndexedDB — the stacks only record *how* to move
 * between persisted states, so a reload keeps the edits and starts a fresh
 * session stack.
 */

import { create } from 'zustand'
import type {
  EditScope,
  EditorCommand,
  EditorView,
  FindOptions,
  FontFamilyChoice,
  FontSizeChoice,
} from './types'
import { EMPTY_FIND, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, trimStack } from './types'

export type InspectorTab = 'block' | 'history' | 'document'

/** Progress of a long-running editor action (re-translate, apply, import). */
export interface EditorBusy {
  kind: 'retranslate' | 'apply-style' | 'find' | 'template' | 'autosave'
  done: number
  total: number
  /** 0..1 */
  ratio: number
}

export interface EditorStore {
  projectId: string | null
  view: EditorView
  zoom: number
  /** Selected block ids (multi-select with Ctrl/Cmd). */
  selection: string[]
  /** The block the inspector describes (always part of `selection`). */
  activeBlockId: string | null
  /** Block currently in the inline text editor (null = none). */
  editingBlockId: string | null
  undoStack: EditorCommand[]
  redoStack: EditorCommand[]
  scope: EditScope
  fontFamily: FontFamilyChoice
  fontSize: FontSizeChoice
  inspectorTab: InspectorTab
  find: FindOptions
  findOpen: boolean
  matchIndex: number
  matchCount: number
  busy: EditorBusy | null
  /** Blocks whose text measured outside their original bbox (warning badges). */
  overflowIds: string[]
  /** First visible page — what "page" scope and page re-translate target. */
  activePage: number | null

  open: (projectId: string) => void
  close: () => void
  setView: (view: EditorView) => void
  setZoom: (zoom: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  setSelection: (ids: string[]) => void
  toggleSelection: (id: string) => void
  selectOnly: (id: string) => void
  setActive: (id: string | null) => void
  setEditing: (id: string | null) => void
  setScope: (scope: EditScope) => void
  setFontFamily: (value: FontFamilyChoice) => void
  setFontSize: (value: FontSizeChoice) => void
  setInspectorTab: (tab: InspectorTab) => void
  setFind: (patch: Partial<FindOptions>) => void
  setFindOpen: (open: boolean) => void
  setMatchState: (count: number, index: number) => void
  setBusy: (busy: EditorBusy | null) => void
  setOverflow: (ids: string[]) => void
  setActivePage: (pageIndex: number | null) => void
  push: (cmd: EditorCommand) => void
  pushRedo: (cmd: EditorCommand) => void
  popUndo: () => EditorCommand | null
  popRedo: () => EditorCommand | null
  canUndo: () => boolean
  canRedo: () => boolean
}

const initial = {
  projectId: null as string | null,
  view: 'split' as EditorView,
  zoom: 1,
  selection: [] as string[],
  activeBlockId: null as string | null,
  editingBlockId: null as string | null,
  undoStack: [] as EditorCommand[],
  redoStack: [] as EditorCommand[],
  scope: 'block' as EditScope,
  fontFamily: 'original' as FontFamilyChoice,
  fontSize: 'original' as FontSizeChoice,
  inspectorTab: 'block' as InspectorTab,
  find: { ...EMPTY_FIND },
  findOpen: false,
  matchIndex: 0,
  matchCount: 0,
  busy: null as EditorBusy | null,
  overflowIds: [] as string[],
  activePage: null as number | null,
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  ...initial,

  open: (projectId) => set({ ...initial, projectId }),
  close: () => set({ ...initial }),

  setView: (view) => set({ view }),
  setZoom: (zoom) => set({ zoom: clamp(zoom) }),
  zoomIn: () => set({ zoom: clamp(get().zoom + ZOOM_STEP) }),
  zoomOut: () => set({ zoom: clamp(get().zoom - ZOOM_STEP) }),
  resetZoom: () => set({ zoom: 1 }),

  setSelection: (ids) => set({ selection: ids, activeBlockId: ids[ids.length - 1] ?? null }),
  toggleSelection: (id) => {
    const current = get().selection
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    set({ selection: next, activeBlockId: next[next.length - 1] ?? null })
  },
  selectOnly: (id) => set({ selection: [id], activeBlockId: id }),
  setActive: (id) =>
    set((state) =>
      id === null
        ? { activeBlockId: null, selection: [] }
        : { activeBlockId: id, selection: state.selection.includes(id) ? state.selection : [id] },
    ),
  setEditing: (id) => set({ editingBlockId: id }),

  setScope: (scope) => set({ scope }),
  setFontFamily: (fontFamily) => set({ fontFamily }),
  setFontSize: (fontSize) => set({ fontSize }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),

  setFind: (patch) => set((state) => ({ find: { ...state.find, ...patch } })),
  setFindOpen: (findOpen) => set({ findOpen, ...(findOpen ? {} : { matchIndex: 0 }) }),
  setMatchState: (matchCount, matchIndex) => set({ matchCount, matchIndex }),

  setBusy: (busy) => set({ busy }),
  setOverflow: (overflowIds) => set({ overflowIds }),
  setActivePage: (activePage) => set({ activePage }),

  push: (cmd) =>
    set((state) => ({
      undoStack: trimStack([...state.undoStack, cmd]),
      redoStack: [],
    })),
  /** Undo→redo transfer: must not clear the redo stack it lands on. */
  pushRedo: (cmd) => set((state) => ({ redoStack: trimStack([...state.redoStack, cmd]) })),
  popUndo: () => {
    const stack = get().undoStack
    if (stack.length === 0) return null
    const cmd = stack[stack.length - 1]
    set({ undoStack: stack.slice(0, -1) })
    return cmd
  },
  popRedo: () => {
    const stack = get().redoStack
    if (stack.length === 0) return null
    const cmd = stack[stack.length - 1]
    set({ redoStack: stack.slice(0, -1) })
    return cmd
  },
  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
}))

function clamp(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100))
}

/** Test seam: forget the current session without touching IndexedDB. */
export function resetEditorStore(): void {
  useEditorStore.setState({ ...initial })
}
