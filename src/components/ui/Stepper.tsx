import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type StepperStatus = 'done' | 'current' | 'upcoming' | 'error'

export interface StepperItem {
  id: string
  label: string
  description?: string
  status?: StepperStatus
}

export interface StepperProps {
  items: StepperItem[]
  /** Index of the active step (used when items carry no explicit status). */
  current?: number
  orientation?: 'horizontal' | 'vertical'
  ariaLabel: string
  className?: string
  renderMarker?: (item: StepperItem, index: number) => ReactNode
}

const markerClasses: Record<StepperStatus, string> = {
  done: 'border-primary bg-primary text-on-primary',
  current: 'border-primary bg-surface text-primary',
  upcoming: 'border-border bg-surface text-faint',
  error: 'border-danger bg-danger text-on-danger',
}

const connectorClasses: Record<StepperStatus, string> = {
  done: 'bg-primary',
  current: 'bg-border',
  upcoming: 'bg-border',
  error: 'bg-danger',
}

function resolveStatus(item: StepperItem, index: number, current: number): StepperStatus {
  if (item.status) return item.status
  if (index < current) return 'done'
  if (index === current) return 'current'
  return 'upcoming'
}

export function Stepper({
  items,
  current = 0,
  orientation = 'horizontal',
  ariaLabel,
  className,
  renderMarker,
}: StepperProps) {
  const horizontal = orientation === 'horizontal'

  return (
    <ol
      aria-label={ariaLabel}
      className={cn(
        horizontal
          ? 'flex w-full items-start gap-0 overflow-x-auto'
          : 'flex w-full flex-col items-stretch gap-2',
        className,
      )}
    >
      {items.map((item, index) => {
        const status = resolveStatus(item, index, current)
        const isLast = index === items.length - 1

        return (
          <li
            key={item.id}
            aria-current={status === 'current' ? 'step' : undefined}
            className={cn(
              'min-w-0',
              horizontal ? 'flex flex-1 items-start gap-2' : 'flex items-start gap-3',
              !horizontal && !isLast && 'pb-1',
            )}
          >
            <div className={cn('flex min-w-0 flex-col', horizontal && 'flex-1')}>
              <div className={cn('flex items-center gap-2', horizontal && 'w-full')}>
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors',
                    markerClasses[status],
                  )}
                >
                  {renderMarker ? (
                    renderMarker(item, index)
                  ) : status === 'done' ? (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-3 w-3"
                    >
                      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </span>
                {horizontal && !isLast ? (
                  <span
                    aria-hidden="true"
                    className={cn('h-px min-w-4 flex-1', connectorClasses[status])}
                  />
                ) : null}
              </div>
              <div className={cn('mt-1.5', horizontal ? 'pr-3' : '')}>
                <p
                  className={cn(
                    'truncate text-xs font-medium',
                    status === 'upcoming' ? 'text-faint' : 'text-text',
                  )}
                >
                  {item.label}
                </p>
                {item.description ? (
                  <p className="mt-0.5 truncate text-[11px] text-muted">{item.description}</p>
                ) : null}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
