import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Button, Card, EmptyState, Stepper } from '@/components/ui'
import { PageThumbnails } from '@/components/workspace/PageThumbnails'
import { PageContainer, PageHeader, PageLayout } from '@/components/layout/Page'
import { IconWorkspace } from '@/components/layout/icons'
import { ACTIVE_STATES, PipelineMachine, type FsmEvent, type FsmState } from '@/core/fsm'
import { logMachineEvent } from '@/core/eventLogger'
import { REASON_CODES } from '@/core/reasonCodes'
import { projectRepo } from '@/db/repo-projects'
import { eventRepo } from '@/db/repo-events'
import { toast } from '@/stores/toastStore'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'

const STATE_TONE: Record<FsmState, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
  IDLE: 'neutral',
  PREFLIGHT: 'primary',
  READY: 'primary',
  PARSING: 'primary',
  OCR: 'primary',
  TRANSLATING: 'primary',
  REVIEWING: 'warning',
  LAYOUTING: 'primary',
  EXPORT_READY: 'success',
  PAUSED: 'warning',
  WAITING_RATE_LIMIT: 'warning',
  FAILED: 'danger',
  CANCELLED: 'neutral',
}

function stepIndexFor(state: FsmState, pausedFrom: FsmState | null): number {
  switch (state) {
    case 'IDLE':
      return 0
    case 'PREFLIGHT':
      return 0
    case 'READY':
      return 1
    case 'PARSING':
    case 'OCR':
      return 2
    case 'TRANSLATING':
    case 'WAITING_RATE_LIMIT':
      return 3
    case 'REVIEWING':
      return 4
    case 'LAYOUTING':
      return 5
    case 'EXPORT_READY':
      return 6
    case 'PAUSED':
      return pausedFrom ? stepIndexFor(pausedFrom, null) : 0
    case 'FAILED':
    case 'CANCELLED':
      return 0
    default:
      return 0
  }
}

