/**
 * Inspector column (Phase 4): the active block (source, translation,
 * pending suggestion, glossary hits, overflow, lock and re-translation), its
 * revision history and the document-wide counters — three tabs bound to the
 * editor store.
 *
 * Every durable change goes through `commitCommand`, so a manual edit, a
 * restored revision and an AI suggestion behave identically for undo, history
 * and auto-save. This file only owns what goes inside the page's column: a
 * `Tabs` control on top, a stack of `Card`s below it.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Switch,
  Tabs,
  Textarea,
  type TabItem,
} from '@/components/ui'
import { IconAlert } from '@/components/layout/icons'
import { glossaryRepo } from '@/db/repo-knowledge'
import { projectRepo } from '@/db/repo-projects'
import { revisionRepo } from '@/db/repo-revisions'
import type { RevisionRecord } from '@/db/types'
import { patchTargets } from '@/editor/blocks'
import { commandFrom, commitCommand, type IndexedBlock } from '@/editor/commands'
import { acceptSuggestion, rejectSuggestion, retranslate, setBlockLock } from '@/editor/retranslate'
import { useEditorStore } from '@/editor/store'
import { currentTemplateId, templateById } from '@/editor/templates'
import type { BlockPatch } from '@/editor/types'
import { activeTerms, containsTerm, termIsHonoured, type GlossaryTerm } from '@/knowledge/validate'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { containsMyanmar, directionOf } from '@/lib/text'
import { toast } from '@/stores/toastStore'

/** How many revisions the history tab shows before it mentions the rest. */
const HISTORY_SHOWN = 20
/** Fetched one past the display cap so "there is more" is knowable. */
const HISTORY_FETCH = HISTORY_SHOWN + 1

export interface BlockInspectorProps {
  /** Project the blocks belong to (also scopes glossary and template). */
  projectId: string
  /** The block the inspector describes; `null` leaves only Document usable. */
  block: IndexedBlock | null
  /** Every block of the project — the Document tab derives its counts. */
  blocks: IndexedBlock[]
}

export function BlockInspector({ projectId, block, blocks }: BlockInspectorProps) {
  const { t } = useTranslation()
  const inspectorTab = useEditorStore((state) => state.inspectorTab)
  const setInspectorTab = useEditorStore((state) => state.setInspectorTab)

  function handleTabChange(id: string): void {
    if (id === 'block' || id === 'history' || id === 'document') setInspectorTab(id)
  }

  const empty = (
    <EmptyState size="sm" title={t('editor.block.emptyTitle')} body={t('editor.block.emptyBody')} />
  )

  const items: TabItem[] = [
    {
      id: 'block',
      label: t('editor.tabs.block'),
      content: block ? <BlockTab projectId={projectId} block={block} /> : empty,
    },
    {
      id: 'history',
      label: t('editor.tabs.history'),
      content: block ? <HistoryTab block={block} /> : empty,
    },
    {
      id: 'document',
      label: t('editor.tabs.document'),
      content: <DocumentTab projectId={projectId} blocks={blocks} />,
    },
  ]

  return (
    <Tabs
      items={items}
      value={inspectorTab}
      onChange={handleTabChange}
      ariaLabel={t('editor.inspector.title')}
      className="min-h-0 flex-1"
    />
  )
}

/* ------------------------------------------------------------------ */
/* Block tab                                                           */
/* ------------------------------------------------------------------ */

interface BlockTabProps {
  projectId: string
  block: IndexedBlock
}

