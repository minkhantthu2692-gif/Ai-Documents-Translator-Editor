/**
 * Export dialog (Phase 4): format picker, per-format options, font preflight
 * and the run itself — collect → render → build → write — with a live
 * progress bar and a toast once the artifact reaches the browser.
 *
 * Closing the dialog (Escape, the close button or the backdrop) aborts a run
 * that is still in flight through an `AbortSignal`, and a failure keeps the
 * dialog open so the message stays readable.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dropdown,
  Input,
  Modal,
  Progress,
  Switch,
  type DropdownEntry,
} from '@/components/ui'
import { IconAlert, IconDownload, IconFile } from '@/components/layout/icons'
import { projectRepo } from '@/db/repo-projects'
import { ExportBuildError } from '@/export/progress'
import { deliverExport, preflightProject, runExport, type FontPreflight } from '@/export/runExport'
import { fileNameFor, FORMAT_EXTENSIONS, slugify, type DocumentStats } from '@/export/shared'
import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportFormat,
  type ExportOptions,
  type ExportProgress,
} from '@/export/types'
import { formatBytes } from '@/lib/format'
import { toast } from '@/stores/toastStore'

export interface ExportDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
}

interface FormatGroup {
  key: string
  formats: readonly ExportFormat[]
}

/** The dropdown's sections: PDF first, then documents, data and images. */
const FORMAT_GROUPS: readonly FormatGroup[] = [
  { key: 'pdf', formats: ['pdf', 'pdf-raster', 'bilingual-pdf'] },
  { key: 'documents', formats: ['docx', 'html', 'markdown', 'text', 'epub'] },
  { key: 'data', formats: ['json', 'csv', 'tsv'] },
  { key: 'images', formats: ['images'] },
]

/** Formats that can print the source text beside/before the translation. */
const ORIGINAL_FORMATS: readonly ExportFormat[] = ['html', 'docx', 'markdown', 'text', 'epub']

/** Layout formats that can carry the rendered page artwork. */
const ARTWORK_FORMATS: readonly ExportFormat[] = ['html', 'pdf']

const BILINGUAL_MODES = ['side-by-side', 'interleaved'] as const

const IMAGE_FORMATS = ['png', 'jpg'] as const

/** `report.pdf` → `report`; the export appends the real extension itself. */
function stripExtension(value: string): string {
  return value.replace(/\.[A-Za-z0-9]+$/, '')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

/** Plain checkbox (the kit has no Checkbox; Switch would be too heavy here). */
function Checkbox({ checked, onChange, label, disabled }: CheckboxProps) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span>{label}</span>
    </label>
  )
}

