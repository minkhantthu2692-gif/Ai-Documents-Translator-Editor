import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Badge, type BadgeTone } from './Badge'
import { Button } from './Button'
import { Progress } from './Progress'
import { IconAlert, IconCheck, IconClose, IconInfo } from '@/components/layout/icons'
import {
  countByStatus,
  primaryBlocker,
  type CheckStatus,
  type PreflightCheck,
} from '@/pdf/preflight'

/** Where the pipeline currently is — the panel's "which stage" line. */
export type StatusStage = 'idle' | 'analyze' | 'parse' | 'ocr' | 'translate' | 'export'

export interface StatusPanelStage {
  stage: StatusStage
  /** Optional within-stage progress. */
  done?: number
  total?: number
  /** Extra line, e.g. the page that failed or the reason work stopped. */
  detail?: string | null
}

export interface StatusPanelProps {
  checks: PreflightCheck[]
  /** Current pipeline stage; omitted = nothing running yet. */
  current?: StatusPanelStage | null
  /** Renders the Start button (the workspace owns translation start). */
  onStart?: () => void
  startLabel?: string
  startDisabled?: boolean
  /** Invoked by a check's "Fix it" button. */
  onFix?: (check: PreflightCheck) => void
  /** Extra controls rendered next to Start (pause/resume/retry…). */
  actions?: ReactNode
  className?: string
  'data-testid'?: string
}

const statusTone: Record<CheckStatus, BadgeTone> = {
  pass: 'success',
  warn: 'warning',
  fail: 'danger',
  pending: 'neutral',
}

const statusIcon: Record<CheckStatus, typeof IconCheck> = {
  pass: IconCheck,
  warn: IconAlert,
  fail: IconClose,
  pending: IconInfo,
}

const stageKey: Record<StatusStage, string> = {
  idle: 'status.stageIdle',
  analyze: 'status.stageAnalyze',
  parse: 'status.stageParse',
  ocr: 'status.stageOcr',
  translate: 'status.stageTranslate',
  export: 'status.stageExport',
}

const statusLabelKey: Record<CheckStatus, string> = {
  pass: 'status.checkPass',
  warn: 'status.checkWarn',
  fail: 'status.checkFail',
  pending: 'status.checkPending',
}

/**
 * The single place the app answers four questions:
 * *why can't I start*, *which stage am I in*, *where and why did it stop*, and
 * *how do I fix it*. Every line is bilingual — explicit Myanmar/English pairs
 * come from the reason codes, check labels from i18n.
 */
export function StatusPanel({
  checks,
  current,
  onStart,
  startLabel,
  startDisabled = false,
  onFix,
  actions,
  className,
  'data-testid': testId = 'status-panel',
}: StatusPanelProps) {
  const { t, i18n } = useTranslation()
  const isMy = i18n.language?.startsWith('my') ?? false

  const counts = countByStatus(checks)
  const blocker = primaryBlocker(checks)
  const blocked = counts.fail > 0
  const ready = !blocked
  const overall = blocked ? 'blocked' : counts.warn > 0 ? 'warnings' : 'ready'

  return (
    <section
      data-testid={testId}
      aria-label={t('status.title')}
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      {/* --- headline ------------------------------------------------- */}
      {/* Two lines, not one: badge + counts on top, run controls beneath. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span data-testid="status-overall" data-overall={overall}>
            <Badge
              size="md"
              dot
              tone={blocked ? 'danger' : counts.warn > 0 ? 'warning' : 'success'}
            >
              {t(`status.${overall}`)}
            </Badge>
          </span>
          <span className="text-xs text-muted">
            {t('status.summary', {
              pass: counts.pass,
              warn: counts.warn,
              fail: counts.fail,
            })}
          </span>
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="status-actions">
            {actions}
          </div>
        ) : null}
      </div>

      {/* --- why can't I start --------------------------------------- */}
      <div
        data-testid="status-blocker"
        className={cn(
          'rounded-md border px-3 py-2.5',
          blocked ? 'border-danger/40 bg-danger-bg' : 'border-border bg-raised/40',
        )}
      >
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
              blocked ? 'bg-danger text-on-danger' : 'bg-success text-on-primary',
            )}
          >
            {blocked ? (
              <IconClose className="h-3 w-3" strokeWidth={3} />
            ) : (
              <IconCheck className="h-3 w-3" strokeWidth={3} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text">
              {blocked ? t('status.whyBlocked') : t('status.noBlocker')}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {blocker ? (isMy ? blocker.detailMy : blocker.detailEn) : t('status.startHint')}
            </p>
            {blocker?.fix ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                data-testid="status-fix"
                onClick={() => onFix?.(blocker)}
              >
                {t('status.fixIt')} · {isMy ? blocker.fix.labelMy : blocker.fix.labelEn}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* --- stage ----------------------------------------------------- */}
      {current ? (
        <div
          data-testid="status-stage"
          className="rounded-md border border-border bg-surface px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text">
              {t('status.stage')}: <span className="text-muted">{t(stageKey[current.stage])}</span>
            </span>
            {current.total ? (
              <span className="text-xs tabular-nums text-muted">
                {t('status.progress', { done: current.done ?? 0, total: current.total })}
              </span>
            ) : null}
          </div>
          {current.total ? (
            <Progress
              className="mt-2"
              size="sm"
              value={((current.done ?? 0) / Math.max(1, current.total)) * 100}
              ariaLabel={t('status.stage')}
            />
          ) : null}
          {current.detail ? (
            <p className="mt-2 text-xs leading-relaxed text-muted">{current.detail}</p>
          ) : null}
        </div>
      ) : null}

      {/* --- checklist -------------------------------------------------- */}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
        {checks.map((check) => {
          const Icon = statusIcon[check.status]
          const detail = isMy ? check.detailMy : check.detailEn
          return (
            <li
              key={check.id}
              data-testid={`check-${check.id}`}
              data-status={check.status}
              className="flex items-start gap-3 px-3 py-2.5"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 shrink-0',
                  check.status === 'pass' && 'text-success',
                  check.status === 'warn' && 'text-warning',
                  check.status === 'fail' && 'text-danger',
                  check.status === 'pending' && 'text-faint',
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-text">{t(check.labelKey)}</span>
                  <Badge tone={statusTone[check.status]}>{t(statusLabelKey[check.status])}</Badge>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{detail}</p>
              </div>
              {check.fix && check.status !== 'pass' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onFix?.(check)}
                  data-testid={`fix-${check.id}`}
                >
                  {isMy ? check.fix.labelMy : check.fix.labelEn}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>

      {checks.length === 0 ? <p className="text-xs text-muted">{t('common.loading')}</p> : null}

      {/* --- Start ------------------------------------------------------ */}
      {/* The one action this panel exists for: full-width and primary so it
          reads as the next step rather than as one more control. */}
      {onStart ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="primary"
            size="lg"
            fullWidth
            onClick={onStart}
            disabled={startDisabled || !ready}
            data-testid="status-start"
            title={!ready ? t('status.startHint') : undefined}
          >
            {startLabel ?? t('newProject.startLabel')}
          </Button>
          {!ready ? <p className="text-xs text-muted">{t('status.startHint')}</p> : null}
        </div>
      ) : null}
      {!ready ? (
        <p className="sr-only" role="status">
          {t('status.blocked')}
          {blocker ? `: ${isMy ? blocker.detailMy : blocker.detailEn}` : ''}
        </p>
      ) : null}
    </section>
  )
}
