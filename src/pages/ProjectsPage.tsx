import { useState } from 'react'
import { Link } from 'react-router-dom'
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
  Modal,
  Progress,
  Select,
  Table,
  type TableColumn,
} from '@/components/ui'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import {
  IconArchive,
  IconDuplicate,
  IconEdit,
  IconGrid,
  IconList,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@/components/layout/icons'
import { projectRepo } from '@/db/repo-projects'
import type { ProjectRecord, ProjectStatus } from '@/db/types'
import { logEvent } from '@/core/eventLogger'
import { toast } from '@/stores/toastStore'
import { useUiStore } from '@/stores/uiStore'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/cn'

const STATUS_TONE: Record<ProjectStatus, 'neutral' | 'primary' | 'warning' | 'success' | 'danger'> =
  {
    draft: 'neutral',
    ready: 'primary',
    processing: 'primary',
    review: 'warning',
    done: 'success',
    failed: 'danger',
    archived: 'neutral',
  }

type PendingAction =
  | { kind: 'rename'; project: ProjectRecord }
  | { kind: 'duplicate'; project: ProjectRecord }
  | { kind: 'archive'; project: ProjectRecord }
  | { kind: 'delete'; project: ProjectRecord }
  | null

export function ProjectsPage() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'
  const view = useUiStore((state) => state.projectsView)
  const setView = useUiStore((state) => state.setProjectsView)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ProjectStatus | 'all'>('all')
  const [sort, setSort] = useState<'recent' | 'name' | 'progress'>('recent')
  const [showArchived, setShowArchived] = useState(false)
  const [pending, setPending] = useState<PendingAction>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)

  const projects = useLiveQuery(
    () => projectRepo.list({ search, status, includeArchived: showArchived, sort }),
    [search, status, showArchived, sort],
  )

  const statusOptions = [
    { value: 'all', label: t('projects.allStatuses') },
    { value: 'draft', label: t('projects.status.draft') },
    { value: 'ready', label: t('projects.status.ready') },
    { value: 'processing', label: t('projects.status.processing') },
    { value: 'review', label: t('projects.status.review') },
    { value: 'done', label: t('projects.status.done') },
    { value: 'failed', label: t('projects.status.failed') },
  ]

  const sortOptions = [
    { value: 'recent', label: t('projects.sortRecent') },
    { value: 'name', label: t('projects.sortName') },
    { value: 'progress', label: t('projects.sortProgress') },
  ]

  const hasFilters = search.trim() !== '' || status !== 'all' || showArchived
  const rows = projects ?? []
  const loading = projects === undefined

  function clearFilters() {
    setSearch('')
    setStatus('all')
    setShowArchived(false)
  }

  async function runAction() {
    if (!pending) return
    const { kind, project } = pending
    setBusy(true)
    try {
      if (kind === 'rename') {
        const name = renameValue.trim()
        if (!name) return
        await projectRepo.rename(project.id, name)
        logEvent({
          state: 'PROJECT',
          action: 'project.rename',
          projectId: project.id,
          severity: 'success',
          messageMy: `စီမံကိန်းအမည် ပြောင်းပြီး: ${name}`,
          messageEn: `Project renamed to: ${name}`,
          technicalDetail: `id=${project.id}`,
        })
        toast('success', t('common.saved'), name)
      }

      if (kind === 'duplicate') {
        const copy = await projectRepo.duplicate(project.id)
        logEvent({
          state: 'PROJECT',
          action: 'project.duplicate',
          projectId: copy.id,
          severity: 'success',
          messageMy: `စီမံကိန်း မိတ်တုပ်ဖန်တီးပြီး: ${copy.name}`,
          messageEn: `Project duplicated: ${copy.name}`,
          technicalDetail: `source=${project.id}`,
        })
        toast('success', t('common.duplicate'), copy.name)
      }

      if (kind === 'archive') {
        const nextArchived = !project.archived
        await projectRepo.archive(project.id, nextArchived)
        logEvent({
          state: 'PROJECT',
          action: nextArchived ? 'project.archive' : 'project.unarchive',
          projectId: project.id,
          severity: 'info',
          messageMy: nextArchived
            ? `သိမ်းဆည်းပြီး: ${project.name}`
            : `ပြန်ရယူပြီး: ${project.name}`,
          messageEn: nextArchived
            ? `Project archived: ${project.name}`
            : `Project restored: ${project.name}`,
          technicalDetail: `id=${project.id}`,
        })
        toast('success', t('common.saved'), project.name)
      }

      if (kind === 'delete') {
        await projectRepo.remove(project.id)
        logEvent({
          state: 'PROJECT',
          action: 'project.delete',
          projectId: project.id,
          severity: 'warning',
          messageMy: `စီမံကိန်း ဖျက်ပြီး: ${project.name}`,
          messageEn: `Project deleted: ${project.name}`,
          technicalDetail: `id=${project.id}`,
        })
        toast('warning', t('common.delete'), project.name)
      }

      setPending(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent({
        state: 'PROJECT',
        action: `project.${kind}.failed`,
        projectId: project.id,
        severity: 'error',
        messageMy: 'လုပ်ဆောင်ချက် မအောင်မြင်ပါ',
        messageEn: 'The action could not be completed',
        technicalDetail: message,
      })
      toast('danger', t('toast.failed'), message)
    } finally {
      setBusy(false)
    }
  }

  function openRename(project: ProjectRecord) {
    setRenameValue(project.name)
    setPending({ kind: 'rename', project })
  }

  const columns: TableColumn<ProjectRecord>[] = [
    {
      key: 'name',
      header: t('common.name'),
      render: (project) => (
        <div className="flex min-w-0 flex-col">
          <Link
            to={`/workspace/${project.id}`}
            className="truncate font-medium text-text hover:text-accent"
          >
            {project.name}
          </Link>
          <span className="truncate text-[11px] text-faint">
            {project.sourceFileName ?? t('workspace.noFile')}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (project) => (
        <Badge tone={STATUS_TONE[project.status]}>{t(`projects.status.${project.status}`)}</Badge>
      ),
    },
    {
      key: 'progress',
      header: t('common.progress'),
      className: 'w-40',
      render: (project) => (
        <div className="flex items-center gap-2">
          <Progress
            value={project.progress}
            size="sm"
            className="min-w-20 flex-1"
            ariaLabel={`${project.name}: ${project.progress}%`}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted">{project.progress}%</span>
        </div>
      ),
    },
    {
      key: 'pages',
      header: t('workspace.pageCount'),
      align: 'right',
      render: (project) => <span className="tabular-nums">{project.pageCount}</span>,
    },
    {
      key: 'updated',
      header: t('projects.lastOpened'),
      render: (project) => (
        <span className="whitespace-nowrap text-xs text-muted">
          {formatRelative(project.lastOpenedAt, locale)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      align: 'right',
      render: (project) => (
        <RowActions project={project} onRename={openRename} onPending={setPending} />
      ),
    },
  ]

  return (
    <PageContainer>
      <PageHeader
        title={t('projects.title')}
        subtitle={t('projects.subtitle')}
        actions={
          <Link to="/projects/new">
            <Button variant="primary" size="sm" iconLeft={<IconPlus className="h-4 w-4" />}>
              {t('projects.create')}
            </Button>
          </Link>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2 sm:gap-3">
          <div className="min-w-48 flex-1">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('projects.searchPlaceholder')}
              aria-label={t('projects.searchPlaceholder')}
              iconLeft={<IconSearch className="h-4 w-4" />}
            />
          </div>
          <div className="w-40">
            <Select
              aria-label={t('projects.statusFilter')}
              value={status}
              onChange={(event) => setStatus(event.target.value as ProjectStatus | 'all')}
              options={statusOptions}
              hideLabel
              label={t('projects.statusFilter')}
            />
          </div>
          <div className="w-36">
            <Select
              aria-label={t('common.filter')}
              value={sort}
              onChange={(event) => setSort(event.target.value as 'recent' | 'name' | 'progress')}
              options={sortOptions}
              hideLabel
              label={t('common.filter')}
            />
          </div>
          <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-xs text-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              className="h-3.5 w-3.5 accent-[rgb(var(--color-primary))]"
            />
            {t('projects.showArchived')}
          </label>
          <div className="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
            <button
              type="button"
              aria-label={t('projects.viewList')}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors',
                view === 'list' ? 'bg-primary text-on-primary' : 'text-muted hover:bg-raised',
              )}
            >
              <IconList className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={t('projects.viewGrid')}
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors',
                view === 'grid' ? 'bg-primary text-on-primary' : 'text-muted hover:bg-raised',
              )}
            >
              <IconGrid className="h-4 w-4" />
            </button>
          </div>
        </div>
      </Card>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 sm:gap-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-md border border-border bg-surface p-4">
              <div className="skeleton-shimmer h-4 w-1/2 rounded-md" />
              <div className="skeleton-shimmer mt-3 h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        hasFilters ? (
          <EmptyState
            title={t('projects.noResults')}
            body={t('projects.noResultsBody')}
            action={
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                {t('projects.clearFilters')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={t('projects.emptyTitle')}
            body={t('projects.emptyBody')}
            action={
              <Link to="/projects/new">
                <Button variant="primary" size="sm">
                  {t('projects.createFirst')}
                </Button>
              </Link>
            }
          />
        )
      ) : view === 'list' ? (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(project) => project.id}
          caption={t('projects.title')}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
          {rows.map((project) => (
            <Card key={project.id} className="min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    to={`/workspace/${project.id}`}
                    className="block truncate text-sm font-semibold text-text hover:text-accent"
                  >
                    {project.name}
                  </Link>
                  <p className="mt-0.5 truncate text-[11px] text-faint">
                    {project.sourceFileName ?? t('workspace.noFile')}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[project.status]}>
                  {t(`projects.status.${project.status}`)}
                </Badge>
              </div>

              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                  <span>{t('projects.progressLabel')}</span>
                  <span className="tabular-nums">{project.progress}%</span>
                </div>
                <Progress
                  value={project.progress}
                  size="sm"
                  ariaLabel={`${project.name}: ${project.progress}%`}
                />
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <dt className="text-faint">{t('workspace.pageCount')}</dt>
                  <dd className="tabular-nums text-muted">{project.pageCount}</dd>
                </div>
                <div>
                  <dt className="text-faint">{t('projects.lastOpened')}</dt>
                  <dd className="truncate text-muted">
                    {formatRelative(project.lastOpenedAt, locale)}
                  </dd>
                </div>
              </dl>

              <div className="mt-3 flex items-center justify-end gap-1 border-t border-border pt-2">
                <RowActions project={project} onRename={openRename} onPending={setPending} />
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={pending?.kind === 'rename'}
        onClose={() => setPending(null)}
        title={t('projects.renameTitle')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!renameValue.trim()}
              onClick={() => void runAction()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Input
          label={t('projects.renameLabel')}
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && renameValue.trim()) void runAction()
          }}
          autoFocus
        />
      </Modal>

      <ConfirmDialog
        open={pending?.kind === 'duplicate'}
        title={t('projects.duplicateConfirm')}
        body={t('projects.duplicateBody')}
        confirmLabel={t('common.duplicate')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        loading={busy}
        onConfirm={() => void runAction()}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending?.kind === 'archive'}
        title={
          pending?.project.archived ? t('projects.unarchiveConfirm') : t('projects.archiveConfirm')
        }
        body={pending?.project.archived ? t('projects.unarchiveBody') : t('projects.archiveBody')}
        confirmLabel={pending?.project.archived ? t('common.unarchive') : t('common.archive')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        loading={busy}
        onConfirm={() => void runAction()}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        title={t('projects.deleteConfirm')}
        body={t('projects.deleteBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        loading={busy}
        onConfirm={() => void runAction()}
        onCancel={() => setPending(null)}
      />
    </PageContainer>
  )
}

function RowActions({
  project,
  onRename,
  onPending,
}: {
  project: ProjectRecord
  onRename: (project: ProjectRecord) => void
  onPending: (action: PendingAction) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-end gap-1">
      <IconButton
        size="sm"
        label={`${t('common.rename')}: ${project.name}`}
        icon={<IconEdit />}
        onClick={() => onRename(project)}
      />
      <IconButton
        size="sm"
        label={`${t('common.duplicate')}: ${project.name}`}
        icon={<IconDuplicate />}
        onClick={() => onPending({ kind: 'duplicate', project })}
      />
      <IconButton
        size="sm"
        label={
          project.archived
            ? `${t('common.unarchive')}: ${project.name}`
            : `${t('common.archive')}: ${project.name}`
        }
        icon={<IconArchive />}
        onClick={() => onPending({ kind: 'archive', project })}
      />
      <IconButton
        size="sm"
        variant="danger"
        label={`${t('common.delete')}: ${project.name}`}
        icon={<IconTrash />}
        onClick={() => onPending({ kind: 'delete', project })}
      />
    </div>
  )
}
