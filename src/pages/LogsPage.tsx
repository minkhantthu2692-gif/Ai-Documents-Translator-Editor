import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Virtuoso } from 'react-virtuoso'
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Input } from '@/components/ui'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { IconChevronDown, IconDownload, IconSearch, IconTrash } from '@/components/layout/icons'
import { eventRepo } from '@/db/repo-events'
import { saveJsonFile } from '@/db/backup'
import type { Severity } from '@/core/reasonCodes'
import { logEvent } from '@/core/eventLogger'
import { toast } from '@/stores/toastStore'
import { cn } from '@/lib/cn'
import { formatDateTime } from '@/lib/format'

const SEVERITIES: Severity[] = ['info', 'success', 'warning', 'error', 'critical']

const SEVERITY_TONE: Record<Severity, 'neutral' | 'success' | 'warning' | 'danger'> = {
  info: 'neutral',
  success: 'success',
  warning: 'warning',
  error: 'danger',
  critical: 'danger',
}

const SEVERITY_DOT: Record<Severity, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
  critical: 'bg-danger',
}

export function LogsPage() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'

  const [search, setSearch] = useState('')
  const [active, setActive] = useState<Severity[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)

  const severities = useMemo(() => (active.length > 0 ? active : undefined), [active])

  const events = useLiveQuery(
    () => eventRepo.list({ severities, search, limit: 1000 }),
    [active.join(','), search],
  )
  const counts = useLiveQuery(() => eventRepo.countBySeverity(), [])
  const total = useLiveQuery(() => eventRepo.list({ limit: 5000 }), [])

  const rows = events ?? []
  const totalCount = total?.length ?? 0

  function toggleSeverity(severity: Severity) {
    setActive((current) =>
      current.includes(severity)
        ? current.filter((entry) => entry !== severity)
        : [...current, severity],
    )
  }

  function exportLogs() {
    const payload = {
      format: 'aidt-logs',
      exportedAt: Date.now(),
      locale: i18n.language,
      count: rows.length,
      events: rows,
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    saveJsonFile(JSON.stringify(payload, null, 2), `aidt-logs-${stamp}.json`)
    logEvent({
      state: 'SETTINGS',
      action: 'logs.export',
      severity: 'success',
      messageMy: `မှတ်တမ်း ${rows.length} ခု ထုတ်ယူပြီး`,
      messageEn: `Exported ${rows.length} log entries`,
      technicalDetail: `count=${rows.length}`,
    })
    toast('success', t('logs.exported'))
  }

  async function clearLogs() {
    setBusy(true)
    try {
      await eventRepo.clearAll()
      toast('success', t('logs.clear'))
      setConfirmClear(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('logs.title')}
        subtitle={t('logs.subtitle')}
        meta={<Badge tone="neutral">{t('logs.total', { count: totalCount })}</Badge>}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<IconDownload className="h-4 w-4" />}
              onClick={exportLogs}
              disabled={rows.length === 0}
            >
              {t('logs.export')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<IconTrash className="h-4 w-4" />}
              onClick={() => setConfirmClear(true)}
              disabled={totalCount === 0}
            >
              {t('logs.clear')}
            </Button>
          </>
        }
      />

      <Card>
        <div className="flex flex-col gap-3">
          <div className="min-w-0">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('logs.searchPlaceholder')}
              aria-label={t('logs.searchPlaceholder')}
              iconLeft={<IconSearch className="h-4 w-4" />}
            />
          </div>

          <div
            role="group"
            aria-label={t('logs.severityFilter')}
            className="flex flex-wrap gap-1.5"
          >
            <button
              type="button"
              aria-pressed={active.length === 0}
              onClick={() => setActive([])}
              className={cn(
                'rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                active.length === 0
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-border bg-surface text-muted hover:bg-raised',
              )}
            >
              {t('logs.allSeverities')}
            </button>
            {SEVERITIES.map((severity) => {
              const selected = active.includes(severity)
              return (
                <button
                  key={severity}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleSeverity(severity)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                    selected
                      ? 'border-primary bg-primary text-on-primary'
                      : 'border-border bg-surface text-muted hover:bg-raised',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[severity])}
                  />
                  {t(`logs.severity.${severity}`)}
                  <span className="tabular-nums opacity-70">{counts?.[severity] ?? 0}</span>
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      {rows.length === 0 ? (
        totalCount === 0 ? (
          <EmptyState title={t('logs.emptyTitle')} body={t('logs.emptyBody')} />
        ) : (
          <EmptyState
            title={t('logs.noResults')}
            body={t('logs.noResultsBody')}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSearch('')
                  setActive([])
                }}
              >
                {t('projects.clearFilters')}
              </Button>
            }
          />
        )
      ) : (
        <Card
          title={t('logs.title')}
          description={t('logs.showing', { shown: rows.length, total: totalCount })}
          flush
        >
          <div className="h-[max(20rem,calc(100dvh-26rem))]">
            <Virtuoso
              data={rows}
              itemContent={(_index, event) => {
                const isOpen = expanded === event.id
                return (
                  <div className="border-b border-border px-4 py-2.5 last:border-b-0">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                          SEVERITY_DOT[event.severity],
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={SEVERITY_TONE[event.severity]} size="sm">
                            {t(`logs.severity.${event.severity}`)}
                          </Badge>
                          <span className="text-[11px] tabular-nums text-faint">
                            {formatDateTime(event.timestamp, locale)}
                          </span>
                          {event.reasonCode ? (
                            <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-[10px] text-muted">
                              {event.reasonCode}
                            </span>
                          ) : null}
                          <span className="font-mono text-[10px] text-faint">{event.state}</span>
                        </div>
                        <p
                          className={cn(
                            'mt-1 text-sm',
                            i18n.language === 'my' ? 'mm-text' : 'text-text',
                          )}
                        >
                          {i18n.language === 'my'
                            ? event.messageMy || event.messageEn
                            : event.messageEn || event.messageMy}
                        </p>

                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : event.id)}
                          className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-accent underline-offset-4 hover:underline"
                        >
                          {t('logs.technical')}
                          <IconChevronDown
                            className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-180')}
                          />
                        </button>

                        {isOpen ? (
                          <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-border bg-raised/50 px-2.5 py-2">
                            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted">
                              {event.technicalDetail || '—'}
                            </pre>
                            {event.pageIndex !== null || event.lineIndex !== null ? (
                              <p className="text-[11px] text-faint">
                                {t('logs.pageIndex')}: {event.pageIndex ?? '—'} ·{' '}
                                {t('logs.lineIndex')}: {event.lineIndex ?? '—'}
                              </p>
                            ) : null}
                            {event.fixActions.length > 0 ? (
                              <div>
                                <p className="mb-1 text-[11px] font-medium text-muted">
                                  {t('logs.fixActions')}
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {event.fixActions.map((action) => (
                                    <span
                                      key={action.id}
                                      className="rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-text"
                                    >
                                      {i18n.language === 'my' ? action.labelMy : action.labelEn}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <IconButton
                        size="sm"
                        label={isOpen ? t('common.close') : t('logs.technical')}
                        icon={
                          <IconChevronDown
                            className={cn('transition-transform', isOpen && 'rotate-180')}
                          />
                        }
                        onClick={() => setExpanded(isOpen ? null : event.id)}
                      />
                    </div>
                  </div>
                )
              }}
            />
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmClear}
        title={t('logs.clearTitle')}
        body={t('logs.clearBody')}
        confirmLabel={t('common.clear')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        loading={busy}
        onConfirm={() => void clearLogs()}
        onCancel={() => setConfirmClear(false)}
      />
    </PageContainer>
  )
}