function BlockTab({ projectId, block }: BlockTabProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'
  const busy = useEditorStore((state) => state.busy)
  const setBusy = useEditorStore((state) => state.setBusy)

  const [draft, setDraft] = useState(block.translatedText)
  const [terms, setTerms] = useState<GlossaryTerm[]>([])
  const [confirmApply, setConfirmApply] = useState(false)

  // Follow the stored text whenever it actually changes (a reload, an undo,
  // an accepted suggestion) without clobbering half-typed edits.
  useEffect(() => {
    setDraft(block.translatedText)
  }, [block.id, block.translatedText])

  useEffect(() => {
    let cancelled = false
    activeTerms(projectId)
      .then((rows) => {
        if (!cancelled) setTerms(rows)
      })
      .catch(() => {
        if (!cancelled) setTerms([])
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const hits = useMemo(
    () =>
      terms.filter((term) => containsTerm(block.sourceText, term.sourceTerm, term.caseSensitive)),
    [terms, block],
  )

  const locked = block.status === 'locked'
  const running = busy !== null
  const canRun = !locked && !running

  function commitDraft(): void {
    if (draft === block.translatedText) return
    const targets = patchTargets([block], [block.id], () => ({
      translatedText: draft,
      status: 'edited',
    }))
    if (targets.length === 0) return
    void commitCommand(commandFrom('editor.cmd.editText', 'edit-text', targets, 'user')).catch(() =>
      toast('warning', t('toast.failed')),
    )
  }

  async function run(mode: 'apply' | 'suggest'): Promise<void> {
    setBusy({ kind: 'retranslate', done: 0, total: 1, ratio: 0 })
    try {
      const result = await retranslate({
        projectId,
        blockIds: [block.id],
        mode,
        onProgress: (done, total) =>
          setBusy({ kind: 'retranslate', done, total, ratio: total > 0 ? done / total : 0 }),
      })
      if (result.changed === 0) {
        toast('info', t('editor.block.retranslateNoneTitle'), t('editor.block.retranslateNoneBody'))
      }
    } catch {
      toast('warning', t('toast.failed'))
    } finally {
      setBusy(null)
    }
  }

  function handleApply(): void {
    if (block.translatedText.trim().length > 0) {
      setConfirmApply(true)
      return
    }
    void run('apply')
  }

  async function handleAccept(): Promise<void> {
    try {
      await acceptSuggestion(projectId, block.id)
    } catch {
      toast('warning', t('editor.block.suggestFailedTitle'), t('toast.failed'))
    }
  }

  async function handleReject(): Promise<void> {
    try {
      await rejectSuggestion(projectId, block.id)
    } catch {
      toast('warning', t('editor.block.suggestFailedTitle'), t('toast.failed'))
    }
  }

  async function handleLock(next: boolean): Promise<void> {
    try {
      await setBlockLock(projectId, block.id, next)
    } catch {
      toast('warning', t('toast.failed'))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('editor.block.source')}>
        <p
          dir={directionOf(block.sourceText)}
          className={cn(
            'whitespace-pre-wrap break-words text-sm text-muted',
            containsMyanmar(block.sourceText) && 'mm-text',
          )}
        >
          {block.sourceText || '—'}
        </p>
      </Card>

      <Card
        title={t('editor.block.translation')}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={draft === block.translatedText}
            onClick={commitDraft}
          >
            {t('common.save')}
          </Button>
        }
      >
        <Textarea
          aria-label={t('editor.block.translation')}
          rows={6}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
        />
        {block.overflow ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-warning">
            <IconAlert aria-hidden="true" />
            <span>{t('editor.block.overflowWarn')}</span>
          </p>
        ) : null}
      </Card>

      {block.suggestedText !== null ? (
        <Card
          title={t('editor.block.suggestion')}
          actions={
            <>
              <Button size="sm" onClick={() => void handleReject()}>
                {t('editor.block.reject')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void handleAccept()}>
                {t('editor.block.accept')}
              </Button>
            </>
          }
        >
          <p
            dir={directionOf(block.suggestedText)}
            className={cn(
              'whitespace-pre-wrap break-words text-sm text-text',
              containsMyanmar(block.suggestedText) && 'mm-text',
            )}
          >
            {block.suggestedText}
          </p>
          <p className="mt-2 text-xs text-muted">
            {t('editor.block.suggestionMeta', {
              model: block.suggestedModel ?? t('common.unknown'),
              when: block.suggestedAt
                ? formatRelative(block.suggestedAt, locale)
                : t('common.never'),
            })}
          </p>
        </Card>
      ) : null}

      {hits.length > 0 ? (
        <Card title={t('editor.glossary.title')}>
          <ul className="flex flex-col gap-2">
            {hits.map((term) => {
              const honoured = termIsHonoured(block.translatedText, term)
              return (
                <li
                  key={`${term.sourceTerm}::${term.targetTerm}`}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0 break-words text-sm text-text">
                    {term.sourceTerm} <span aria-hidden="true">→</span> {term.targetTerm}
                  </span>
                  <Badge tone={honoured ? 'success' : 'warning'}>
                    {honoured ? t('editor.glossary.honoured') : t('editor.glossary.miss')}
                  </Badge>
                </li>
              )
            })}
          </ul>
        </Card>
      ) : null}

      <Card title={t('editor.block.actions')}>
        <Switch
          checked={locked}
          onChange={(next) => void handleLock(next)}
          label={t('editor.block.lock')}
          description={t('editor.block.lockDesc')}
        />
        {locked ? (
          <p className="mt-2 text-xs text-warning">{t('editor.block.lockedHint')}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={running}
            disabled={!canRun}
            onClick={handleApply}
          >
            {t('editor.block.retranslate')}
          </Button>
          <Button
            size="sm"
            loading={running}
            disabled={!canRun}
            onClick={() => void run('suggest')}
          >
            {t('editor.block.alternative')}
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmApply}
        title={t('editor.block.confirmApplyTitle')}
        body={t('editor.block.confirmApplyBody')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        onConfirm={() => {
          setConfirmApply(false)
          void run('apply')
        }}
        onCancel={() => setConfirmApply(false)}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* History tab                                                         */
/* ------------------------------------------------------------------ */

interface HistoryTabProps {
  block: IndexedBlock
}

function HistoryTab({ block }: HistoryTabProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'
  const [rows, setRows] = useState<RevisionRecord[]>([])
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    revisionRepo
      .listByBlock(block.id, HISTORY_FETCH)
      .then((loaded) => {
        if (!cancelled) setRows(loaded)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [block.id, refresh])

  async function restore(row: RevisionRecord): Promise<void> {
    // Revision patches arrive untyped from Dexie; `commitCommand` sanitizes
    // them against the writable block fields before anything is persisted.
    const patch = row.before as unknown as BlockPatch
    const targets = patchTargets([block], [block.id], () => patch)
    if (targets.length === 0) return
    try {
      await commitCommand(commandFrom('editor.cmd.restore', 'restore', targets, 'user'))
      setRefresh((value) => value + 1)
    } catch {
      toast('warning', t('toast.failed'))
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        size="sm"
        title={t('editor.history.emptyTitle')}
        body={t('editor.history.emptyBody')}
      />
    )
  }

  const shown = rows.slice(0, HISTORY_SHOWN)
  const hasMore = rows.length > HISTORY_SHOWN

  return (
    <Card
      title={t('editor.history.title')}
      footer={hasMore ? t('editor.history.more', { count: HISTORY_SHOWN }) : undefined}
    >
      <ul className="divide-y divide-border">
        {shown.map((row) => {
          const preview = previewOf(row)
          return (
            <li key={row.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">{t(`editor.action.${row.action}`)}</p>
                <p className="text-xs text-muted">
                  {t('editor.history.byActor', { actor: row.actor })} ·{' '}
                  {formatDateTime(row.timestamp, locale)}
                </p>
                {preview ? (
                  <p className="mt-0.5 truncate text-xs text-faint" title={preview}>
                    {preview}
                  </p>
                ) : null}
              </div>
              <Button size="sm" onClick={() => void restore(row)}>
                {t('common.unarchive')}
              </Button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** `translatedText`-style values win; otherwise the first changed field. */
function previewOf(row: RevisionRecord): string {
  const textKeys = ['translatedText', 'sourceText', 'suggestedText']
  const textKey = textKeys.find((candidate) => candidate in row.after || candidate in row.before)
  const keys = Object.keys(row.after).length > 0 ? Object.keys(row.after) : Object.keys(row.before)
  const key = textKey ?? keys[0]
  if (!key) return ''
  return `${truncate(valueOf(row.before[key]))} → ${truncate(valueOf(row.after[key]))}`
}

function valueOf(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  return String(value)
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value
}

/* ------------------------------------------------------------------ */
/* Document tab                                                        */
/* ------------------------------------------------------------------ */

interface DocumentTabProps {
  projectId: string
  blocks: IndexedBlock[]
}

interface DocumentInfo {
  sourceLang: string
  targetLang: string
  templateId: string | null
  glossaryRows: number
}

interface StatRow {
  key: string
  label: string
  value: ReactNode
}

function DocumentTab({ projectId, blocks }: DocumentTabProps) {
  const { t, i18n } = useTranslation()
  const overflowIds = useEditorStore((state) => state.overflowIds)
  const [info, setInfo] = useState<DocumentInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [project, templateId, projectRows, globalRows] = await Promise.all([
          projectRepo.get(projectId),
          currentTemplateId(projectId),
          glossaryRepo.list(projectId),
          glossaryRepo.list(null),
        ])
        if (cancelled) return
        setInfo({
          sourceLang: project?.sourceLang ?? '',
          targetLang: project?.targetLang ?? '',
          templateId,
          glossaryRows: projectRows.length + globalRows.length,
        })
      } catch {
        if (!cancelled) {
          setInfo({ sourceLang: '', targetLang: '', templateId: null, glossaryRows: 0 })
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [projectId])

  const stats = useMemo(() => {
    const pages = new Set(blocks.map((block) => block.pageIndex)).size
    const translated = blocks.filter((block) => block.translatedText.trim().length > 0).length
    const suggestions = blocks.filter((block) => block.suggestedText !== null).length
    const locked = blocks.filter((block) => block.status === 'locked').length
    return {
      pages,
      translated,
      untranslated: Math.max(0, blocks.length - translated),
      suggestions,
      locked,
    }
  }, [blocks])

  const template = info ? templateById(info.templateId) : null
  const loading = <span className="font-normal text-muted">{t('common.loading')}</span>

  const rows: StatRow[] = [
    { key: 'pages', label: t('workspace.pageCount'), value: stats.pages },
    { key: 'blocks', label: t('workspace.blockCount'), value: blocks.length },
    { key: 'translated', label: t('editor.document.translated'), value: stats.translated },
    { key: 'untranslated', label: t('editor.document.untranslated'), value: stats.untranslated },
    { key: 'overflow', label: t('editor.document.overflow'), value: overflowIds.length },
    { key: 'suggestions', label: t('editor.document.suggestions'), value: stats.suggestions },
    { key: 'locked', label: t('editor.document.locked'), value: stats.locked },
    {
      key: 'template',
      label: t('editor.document.template'),
      value: info ? (
        template ? (
          <Badge tone="primary">{i18n.language === 'my' ? template.nameMy : template.nameEn}</Badge>
        ) : (
          t('common.none')
        )
      ) : (
        loading
      ),
    },
    {
      key: 'glossary',
      label: t('editor.document.glossaryRows'),
      value: info ? info.glossaryRows : loading,
    },
    {
      key: 'languagePair',
      label: t('workspace.languagePair'),
      value:
        info && info.sourceLang
          ? t('newProject.languagePair', { source: info.sourceLang, target: info.targetLang })
          : loading,
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('editor.document.title')}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex items-baseline justify-between gap-3 border-b border-border pb-2"
            >
              <dt className="text-xs text-muted">{row.label}</dt>
              <dd className="text-sm font-medium tabular-nums text-text">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}
