import { cn } from '@/lib/cn'

export interface ProgressProps {
  /** 0..100 */
  value: number
  label?: string
  /** Renders the label above the bar. */
  showLabel?: boolean
  tone?: 'primary' | 'success' | 'warning' | 'danger'
  size?: 'sm' | 'md'
  className?: string
  /** Accessible name when no visible label is provided. */
  ariaLabel?: string
}

const toneClasses = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
} as const

export function Progress({
  value,
  label,
  showLabel,
  tone = 'primary',
  size = 'md',
  className,
  ariaLabel,
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  const rounded = Math.round(clamped)

  return (
    <div className={cn('min-w-0', className)}>
      {showLabel ? (
        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-muted">{label}</span>
          <span className="tabular-nums text-text">{rounded}%</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? label}
        aria-valuetext={label ? `${label}: ${rounded}%` : `${rounded}%`}
        className={cn(
          'w-full overflow-hidden rounded-full bg-raised',
          size === 'sm' ? 'h-1' : 'h-1.5',
        )}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', toneClasses[tone])}
          style={{ width: `${rounded}%` }}
        />
      </div>
      {showLabel ? null : <span className="sr-only">{rounded}%</span>}
    </div>
  )
}
