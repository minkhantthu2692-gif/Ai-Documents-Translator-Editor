/**
 * Translated page text layer (Phase 4).
 *
 * Every block is absolutely positioned in **PDF points** — the same unit as
 * `BlockRecord`'s bbox and the CSS `pt` the export uses — over the rendered
 * page artwork, using the font, size, weight, colour, alignment and direction
 * extracted from the PDF. Selecting a block is a click; editing it swaps in a
 * contentEditable that commits one undoable `edit-text` command on blur.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { IconAlert, IconSparkle } from '@/components/layout/icons'
import { directionOf } from '@/lib/text'
import { CODE_FONT_STACK } from '@/pdf/codeBlocks'
import type { IndexedBlock } from '@/editor/commands'

export interface BlockHighlight {
  start: number
  length: number
  active: boolean
}

export interface BlockLayerProps {
  blocks: IndexedBlock[]
  /** Selected block ids (from the editor store). */
  selected: ReadonlySet<string>
  /** Block currently in the inline editor. */
  editingId: string | null
  /** Blocks whose text measures outside the original bbox. */
  overflowIds: ReadonlySet<string>
  /** Find matches per block (translated text only). */
  matches?: Map<string, BlockHighlight[]>
  onSelect: (id: string, additive: boolean) => void
  onBeginEdit: (id: string) => void
  onCommitEdit: (id: string, text: string) => void
  onCancelEdit: () => void
}

/** The text the block renders (translation first, source as fallback). */
function textOf(block: IndexedBlock): string {
  return block.translatedText.length > 0 ? block.translatedText : block.sourceText
}

/** The CSS box one block occupies, in points. */
export function blockStyle(block: IndexedBlock): CSSProperties {
  return {
    left: `${block.x}pt`,
    top: `${block.y}pt`,
    width: `${Math.max(1, block.width)}pt`,
    minHeight: `${Math.max(1, block.height)}pt`,
    // A code snippet is drawn the way it will be exported: same monospace
    // stack, same tab stops. Its own family already *is* monospaced most of
    // the time — the detector reads it off the font name — but the stack wins
    // for the snippets caught by their punctuation instead, so what the user
    // sees never disagrees with what the exporters write.
    fontFamily:
      block.kind === 'code' ? CODE_FONT_STACK : `"${block.fontFamily}", var(--font-mm), sans-serif`,
    fontSize: `${block.fontSize}pt`,
    lineHeight: block.lineHeight,
    color: block.color,
    fontWeight: block.bold ? 700 : 400,
    fontStyle: block.italic ? 'italic' : 'normal',
    textAlign: block.alignment === 'justified' ? 'justify' : block.alignment,
    direction: directionOf(textOf(block)) === 'rtl' ? 'rtl' : 'ltr',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    ...(block.kind === 'code' ? { tabSize: 4 } : {}),
  }
}

function Highlighted({ text, marks }: { text: string; marks?: BlockHighlight[] }): ReactNode {
  if (!marks || marks.length === 0) return text
  const parts: ReactNode[] = []
  let cursor = 0
  for (const mark of [...marks].sort((a, b) => a.start - b.start)) {
    if (mark.start < cursor) continue
    if (mark.start > cursor) parts.push(text.slice(cursor, mark.start))
    parts.push(
      <mark
        key={`${mark.start}-${mark.length}`}
        className={cn(
          'text-inherit',
          mark.active ? 'bg-primary/35 outline outline-1 outline-primary' : 'bg-warning/40',
        )}
      >
        {text.slice(mark.start, mark.start + mark.length)}
      </mark>,
    )
    cursor = mark.start + mark.length
  }
  parts.push(text.slice(cursor))
  return <>{parts}</>
}

/** ContentEditable that commits on blur and reverts on Escape. */
function InlineEditor({
  initial,
  style,
  className,
  onCommit,
  onCancel,
}: {
  initial: string
  style: CSSProperties
  className?: string
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [])

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-testid="block-editor"
      className={cn('h-full w-full outline-none', className)}
      style={style}
      onBlur={(event) => {
        if (cancelled.current) return
        onCommit(event.currentTarget.textContent ?? '')
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancelled.current = true
          onCancel()
          return
        }
        event.stopPropagation()
      }}
    >
      {initial}
    </div>
  )
}

export function BlockLayer({
  blocks,
  selected,
  editingId,
  overflowIds,
  matches,
  onSelect,
  onBeginEdit,
  onCommitEdit,
  onCancelEdit,
}: BlockLayerProps) {
  const { t } = useTranslation()

  return (
    <div className="absolute inset-0">
      {blocks.map((block) => {
        const isSelected = selected.has(block.id)
        const isEditing = editingId === block.id
        const overflowing = overflowIds.has(block.id)
        const text = textOf(block)
        const style = blockStyle(block)

        return (
          <div
            key={block.id}
            data-testid="editor-block"
            data-block-id={block.id}
            data-page-index={block.pageIndex}
            data-selected={isSelected ? 'true' : undefined}
            data-overflow={overflowing ? 'true' : undefined}
            className={cn(
              'absolute box-border cursor-text px-[1pt] py-[0.5pt]',
              isSelected ? 'z-10 outline outline-1 outline-primary outline-offset-0' : '',
              overflowing ? 'border-l-2 border-warning' : '',
              block.status === 'locked' ? 'cursor-default' : '',
              isEditing ? 'z-20 bg-surface/95 outline-2' : '',
            )}
            style={style}
            onClick={(event) => {
              if (isEditing) return
              event.stopPropagation()
              onSelect(block.id, event.ctrlKey || event.metaKey || event.shiftKey)
            }}
            onDoubleClick={(event) => {
              if (block.status === 'locked') return
              event.stopPropagation()
              onBeginEdit(block.id)
            }}
          >
            {isEditing ? (
              <InlineEditor
                initial={text}
                style={{ ...style, left: undefined, top: undefined, position: 'static' }}
                onCommit={(next) => onCommitEdit(block.id, next)}
                onCancel={onCancelEdit}
              />
            ) : (
              <span className="relative">
                <Highlighted text={text} marks={matches?.get(block.id)} />
                {block.suggestedText !== null ? (
                  <span
                    title={t('editor.block.suggestionBadge')}
                    className="absolute -right-[3pt] -top-[3pt] text-primary"
                  >
                    <IconSparkle className="h-2.5 w-2.5" />
                  </span>
                ) : null}
                {overflowing ? (
                  <span
                    title={t('editor.block.overflowBadge')}
                    className="absolute -right-[3pt] -bottom-[3pt] text-warning"
                  >
                    <IconAlert className="h-2.5 w-2.5" />
                  </span>
                ) : null}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
