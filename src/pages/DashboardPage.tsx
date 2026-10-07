import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Button, Card, EmptyState, Progress, SkeletonCard } from '@/components/ui'
import { PageContainer, PageHeader, PageLayout } from '@/components/layout/Page'
import { BarChart, DistributionBar, Sparkline } from '@/components/charts'
import { IconAlert, IconFile, IconKey, IconProjects, IconSparkle } from '@/components/layout/icons'
import { projectRepo } from '@/db/repo-projects'
import { jobRepo } from '@/db/repo-jobs'
import { apiKeyRepo } from '@/db/repo-apiKeys'
import { usageRepo } from '@/db/repo-usage'
import type { ProjectStatus } from '@/db/types'
import { formatCompact, formatNumber, formatRelative } from '@/lib/format'
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

function StatCard({
  label,
  value,
  hint,
  icon,
  children,
}: {
  label: string
  value: string
  hint?: string
  icon: ReactNode
  children?: ReactNode
}) {
  return (
    <Card className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">{label}</p>
          <p className="mt-1 truncate text-2xl font-semibold tabular-nums leading-none text-text">
            {value}
          </p>
          {hint ? <p className="mt-1.5 truncate text-[11px] text-faint">{hint}</p> : null}
        </div>
        <span
          aria-hidden="true"
          className="rounded-md border border-border bg-raised p-2 text-muted"
        >
          {icon}
        </span>
      </div>
      {children ? <div className="mt-3 text-primary">{children}</div> : null}
    </Card>
  )
}

