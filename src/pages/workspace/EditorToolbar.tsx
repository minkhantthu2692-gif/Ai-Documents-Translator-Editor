/**
 * Editor toolbar (Phase 4).
 *
 * Every control here writes through the same path: resolve the current scope
 * (block / page / document), build one `edit-style` command, commit it — so a
 * font change is undoable, auto-saved and re-validated exactly like a typed
 * edit. The two dropdowns are the Font Family / Font Size pickers, including
 * "Original" (restore what the PDF had) and "Auto-fit" (shrink to the box).
 */

import { useTranslation } from 'react-i18next'
import { Button, Dropdown, IconButton, Progress, type DropdownEntry } from '@/components/ui'
import { IconDownload, IconSearch } from '@/components/layout/icons'
import type { IndexedBlock } from '@/editor/commands'
import { applyBlockStyle, FONT_FAMILY_CHOICES, FONT_SIZE_PRESETS } from '@/editor/fontControls'
import { redo, undo } from '@/editor/history'
import { EDITOR_SHORTCUTS, shortcutLabel } from '@/editor/keyboard'
import { useEditorStore } from '@/editor/store'
import type {
  BlockPatch,
  EditScope,
  EditorView,
  FontFamilyChoice,
  FontSizeChoice,
} from '@/editor/types'
import { toast } from '@/stores/toastStore'

export interface EditorToolbarProps {
  projectId: string
  /** Block the inspector describes — drives bold/italic/align display state. */
  activeBlock: IndexedBlock | null
  onExport: () => void
  onRetranslate: (target: 'selection' | 'page') => void
}

const VIEWS: EditorView[] = ['split', 'original', 'translated']
const SCOPES: EditScope[] = ['block', 'page', 'document']
const ALIGNMENTS = ['left', 'center', 'right', 'justified'] as const