export function ExportDialog({ open, onClose, projectId }: ExportDialogProps) {
  const { t } = useTranslation()
  const radioName = useId()
  const [options, setOptions] = useState<ExportOptions>(() => ({ ...DEFAULT_EXPORT_OPTIONS }))
  const [preflight, setPreflight] = useState<FontPreflight | null>(null)
  const [substitute, setSubstitute] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [summary, setSummary] = useState<DocumentStats | null>(null)
  const runSeqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  /**
   * Every time the dialog opens: the file name starts from the project slug
   * and the font preflight decides whether a warning is needed. The
   * `cancelled` flag drops results that arrive after the dialog re-opened for
   * another project (a stale async result must never win).
   */
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    runSeqRef.current += 1
    setPreflight(null)
    setSubstitute(true)
    setRunning(false)
    setProgress(null)
    setSummary(null)
    void Promise.all([
      preflightProject(projectId).catch(() => null),
      projectRepo.get(projectId).catch(() => undefined),
    ]).then(([check, project]) => {
      if (cancelled) return
      setPreflight(check)
      if (project) setOptions((current) => ({ ...current, fileName: slugify(project.name) }))
    })
    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
  }, [open, projectId])

  /** Closes the dialog and cancels a run that is still in flight. */
  const requestClose = useCallback(() => {
    runSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
    setProgress(null)
    onClose()
  }, [onClose])

  async function handleExport() {
    if (running) return
    const controller = new AbortController()
    abortRef.current = controller
    runSeqRef.current += 1
    const runId = runSeqRef.current
    setRunning(true)
    setProgress({ stage: 'collect', done: 0, total: 1, ratio: 0 })
    const fontSubstitutions = substitute && preflight ? preflight.substitutions : undefined

    try {
      const result = await runExport({
        projectId,
        options: { ...options, fileName: stripExtension(options.fileName) },
        ...(fontSubstitutions ? { fontSubstitutions } : {}),
        keepMissingFonts: !substitute,
        onProgress: (next) => {
          if (runSeqRef.current === runId) setProgress(next)
        },
        signal: controller.signal,
      })
      // Closed (or re-opened) while the worker was busy: nothing to show.
      if (runSeqRef.current !== runId || controller.signal.aborted) return

      setSummary(result.stats)
      const delivery = await deliverExport(result)
      if (runSeqRef.current !== runId) return

      if (delivery.ok) {
        toast(
          'success',
          t('export.doneTitle'),
          t('export.doneBody', {
            file: result.artifact.fileName || fileNameFor(result.options, result.artifact.format),
            kb: formatBytes(result.artifact.bytes),
            seconds: (result.durationMs / 1000).toFixed(1),
          }),
        )
      } else {
        toast('warning', t('export.issueTitle'), delivery.detail)
      }

      for (const issue of result.issues) {
        if (issue.code === 'EXPORT_FONT_MISSING') {
          toast(
            'warning',
            t('export.issueFontsTitle'),
            t('export.issueFontsBody', { mappings: issue.detail || issue.fonts.join(', ') }),
          )
        } else if (issue.code === 'EXPORT_LAYOUT_ESTIMATED') {
          toast('warning', t('export.issueLayoutTitle'), t('export.issueLayoutBody'))
        } else if (issue.code === 'EXPORT_LAYOUT_CLIPPED') {
          toast(
            'warning',
            t('export.issueClippedTitle', { count: issue.count ?? 0 }),
            t('export.issueClippedBody'),
          )
        } else {
          toast('warning', t('export.issueTitle'), issue.detail)
        }
      }
    } catch (error) {
      if (runSeqRef.current !== runId || controller.signal.aborted) return
      const detail = error instanceof ExportBuildError ? error.message : messageOf(error)
      toast('danger', t('export.failedTitle'), detail)
    } finally {
      if (runSeqRef.current === runId) {
        setRunning(false)
        setProgress(null)
        abortRef.current = null
      }
    }
  }

  if (!open) return null

  const format = options.format
  const showOriginal = ORIGINAL_FORMATS.includes(format)
  const showBilingual = format === 'bilingual-pdf'
  const showImageFormat = format === 'images'
  const showArtwork = ARTWORK_FORMATS.includes(format)
  const showPdfExplainer = format === 'pdf' || format === 'bilingual-pdf'
  const showRasterExplainer = format === 'pdf-raster'
  const showOptions = showOriginal || showBilingual || showImageFormat || showArtwork
  const showFontWarning = preflight !== null && preflight.missing.length > 0

  const entries: DropdownEntry[] = FORMAT_GROUPS.flatMap((group, index): DropdownEntry[] => [
    ...(index > 0 ? [{ id: `sep-${group.key}`, kind: 'separator' as const }] : []),
    {
      id: `head-${group.key}`,
      kind: 'heading' as const,
      label: t(`export.group.${group.key}`),
    },
    ...group.formats.map((entry): DropdownEntry => ({
      id: entry,
      label: t(`export.format.${entry}`),
      hint: FORMAT_EXTENSIONS[entry],
      selected: entry === format,
      onSelect: () => setOptions((current) => ({ ...current, format: entry })),
    })),
  ])

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={t('export.title')}
      closeLabel={t('common.close')}
      size="lg"
      footer={
        <>
          {summary ? (
            <p className="mr-auto text-xs text-muted">
              {t('export.summary', {
                pages: summary.pages,
                blocks: summary.blocks,
                translated: summary.translated,
              })}
            </p>
          ) : null}
          <Button variant="ghost" onClick={requestClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            iconLeft={<IconDownload />}
            disabled={running}
            onClick={() => void handleExport()}
            data-testid="export-run"
          >
            {t('common.export')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text">{t('export.asLabel')}</span>
          <div>
            <Dropdown
              testId={`export-format-${format}`}
              disabled={running}
              width={260}
              trigger={
                <>
                  <IconFile className="h-4 w-4 text-faint" />
                  <span>{t(`export.format.${format}`)}</span>
                </>
              }
              entries={entries}
            />
          </div>
        </div>

        {showOptions ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
            {showOriginal ? (
              <Checkbox
                checked={options.includeOriginal}
                disabled={running}
                onChange={(checked) =>
                  setOptions((current) => ({ ...current, includeOriginal: checked }))
                }
                label={t('export.includeOriginal')}
              />
            ) : null}

            {showBilingual ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-[13px] font-medium text-text">
                  {t('export.bilingualLabel')}
                </legend>
                {BILINGUAL_MODES.map((mode) => (
                  <label
                    key={mode}
                    className="flex cursor-pointer items-center gap-2 text-sm text-text"
                  >
                    <input
                      type="radio"
                      name={radioName}
                      className="h-4 w-4 accent-primary"
                      checked={options.bilingual === mode}
                      disabled={running}
                      onChange={() => setOptions((current) => ({ ...current, bilingual: mode }))}
                    />
                    {t(`export.bilingual.${mode}`)}
                  </label>
                ))}
              </fieldset>
            ) : null}

            {showImageFormat ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-[13px] font-medium text-text">
                  {t('export.imageFormatLabel')}
                </legend>
                {IMAGE_FORMATS.map((value) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-center gap-2 text-sm text-text"
                  >
                    <input
                      type="radio"
                      name={radioName}
                      className="h-4 w-4 accent-primary"
                      checked={options.imageFormat === value}
                      disabled={running}
                      onChange={() => setOptions((current) => ({ ...current, imageFormat: value }))}
                    />
                    {t(`export.imageFormat.${value}`)}
                  </label>
                ))}
              </fieldset>
            ) : null}

            {showArtwork ? (
              <Checkbox
                checked={options.includeImages}
                disabled={running}
                onChange={(checked) =>
                  setOptions((current) => ({ ...current, includeImages: checked }))
                }
                label={t('export.includeImages')}
              />
            ) : null}
          </div>
        ) : null}

        <Input
          label={t('export.fileName')}
          value={options.fileName}
          disabled={running}
          spellCheck={false}
          autoComplete="off"
          data-testid="export-file-name"
          onChange={(event) =>
            setOptions((current) => ({ ...current, fileName: stripExtension(event.target.value) }))
          }
        />

        {showPdfExplainer ? (
          <p className="text-xs leading-relaxed text-muted">{t('export.pdfExplainer')}</p>
        ) : null}
        {showRasterExplainer ? (
          <p className="text-xs leading-relaxed text-muted">{t('export.rasterExplainer')}</p>
        ) : null}

        {showFontWarning && preflight ? (
          <div
            data-testid="export-font-warning"
            data-tone="warning"
            className="flex flex-col gap-2 rounded-lg border border-warning bg-surface p-3"
          >
            <div className="flex items-center gap-2">
              <IconAlert className="h-4 w-4 text-warning" />
              <p className="text-sm font-medium text-text">{t('export.missingFontsTitle')}</p>
            </div>
            <p className="text-xs leading-relaxed text-muted">{t('export.missingFontsBody')}</p>
            <ul className="flex flex-col gap-1">
              {preflight.missing.map((family) => (
                <li key={family} className="text-xs text-text">
                  {family} → {preflight.substitutions[family] ?? t('common.none')}
                </li>
              ))}
            </ul>
            <Switch
              checked={substitute}
              onChange={setSubstitute}
              disabled={running}
              label={t('export.substituteFonts')}
              className="border-t border-border pt-2"
            />
          </div>
        ) : null}

        {running ? (
          <div
            data-testid="export-progress"
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
          >
            <Progress
              value={(progress?.ratio ?? 0) * 100}
              showLabel
              label={t(`export.stage.${progress?.stage ?? 'collect'}`)}
            />
            <p className="text-xs tabular-nums text-muted">
              {`${progress?.done ?? 0}/${progress?.total ?? 0}`}
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