export function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'

  const machineRef = useRef<PipelineMachine | null>(null)
  if (!machineRef.current) machineRef.current = new PipelineMachine()

  const [fsmState, setFsmState] = useState<FsmState>('IDLE')
  const [busy, setBusy] = useState(false)

  const project = useLiveQuery(
    async () => (projectId ? await projectRepo.get(projectId) : undefined),
    [projectId],
  )
  const recentEvents = useLiveQuery(
    async () =>
      projectId ? await eventRepo.list({ projectId, limit: 8 }) : eventRepo.list({ limit: 8 }),
    [projectId],
  )

  const machine = machineRef.current

  useEffect(() => {
    const unsubscribe = machine.subscribe((event) => {
      logMachineEvent(event, { projectId: projectId ?? null })
      if (event.kind === 'transition') {
        setFsmState(event.to)
        return
      }
      const definition = REASON_CODES[event.reasonCode]
      const message = i18n.language === 'my' ? definition.messageMy : definition.messageEn
      toast(definition.severity === 'warning' ? 'warning' : 'danger', message, event.detail)
    })
    return unsubscribe
  }, [machine, projectId, i18n.language])

  const context = machine.getContext()
  const available = machine.available()
  const stepIndex = stepIndexFor(fsmState, context.pausedFrom)
  const hasFile = Boolean(project?.sourceFileName)
  const active = ACTIVE_STATES.includes(fsmState)

  const steps = useMemo(
    () => [
      { id: 'preflight', label: t('workspace.phases.PREFLIGHT') },
      { id: 'ready', label: t('workspace.phases.READY') },
      { id: 'parse', label: t('workspace.phases.PARSING') },
      { id: 'translate', label: t('workspace.phases.TRANSLATING') },
      { id: 'review', label: t('workspace.phases.REVIEWING') },
      { id: 'layout', label: t('workspace.phases.LAYOUTING') },
      { id: 'export', label: t('workspace.phases.EXPORT_READY') },
    ],
    [t],
  )

  async function send(event: FsmEvent) {
    if (event === 'PARSE' && !hasFile) return
    setBusy(true)
    try {
      const result = machine.send(event, {}, Date.now())
      if (!result.ok) return

      // Pre-flight evaluates the local configuration; parsing itself is Phase 2.
      if (event === 'START') {
        const languagePairOk = !project || project.sourceLang !== project.targetLang
        if (!languagePairOk) {
          machine.send('PRECHECK_FAIL', { failureCode: 'PDF_CORRUPTED' })
        } else {
          machine.send('PRECHECK_OK')
        }
      }
      setFsmState(machine.getState())
    } finally {
      setBusy(false)
    }
  }

  const stepsAreDone = fsmState === 'EXPORT_READY'

  return (
    <PageContainer>
      <PageHeader
        title={project ? project.name : t('workspace.title')}
        subtitle={project ? t('workspace.title') : t('workspace.placeholderTitle')}
        meta={
          project ? (
            <Badge tone={STATE_TONE[fsmState]} dot={active}>
              {t(`workspace.phases.${fsmState}`)}
            </Badge>
          ) : null
        }
        actions={
          <>
            {projectId && project ? (
              <Link to={`/translate/${projectId}`}>
                <Button variant="primary" size="sm" data-testid="open-translate">
                  {t('workspace.openTranslate')}
                </Button>
              </Link>
            ) : null}
            <Link to="/projects">
              <Button variant="ghost" size="sm">
                {t('workspace.backToProjects')}
              </Button>
            </Link>
          </>
        }
      />

      {!projectId ? (
        <EmptyState
          title={t('projects.emptyTitle')}
          body={t('projects.emptyBody')}
          icon={<IconWorkspace className="h-10 w-10" />}
          action={
            <Link to="/projects/new">
              <Button variant="primary" size="sm">
                {t('projects.createFirst')}
              </Button>
            </Link>
          }
        />
      ) : project === undefined ? (
        <Card>
          <div className="flex flex-col gap-3">
            <div className="skeleton-shimmer h-4 w-1/3 rounded-md" />
            <div className="skeleton-shimmer h-24 w-full rounded-md" />
          </div>
        </Card>
      ) : (
        <PageLayout
          inspector={
            <>
              <Card title={t('workspace.projectInfo')}>
                <dl className="flex flex-col gap-2.5 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-faint">{t('workspace.sourceFile')}</dt>
                    <dd className="truncate text-right text-text">
                      {project.sourceFileName ?? t('workspace.noFile')}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-faint">{t('workspace.languagePair')}</dt>
                    <dd className="text-right text-text">
                      {project.sourceLang} → {project.targetLang}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-faint">{t('workspace.pageCount')}</dt>
                    <dd className="tabular-nums text-text">{project.pageCount}</dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-faint">{t('workspace.blockCount')}</dt>
                    <dd className="tabular-nums text-text">{project.blockCount}</dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-faint">{t('workspace.characterCount')}</dt>
                    <dd className="tabular-nums text-text">{project.characterCount}</dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-faint">{t('projects.lastOpened')}</dt>
                    <dd className="text-text">{formatRelative(project.lastOpenedAt, locale)}</dd>
                  </div>
                </dl>
              </Card>

              <Card title={t('workspace.currentState')}>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone={STATE_TONE[fsmState]} dot={active}>
                      {t(`workspace.phases.${fsmState}`)}
                    </Badge>
                    <span className="text-[11px] text-faint">{machine.getState()}</span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted">
                    {fsmState === 'IDLE' ? t('pipeline.idleHint') : t('workspace.pipeline')}
                  </p>
                  {context.failureCode ? (
                    <p className="rounded-md border border-danger/40 bg-danger-bg px-2.5 py-2 text-xs text-danger">
                      {i18n.language === 'my'
                        ? REASON_CODES[context.failureCode].messageMy
                        : REASON_CODES[context.failureCode].messageEn}
                    </p>
                  ) : null}
                </div>
              </Card>
            </>
          }
        >
          <Card title={t('workspace.pipeline')} description={t('workspace.placeholderBody')}>
            <Stepper
              items={steps}
              current={stepIndex}
              ariaLabel={t('workspace.pipeline')}
              className="mb-4"
            />

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              {available.length === 0 ? (
                <p className="text-xs text-faint">{t('pipeline.idleHint')}</p>
              ) : (
                available.map((event) => {
                  const blocked = event === 'PARSE' && !hasFile
                  const danger = event === 'CANCEL'
                  const primary = ['START', 'PRECHECK_OK', 'PARSE', 'RETRY', 'RESUME'].includes(
                    event,
                  )
                  return (
                    <Button
                      key={event}
                      size="sm"
                      variant={danger ? 'danger' : primary ? 'primary' : 'secondary'}
                      disabled={blocked || busy}
                      title={blocked ? t('pipeline.noFileHint') : undefined}
                      onClick={() => void send(event)}
                    >
                      {t(`pipeline.${event}`)}
                    </Button>
                  )
                })
              )}
            </div>

            {fsmState === 'READY' && !hasFile ? (
              <p className="mt-3 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
                {t('pipeline.noFileHint')}
              </p>
            ) : null}
            {stepsAreDone ? (
              <p className="mt-3 rounded-md border border-success/40 bg-success-bg px-3 py-2 text-xs text-success">
                {t('workspace.phases.EXPORT_READY')}
              </p>
            ) : null}
          </Card>

          {hasFile ? <PageThumbnails projectId={projectId} /> : null}

          <Card
            title={t('logs.title')}
            actions={
              <Link to="/logs">
                <Button variant="ghost" size="sm">
                  {t('dashboard.viewAllLogs')}
                </Button>
              </Link>
            }
          >
            {recentEvents && recentEvents.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border">
                {recentEvents.map((event) => (
                  <li key={event.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        event.severity === 'error' || event.severity === 'critical'
                          ? 'bg-danger'
                          : event.severity === 'warning'
                            ? 'bg-warning'
                            : event.severity === 'success'
                              ? 'bg-success'
                              : 'bg-info',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          'truncate text-xs',
                          i18n.language === 'my' ? 'mm-text' : 'text-text',
                        )}
                      >
                        {i18n.language === 'my' ? event.messageMy : event.messageEn}
                      </p>
                      <p className="mt-0.5 text-[10px] text-faint">
                        {formatDateTime(event.timestamp, locale)}
                        {event.reasonCode ? ` · ${event.reasonCode}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState size="sm" title={t('logs.emptyTitle')} body={t('logs.emptyBody')} />
            )}
          </Card>
        </PageLayout>
      )}
    </PageContainer>
  )
}