export function EditorToolbar({
  projectId,
  activeBlock,
  onExport,
  onRetranslate,
}: EditorToolbarProps) {
  const { t } = useTranslation()

  const view = useEditorStore((state) => state.view)
  const zoom = useEditorStore((state) => state.zoom)
  const scope = useEditorStore((state) => state.scope)
  const fontFamily = useEditorStore((state) => state.fontFamily)
  const fontSize = useEditorStore((state) => state.fontSize)
  const selection = useEditorStore((state) => state.selection)
  const findOpen = useEditorStore((state) => state.findOpen)
  const overflowIds = useEditorStore((state) => state.overflowIds)
  const busy = useEditorStore((state) => state.busy)
  const undoDepth = useEditorStore((state) => state.undoStack.length)
  const redoDepth = useEditorStore((state) => state.redoStack.length)
  const activePage = useEditorStore((state) => state.activePage)

  const needsSelection = scope === 'block' && selection.length === 0

  async function apply(patch?: BlockPatch, size?: FontSizeChoice, family?: FontFamilyChoice) {
    const state = useEditorStore.getState()
    if (state.scope === 'block' && state.selection.length === 0) {
      toast('info', t('editor.style.selectFirstTitle'), t('editor.style.selectFirstBody'))
      return
    }
    const result = await applyBlockStyle({
      projectId,
      scope: state.scope,
      selection: state.selection,
      activePage: state.activePage,
      ...(patch ? { patch } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(family !== undefined ? { family } : {}),
      labelKey: 'editor.cmd.style',
    })
    if (result.changed === 0) {
      toast('info', t('editor.style.nothingTitle'), t('editor.style.nothingBody'))
      return
    }
    if (result.overflowed > 0) {
      toast(
        'warning',
        t('editor.style.overflowTitle'),
        t('editor.style.overflowBody', { count: result.overflowed }),
      )
    }
  }

  const familyLabel = fontFamily === 'original' ? t('editor.font.originalFamily') : fontFamily
  const sizeLabel =
    fontSize === 'original'
      ? t('editor.font.originalSize')
      : fontSize === 'auto'
        ? t('editor.font.autoFit')
        : String(fontSize)

  const familyEntries: DropdownEntry[] = [
    { id: 'h-family', kind: 'heading', label: t('editor.font.familyHeading') },
    {
      id: 'original',
      label: t('editor.font.originalFamily'),
      hint: activeBlock?.originalFontFamily,
      selected: fontFamily === 'original',
      onSelect: () => {
        useEditorStore.getState().setFontFamily('original')
        void apply(undefined, undefined, 'original')
      },
    },
    { id: 'sep-1', kind: 'separator' },
    ...FONT_FAMILY_CHOICES.map((family) => ({
      id: family,
      label: family,
      selected: fontFamily === family,
      onSelect: () => {
        useEditorStore.getState().setFontFamily(family)
        void apply(undefined, undefined, family)
      },
    })),
  ]

  const sizeEntries: DropdownEntry[] = [
    { id: 'h-size', kind: 'heading', label: t('editor.font.sizeHeading') },
    {
      id: 'size-original',
      label: t('editor.font.originalSize'),
      hint: activeBlock ? `${activeBlock.originalFontSize}pt` : undefined,
      selected: fontSize === 'original',
      onSelect: () => {
        useEditorStore.getState().setFontSize('original')
        void apply(undefined, 'original')
      },
    },
    {
      id: 'size-auto',
      label: t('editor.font.autoFit'),
      selected: fontSize === 'auto',
      onSelect: () => {
        useEditorStore.getState().setFontSize('auto')
        void apply(undefined, 'auto')
      },
    },
    { id: 'sep-2', kind: 'separator' },
    ...FONT_SIZE_PRESETS.map((size) => ({
      id: `size-${size}`,
      label: `${size} pt`,
      selected: fontSize === size,
      onSelect: () => {
        useEditorStore.getState().setFontSize(size)
        void apply(undefined, size)
      },
    })),
  ]

  const alignEntries: DropdownEntry[] = ALIGNMENTS.map((alignment) => ({
    id: alignment,
    label: t(`editor.align.${alignment}`),
    selected: (activeBlock?.alignment ?? 'left') === alignment,
    onSelect: () => void apply({ alignment }),
  }))

  const retranslateEntries: DropdownEntry[] = [
    {
      id: 'selection',
      label: t('editor.retranslate.selection'),
      hint: String(selection.length),
      disabled: selection.length === 0,
      onSelect: () => onRetranslate('selection'),
    },
    {
      id: 'page',
      label: t('editor.retranslate.page'),
      hint: activePage !== null ? String(activePage + 1) : undefined,
      onSelect: () => onRetranslate('page'),
    },
  ]

  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* View */}
        <div
          role="group"
          aria-label={t('editor.view.label')}
          className="flex rounded-md border border-border"
        >
          {VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              data-testid={`view-${option}`}
              onClick={() => useEditorStore.getState().setView(option)}
              className={
                'h-8 px-2.5 text-[13px] transition-colors ' +
                (view === option
                  ? 'bg-primary text-on-primary'
                  : 'text-muted hover:bg-raised hover:text-text')
              }
            >
              {t(`editor.view.${option}`)}
            </button>
          ))}
        </div>

        {/* Zoom */}
        <div
          role="group"
          aria-label={t('editor.zoom.label')}
          className="flex items-center rounded-md border border-border"
        >
          <IconButton
            size="sm"
            variant="ghost"
            label={`${t('editor.zoom.out')} ${shortcutLabel(EDITOR_SHORTCUTS.zoomOut)}`}
            icon={<span className="text-sm leading-none">−</span>}
            onClick={() => useEditorStore.getState().zoomOut()}
          />
          <button
            type="button"
            onClick={() => useEditorStore.getState().resetZoom()}
            title={t('editor.zoom.reset')}
            className="h-8 min-w-[3.2rem] border-x border-border px-1 text-[13px] tabular-nums text-muted hover:text-text"
          >
            {t('editor.zoom.value', { percent: Math.round(zoom * 100) })}
          </button>
          <IconButton
            size="sm"
            variant="ghost"
            label={`${t('editor.zoom.in')} ${shortcutLabel(EDITOR_SHORTCUTS.zoomIn)}`}
            icon={<span className="text-sm leading-none">+</span>}
            onClick={() => useEditorStore.getState().zoomIn()}
          />
        </div>

        {/* Scope */}
        <div
          role="group"
          aria-label={t('editor.scope.label')}
          className="flex rounded-md border border-border"
        >
          {SCOPES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={scope === option}
              data-testid={`scope-${option}`}
              onClick={() => useEditorStore.getState().setScope(option)}
              className={
                'h-8 px-2.5 text-[13px] transition-colors ' +
                (scope === option
                  ? 'bg-raised text-text'
                  : 'text-muted hover:bg-raised hover:text-text')
              }
            >
              {t(`editor.scope.${option}`)}
            </button>
          ))}
        </div>

        <span className="hidden h-5 w-px bg-border sm:block" />

        {/* Font family / size */}
        <Dropdown
          testId="font-family"
          label={t('editor.font.familyLabel')}
          trigger={<span className="max-w-[9rem] truncate">{familyLabel}</span>}
          entries={familyEntries}
          disabled={needsSelection}
        />
        <Dropdown
          testId="font-size"
          label={t('editor.font.sizeLabel')}
          trigger={<span className="min-w-[3.5rem]">{sizeLabel}</span>}
          entries={sizeEntries}
          disabled={needsSelection}
        />

        <IconButton
          size="sm"
          variant="secondary"
          label={t('editor.font.bold')}
          aria-pressed={activeBlock?.bold ?? false}
          data-testid="style-bold"
          icon={<span className="text-xs font-bold leading-none">B</span>}
          disabled={needsSelection}
          onClick={() => void apply({ bold: !(activeBlock?.bold ?? false) })}
        />
        <IconButton
          size="sm"
          variant="secondary"
          label={t('editor.font.italic')}
          aria-pressed={activeBlock?.italic ?? false}
          data-testid="style-italic"
          icon={<span className="text-xs italic leading-none">I</span>}
          disabled={needsSelection}
          onClick={() => void apply({ italic: !(activeBlock?.italic ?? false) })}
        />

        <Dropdown
          testId="style-align"
          label={t('editor.align.label')}
          trigger={<span>{t(`editor.align.${activeBlock?.alignment ?? 'left'}`)}</span>}
          entries={alignEntries}
          disabled={needsSelection}
        />

        <label
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-[13px] text-muted"
          title={t('editor.font.color')}
        >
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 rounded-sm border border-border"
            style={{ background: activeBlock?.color ?? '#000000' }}
          />
          <input
            type="color"
            data-testid="style-color"
            aria-label={t('editor.font.color')}
            className="sr-only"
            defaultValue={activeBlock?.color ?? '#000000'}
            disabled={needsSelection}
            onChange={(event) => void apply({ color: event.target.value })}
          />
          {t('editor.font.color')}
        </label>

        <span className="h-5 w-px bg-border" />

        {/* History */}
        <IconButton
          size="sm"
          variant="secondary"
          label={`${t('editor.undo')} ${shortcutLabel(EDITOR_SHORTCUTS.undo)}`}
          data-testid="undo"
          icon={<span className="text-sm leading-none">↺</span>}
          disabled={undoDepth === 0}
          onClick={() => void undo()}
        />
        <IconButton
          size="sm"
          variant="secondary"
          label={`${t('editor.redo')} ${shortcutLabel(EDITOR_SHORTCUTS.redo)}`}
          data-testid="redo"
          icon={<span className="text-sm leading-none">↻</span>}
          disabled={redoDepth === 0}
          onClick={() => void redo()}
        />

        <Button
          size="sm"
          variant={findOpen ? 'primary' : 'secondary'}
          aria-pressed={findOpen}
          data-testid="toggle-find"
          iconLeft={<IconSearch className="h-3.5 w-3.5" />}
          title={`${t('editor.find.toggle')} ${shortcutLabel(EDITOR_SHORTCUTS.find)}`}
          onClick={() => useEditorStore.getState().setFindOpen(!findOpen)}
        >
          {t('editor.find.toggle')}
        </Button>

        <Dropdown
          testId="retranslate"
          label={t('editor.retranslate.button')}
          trigger={<span>{t('editor.retranslate.button')}</span>}
          entries={retranslateEntries}
        />

        {overflowIds.length > 0 ? (
          <span
            data-testid="overflow-count"
            className="inline-flex h-8 items-center rounded-md border border-warning/40 bg-warning-bg px-2 text-[12px] text-warning"
          >
            {t('editor.style.overflowCount', { count: overflowIds.length })}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            data-testid="open-export"
            iconLeft={<IconDownload className="h-3.5 w-3.5" />}
            title={`${t('editor.export.button')} ${shortcutLabel(EDITOR_SHORTCUTS.export)}`}
            onClick={onExport}
          >
            {t('editor.export.button')}
          </Button>
        </div>
      </div>

      {busy ? (
        <Progress
          value={busy.ratio * 100}
          label={t(`editor.busy.${busy.kind}`, { done: busy.done, total: busy.total })}
        />
      ) : null}
    </div>
  )
}
