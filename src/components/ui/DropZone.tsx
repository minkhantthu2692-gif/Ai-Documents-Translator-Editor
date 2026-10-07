import { useCallback, useId, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Button } from './Button'
import { IconUpload } from '@/components/layout/icons'

export interface DropZoneProps {
  /** Receives the picked files (already filtered to `accept`). */
  onFiles: (files: File[]) => void
  accept?: string
  multiple?: boolean
  disabled?: boolean
  /** Overrides the default headline. */
  title?: string
  /** Overrides the default "…or" line. */
  hint?: string
  className?: string
  'data-testid'?: string
}

/**
 * Drag-and-drop target plus a real file picker (the button keeps keyboard and
 * screen-reader access — a drop area alone would not be operable without a
 * mouse).
 *
 * Both paths funnel through `accept` filtering here; type/size policy stays in
 * `@/pdf/fileValidation` so the wizard and this component agree on rules.
 */
export function DropZone({
  onFiles,
  accept = '.pdf,application/pdf',
  multiple = true,
  disabled = false,
  title,
  hint,
  className,
  'data-testid': testId = 'drop-zone',
}: DropZoneProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const depthRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const inputId = useId()

  const emit = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return
      const files = Array.from(list)
      onFiles(multiple ? files : files.slice(0, 1))
    },
    [multiple, onFiles],
  )

  const openPicker = useCallback(() => {
    if (disabled) return
    inputRef.current?.click()
  }, [disabled])

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (disabled) return
    depthRef.current += 1
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    depthRef.current = Math.max(0, depthRef.current - 1)
    if (depthRef.current === 0) setDragging(false)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    depthRef.current = 0
    setDragging(false)
    if (disabled) return
    emit(event.dataTransfer?.files ?? null)
  }

  return (
    <div
      data-testid={testId}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 text-center transition-colors',
        dragging ? 'border-primary bg-info-bg' : 'border-border bg-raised/40',
        disabled && 'pointer-events-none opacity-60',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-md border',
          dragging
            ? 'border-primary/40 bg-surface text-primary'
            : 'border-border bg-surface text-muted',
        )}
      >
        <IconUpload className="h-5 w-5" />
      </span>

      <p className="text-sm font-medium text-text">
        {dragging ? t('dropzone.dragOver') : (title ?? t('dropzone.title'))}
      </p>
      <p className="text-xs text-muted">{hint ?? t('dropzone.hint')}</p>

      <div className="mt-1 flex items-center gap-3 text-xs text-faint">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={openPicker}
          data-testid="dropzone-browse"
        >
          {t('dropzone.browse')}
        </Button>
        <span aria-hidden="true">{t('dropzone.or')}</span>
      </div>

      <label htmlFor={inputId} className="sr-only">
        {t('dropzone.browse')}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        data-testid="file-input"
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          emit(event.target.files)
          // Allow re-picking the same file after it was removed.
          event.target.value = ''
        }}
      />
    </div>
  )
}
