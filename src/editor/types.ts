/**
 * Editor types (Phase 4).
 *
 * A command is an inverse pair of per-block patches: `after` is applied when
 * the command runs, `before` when it is undone. Commands are plain data so the
 * undo stack can be reasoned about (and tested) without a DOM or Dexie.
 */

import type { BlockAlignment, BlockStatus, FontSizeMode, RevisionAction } from '@/db/types'

/** Every field the editor is allowed to change on a block. */
export interface BlockFields {
  translatedText: string
  sourceText: string
  fontFamily: string
  fontSize: number
  fontSizeMode: FontSizeMode
  lineHeight: number
  color: string
  bold: boolean
  italic: boolean
  alignment: BlockAlignment
  status: BlockStatus
  suggestedText: string | null
  suggestedModel: string | null
  suggestedAt: number | null
  overflow: boolean
}

export type BlockFieldKey = keyof BlockFields

/** Only the fields a given action touches. */
export type BlockPatch = Partial<BlockFields>

/** One block's before/after pair. */
export interface BlockChange {
  blockId: string
  /** Page the block sits on (revision rows are indexed by page). */
  pageIndex: number
  before: BlockPatch
  after: BlockPatch
}

export interface EditorCommand {
  /** Stable id so the stack can be deduplicated/tested. */
  id: string
  /** i18n key of the human label shown in History (`editor.cmd.*`). */
  labelKey: string
  changes: BlockChange[]
  /** History row written when the command is first applied. */
  action: RevisionAction
  /** `user` or the model id for AI-driven changes. */
  actor?: string
}

/** Which blocks a control applies to. */
export type EditScope = 'block' | 'page' | 'document'

/** How the two page canvases are arranged. */
export type EditorView = 'split' | 'original' | 'translated'

/** Font Size dropdown value: extracted size, computed auto-fit, or a number. */
export type FontSizeChoice = 'original' | 'auto' | number

/** Font Family dropdown value: the block's own family or an explicit one. */
export type FontFamilyChoice = 'original' | string

export interface FindOptions {
  query: string
  replacement: string
  caseSensitive: boolean
  wholeWord: boolean
}

export const EMPTY_FIND: FindOptions = {
  query: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
}

/** One occurrence located in the document (index order: page, then block). */
export interface FindMatch {
  blockId: string
  pageIndex: number
  /** Index of the block inside its page (reading order). */
  order: number
  /** Offset into `translatedText` (or `sourceText` when `field` says so). */
  start: number
  length: number
  field: 'translatedText' | 'sourceText'
  /** The text around the match, for the results list. */
  preview: string
}

export const MAX_UNDO = 100

/** Keeps an undo/redo stack bounded without dropping the newest entries. */
export function trimStack<T>(stack: T[]): T[] {
  return stack.length > MAX_UNDO ? stack.slice(stack.length - MAX_UNDO) : stack
}

/** Zoom limits for the split view (keep pages legible, avoid absurd scale). */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4
export const ZOOM_STEP = 0.1