export function DashboardPage() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'

  const stats = useLiveQuery(() => projectRepo.stats(), [])
  const recentProjects = useLiveQuery(() => projectRepo.list({ limit: 5 }), [])
  const activeJobs = useLiveQuery(() => jobRepo.listActive(), [])
  const keyHealth = useLiveQuery(() => apiKeyRepo.healthByProvider(), [])
  const providerUsage = useLiveQuery(() => usageRepo.totalsByProvider(), [])
  const usageSeries = useLiveQuery(() => usageRepo.dailySeries(14), [])
  const statusCounts = useLiveQuery(async () => {
    const projects = await projectRepo.list({ includeArchived: true })
    const counts: Record<string, number> = {}
    for (const project of projects) {
      counts[project.status] = (counts[project.status] ?? 0) + 1
    }
    return counts
  }, [])

  const loading =
    stats === undefined ||
    recentProjects === undefined ||
    activeJobs === undefined ||
    keyHealth === undefined ||
    providerUsage === undefined ||
    usageSeries === undefined ||
    statusCounts === undefined

  const totalRequests = providerUsage?.reduce((sum, item) => sum + item.requests, 0) ?? 0
  const totalTokens =
    providerUsage?.reduce((sum, item) => sum + item.tokensIn + item.tokensOut, 0) ?? 0
  const hasKeys = Object.keys(keyHealth ?? {}).length > 0
  const hasProjects = (stats?.projects ?? 0) > 0

  const dailyRequests = (usageSeries ?? []).map((entry) => entry.requests)

  const statusSegments = (
    ['done', 'processing', 'review', 'draft', 'failed', 'archived'] as const
  ).map((status) => ({
    key: status,
    label: t(`projects.status.${status}`),
    value: statusCounts?.[status] ?? 0,
    className:
      status === 'done'
        ? 'bg-success'
        : status === 'processing'
          ? 'bg-primary'
          : status === 'review'
            ? 'bg-warning'
            : status === 'failed'
              ? 'bg-danger'
              : 'bg-faint',
  }))

  return (
    <PageContainer>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/logs">
              <Button variant="ghost" size="sm">
                {t('dashboard.viewAllLogs')}
              </Button>
            </Link>
            <Link to="/projects/new">
              <Button variant="primary" size="sm">
                {t('dashboard.createProject')}
              </Button>
            </Link>
          </div>
        }
      />

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
            <StatCard
              label={t('dashboard.statProjects')}
              value={formatNumber(stats?.projects ?? 0, locale)}
              hint={`${formatNumber(stats?.archivedProjects ?? 0, locale)} ${t('projects.archived').toLowerCase()}`}
              icon={<IconProjects className="h-4 w-4" />}
            />
            <StatCard
              label={t('dashboard.statPagesTranslated')}
              value={formatNumber(stats?.pagesTranslated ?? 0, locale)}
              hint={t('projects.pagesCount', { count: stats?.pages ?? 0 })}
              icon={<IconFile className="h-4 w-4" />}
            />
            <StatCard
              label={t('dashboard.statCharacters')}
              value={formatCompact(stats?.characters ?? 0, locale)}
              hint={`${formatNumber(stats?.blocks ?? 0, locale)} ${t('workspace.blockCount').toLowerCase()}`}
              icon={<IconSparkle className="h-4 w-4" />}
            />
            <StatCard
              label={t('dashboard.statRequests')}
              value={formatCompact(totalRequests, locale)}
              hint={`${t('dashboard.tokensLabel')}: ${formatCompact(totalTokens, locale)}`}
              icon={<IconAlert className="h-4 w-4" />}
            >
              <Sparkline values={dailyRequests} ariaLabel={t('dashboard.usageChart')} height={34} />
            </StatCard>
          </div>

          <PageLayout
            inspector={
              <>
                <Card
                  title={t('dashboard.apiHealth')}
                  actions={
                    <Link to="/settings?tab=providers">
                      <Button variant="ghost" size="sm">
                        {t('dashboard.addKey')}
                      </Button>
                    </Link>
                  }
                >
                  {hasKeys ? (
                    <ul className="flex flex-col gap-2">
                      {Object.entries(keyHealth ?? {}).map(([provider, health]) => (
                        <li
                          key={provider}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2"
                        >
                          <span className="flex min-w-0 items-center gap-2 text-sm text-text">
                            <IconKey className="h-3.5 w-3.5 text-faint" />
                            <span className="truncate">{provider}</span>
                          </span>
                          <Badge
                            dot
                            tone={
                              health.status === 'valid'
                                ? 'success'
                                : health.status === 'invalid'
                                  ? 'danger'
                                  : health.status === 'quota' || health.status === 'cooling'
                                    ? 'warning'
                                    : 'neutral'
                            }
                            title={health.status}
                          >
                            {health.usable}/{health.total}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState
                      size="sm"
                      title={t('dashboard.noKeys')}
                      body={t('dashboard.noKeysBody')}
                      icon={<IconKey className="h-8 w-8" />}
                      action={
                        <Link to="/settings?tab=providers">
                          <Button variant="primary" size="sm">
                            {t('dashboard.addKey')}
                          </Button>
                        </Link>
                      }
                    />
                  )}
                </Card>

                <Card title={t('dashboard.usageChart')} description={t('dashboard.perProvider')}>
                  {providerUsage && providerUsage.length > 0 ? (
                    <div className="flex flex-col gap-3">
                      <ul className="flex flex-col gap-1.5 text-xs">
                        {providerUsage.map((entry) => (
                          <li
                            key={entry.provider}
                            className="flex items-center justify-between gap-2 border-b border-border pb-1.5 last:border-b-0"
                          >
                            <span className="truncate text-text">{entry.provider}</span>
                            <span className="shrink-0 tabular-nums text-muted">
                              {formatNumber(entry.requests, locale)} ·{' '}
                              {formatCompact(entry.characters, locale)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <BarChart
                        data={(usageSeries ?? []).map((entry) => ({
                          label: entry.day.slice(5),
                          value: entry.requests,
                        }))}
                        height={84}
                        ariaLabel={t('dashboard.usageChart')}
                        formatValue={(value) => formatNumber(value, locale)}
                      />
                    </div>
                  ) : (
                    <EmptyState
                      size="sm"
                      title={t('dashboard.noUsageData')}
                      body={t('dashboard.perProvider')}
                    />
                  )}
                </Card>

                <Card title={t('dashboard.statusBreakdown')}>
                  <DistributionBar
                    segments={statusSegments}
                    ariaLabel={t('dashboard.statusBreakdown')}
                  />
                </Card>
              </>
            }
          >
            <Card
              title={t('dashboard.activeJobs')}
              actions={
                activeJobs && activeJobs.length > 0 ? (
                  <Badge tone="primary" dot>
                    {activeJobs.length}
                  </Badge>
                ) : null
              }
            >
              {activeJobs && activeJobs.length > 0 ? (
                <ul className="flex flex-col gap-3">
                  {activeJobs.map((job) => (
                    <li key={job.id} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium text-text">
                          {t(`workspace.phases.${job.state}`)}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted">{job.progress}%</span>
                      </div>
                      <Progress value={job.progress} ariaLabel={job.type} />
                      <p className="text-[11px] text-faint">
                        {job.type} · {formatRelative(job.startedAt, locale)}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  size="sm"
                  title={t('dashboard.noActiveJobs')}
                  body={t('dashboard.noActiveJobsBody')}
                />
              )}
            </Card>

            <Card
              title={t('dashboard.recentProjects')}
              actions={
                <Link to="/projects">
                  <Button variant="ghost" size="sm">
                    {t('dashboard.viewAllProjects')}
                  </Button>
                </Link>
              }
            >
              {recentProjects && recentProjects.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {recentProjects.map((project) => (
                    <li key={project.id}>
                      <Link
                        to={`/workspace/${project.id}`}
                        className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-raised"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-text">
                              {project.name}
                            </span>
                            <Badge tone={STATUS_TONE[project.status]}>
                              {t(`projects.status.${project.status}`)}
                            </Badge>
                          </div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <Progress
                              value={project.progress}
                              size="sm"
                              className="flex-1"
                              ariaLabel={`${t('common.progress')}: ${project.name}`}
                            />
                            <span className="shrink-0 text-[11px] tabular-nums text-muted">
                              {project.progress}%
                            </span>
                          </div>
                        </div>
                        <span className="shrink-0 text-[11px] text-faint">
                          {formatRelative(project.lastOpenedAt, locale)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title={hasProjects ? t('dashboard.noRecentProjects') : t('dashboard.emptyTitle')}
                  body={
                    hasProjects ? t('dashboard.noRecentProjectsBody') : t('dashboard.emptyBody')
                  }
                  action={
                    <Link to="/projects/new">
                      <Button variant="primary" size="sm">
                        {t('dashboard.createProject')}
                      </Button>
                    </Link>
                  }
                  className={cn(hasProjects && 'border-solid')}
                />
              )}
            </Card>
          </PageLayout>
        </>
      )}
    </PageContainer>
  )
}
