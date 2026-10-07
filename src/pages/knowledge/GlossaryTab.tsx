/**
 * Glossary tab of the Knowledge page (Phase 4): scope-aware browsing, manual
 * entry, CSV/TSV import & export and project re-validation.
 *
 * Scope is encoded as `all` / `global` / `<projectId>` and mapped onto the
 * repository's `list(projectId?: string | null)` contract: `undefined` = every
 * row, `null` = the shared (global) glossary, a string = that project only.
 */

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Switch,
  Table,
  type TableColumn,
} from '@/components/ui'
import {
  IconDownload,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUpload,
} from '@/components/layout/icons'
import { glossaryRepo } from '@/db/repo-knowledge'
import { projectRepo } from '@/db/repo-projects'
import type { GlossaryRecord, ProjectRecord } from '@/db/types'
import { buildGlossaryCsv, duplicateRows, parseGlossaryCsv } from '@/knowledge/glossaryCsv'
import { validateProjectGlossary } from '@/knowledge/validate'
import { baseName, downloadBlob } from '@/lib/download'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/stores/toastStore'

const SCOPE_ALL = 'all'
const SCOPE_GLOBAL = 'global'
const NO_ROWS: GlossaryRecord[] = []
const NO_PROJECTS: ProjectRecord[] = []

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function GlossaryTab() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'

  const [scope, setScope] = useState(SCOPE_ALL)
  const [search, setSearch] = useState('')
  const [sourceTerm, setSourceTerm] = useState('')
  const [targetTerm, setTargetTerm] = useState('')
  const [notes, setNotes] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<GlossaryRecord | null>(null)
  const [busy, setBusy] = useState<'import' | 'validate' | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const projects = useLiveQuery(() => projectRepo.list(), []) ?? NO_PROJECTS
  const scopeKey = scope === SCOPE_ALL ? undefined : scope === SCOPE_GLOBAL ? null : scope
  const rows = useLiveQuery(() => glossaryRepo.list(scopeKey), [scopeKey]) ?? NO_ROWS

  const selectedProject = projects.find((project) => project.id === scope)
  const isProjectScope = scope !== SCOPE_ALL && scope !== SCOPE_GLOBAL
  const canAdd = sourceTerm.trim().length > 0 && targetTerm.trim().length > 0

  const needle = search.trim().toLowerCase()
  const filtered = needle
    ? rows.filter(
        (row) =>
          row.sourceTerm.toLowerCase().includes(needle) ||
          row.targetTerm.toLowerCase().includes(needle),
      )
    : rows

  const scopeOptions = [
    { value: SCOPE_ALL, label: t('knowledge.glossary.scopeAll') },
    { value: SCOPE_GLOBAL, label: t('knowledge.glossary.scopeGlobal') },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ]

  function langs(): { sourceLang: string; targetLang: string } {
    return {
      sourceLang: selectedProject ? selectedProject.sourceLang : 'en',
      targetLang: selectedProject ? selectedProject.targetLang : 'my',
    }
  }

  async function addTerm() {
    if (!canAdd) return
    const source = sourceTerm.trim()
    const duplicate = rows.some(
      (row) => row.sourceTerm.trim().toLowerCase() === source.toLowerCase(),
    )
    if (duplicate) {
      toast(
        'warning',
        t('knowledge.glossary.duplicateTitle'),
        t('knowledge.glossary.duplicateBody', { term: source }),
      )
      return
    }
    await glossaryRepo.create({
      projectId: selectedProject ? selectedProject.id : null,
      sourceTerm: source,
      targetTerm: targetTerm.trim(),
      notes: notes.trim(),
      caseSensitive,
      ...langs(),
    })
    toast('success', t('knowledge.glossary.addedTitle'), source)
    setSourceTerm('')
    setTargetTerm('')
    setNotes('')
    setCaseSensitive(false)
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void addTerm()
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy('import')
    try {
      const parsed = parseGlossaryCsv(await file.text())
      const duplicates = new Set(duplicateRows(parsed.rows))
      const fresh = parsed.rows.filter((_, index) => !duplicates.has(index))

      if (parsed.errors.length > 0) {
        toast(
          'warning',
          t('knowledge.glossary.importErrorsTitle'),
          t('knowledge.glossary.importErrorsBody', { count: parsed.errors.length }),
        )
      }
      if (duplicates.size > 0) {
        toast(
          'warning',
          t('knowledge.glossary.importDuplicatesTitle'),
          t('knowledge.glossary.importDuplicatesBody', { count: duplicates.size }),
        )
      }

      for (const row of fresh) {
        await glossaryRepo.create({
          projectId: selectedProject ? selectedProject.id : null,
          sourceTerm: row.sourceTerm,
          targetTerm: row.targetTerm,
          notes: row.notes,
          caseSensitive: row.caseSensitive,
          ...langs(),
        })
      }

      toast(
        'success',
        t('knowledge.glossary.importedTitle'),
        t('knowledge.glossary.importedBody', {
          file: baseName(file.name),
          count: fresh.length,
          skipped: duplicates.size,
        }),
      )
    } catch (error) {
      toast('danger', t('toast.failed'), messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  function handleExport() {
    const csv = buildGlossaryCsv(
      rows.map((row) => ({
        sourceTerm: row.sourceTerm,
        targetTerm: row.targetTerm,
        notes: row.notes,
        caseSensitive: row.caseSensitive,
      })),
    )
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'glossary.csv')
    toast(
      'success',
      t('knowledge.glossary.exportedTitle'),
      t('knowledge.glossary.exportedBody', { count: rows.length }),
    )
  }

  async function revalidate() {
    if (!isProjectScope) return
    setBusy('validate')
    try {
      const result = await validateProjectGlossary(scope)
      const description = t('knowledge.glossary.validateBody', {
        checked: result.checked,
        flagged: result.flagged,
        cleared: result.cleared,
      })
      if (result.flagged > 0) {
        toast('warning', t('knowledge.glossary.validateIssuesTitle'), description)
      } else {
        toast('success', t('knowledge.glossary.validateCleanTitle'), description)
      }
    } catch (error) {
      toast('danger', t('toast.failed'), messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    await glossaryRepo.remove(pendingDelete.id)
    setPendingDelete(null)
  }

  const columns: TableColumn<GlossaryRecord>[] = [
    {
      key: 'source',
      header: t('knowledge.glossary.colSource'),
      render: (row) => <span className="font-medium">{row.sourceTerm}</span>,
    },
    {
      key: 'target',
      header: t('knowledge.glossary.colTarget'),
      render: (row) => row.targetTerm,
    },
    {
      key: 'notes',
      header: t('knowledge.glossary.notesLabel'),
      render: (row) => <span className="text-muted">{row.notes || '—'}</span>,
    },
    {
      key: 'case',
      header: t('knowledge.glossary.colCase'),
      render: (row) => (
        <Badge tone={row.caseSensitive ? 'info' : 'neutral'}>
          {row.caseSensitive ? t('common.yes') : t('common.no')}
        </Badge>
      ),
    },
    {
      key: 'updated',
      header: t('common.updated'),
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-muted">
          {formatDateTime(row.updatedAt, locale)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      align: 'right',
      render: (row) => (
        <IconButton
          size="sm"
          variant="danger"
          label={t('knowledge.glossary.deleteLabel', { term: row.sourceTerm })}
          icon={<IconTrash />}
          onClick={() => setPendingDelete(row)}
        />
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-2 sm:gap-3">
          <div className="w-56">
            <Select
              label={t('knowledge.glossary.scopeLabel')}
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              options={scopeOptions}
            />
          </div>
          <div className="min-w-48 flex-1">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('knowledge.glossary.searchPlaceholder')}
              aria-label={t('knowledge.glossary.searchPlaceholder')}
              iconLeft={<IconSearch className="h-4 w-4" />}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              iconLeft={<IconUpload className="h-4 w-4" />}
              loading={busy === 'import'}
              onClick={() => fileRef.current?.click()}
            >
              {t('knowledge.glossary.import')}
            </Button>
            <Button
              size="sm"
              iconLeft={<IconDownload className="h-4 w-4" />}
              disabled={rows.length === 0}
              onClick={handleExport}
            >
              {t('knowledge.glossary.export')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              iconLeft={<IconRefresh className="h-4 w-4" />}
              disabled={!isProjectScope}
              loading={busy === 'validate'}
              onClick={() => void revalidate()}
            >
              {t('knowledge.glossary.validate')}
            </Button>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,text/csv"
          hidden
          onChange={(event) => void handleImport(event)}
        />

        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          {t('knowledge.glossary.validateHint')}
        </p>
      </Card>

      <Card title={t('knowledge.glossary.addTitle')}>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('knowledge.glossary.sourceLabel')}
              value={sourceTerm}
              onChange={(event) => setSourceTerm(event.target.value)}
            />
            <Input
              label={t('knowledge.glossary.targetLabel')}
              value={targetTerm}
              onChange={(event) => setTargetTerm(event.target.value)}
            />
          </div>
          <Input
            label={t('knowledge.glossary.notesLabel')}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <Switch
            checked={caseSensitive}
            onChange={setCaseSensitive}
            label={t('knowledge.glossary.caseSensitiveLabel')}
            description={t('knowledge.glossary.caseSensitiveDesc')}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              iconLeft={<IconPlus className="h-4 w-4" />}
              disabled={!canAdd}
            >
              {t('common.add')}
            </Button>
          </div>
        </form>
      </Card>

      <Table
        columns={columns}
        rows={filtered}
        rowKey={(row) => row.id}
        caption={t('knowledge.tabs.glossary')}
        empty={
          rows.length > 0 ? (
            <EmptyState
              size="sm"
              title={t('knowledge.glossary.noResults')}
              action={
                <Button size="sm" onClick={() => setSearch('')}>
                  {t('common.clear')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              size="sm"
              title={t('knowledge.glossary.emptyTitle')}
              body={t('knowledge.glossary.emptyBody')}
            />
          )
        }
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('knowledge.glossary.deleteTitle')}
        body={t('knowledge.glossary.deleteBody', { term: pendingDelete?.sourceTerm ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
