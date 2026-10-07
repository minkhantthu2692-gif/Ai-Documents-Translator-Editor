import { useId } from 'react'
import { cn } from '@/lib/cn'

export interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  ariaLabel: string
  className?: string
  /** Shows the flat area fill under the line. */
  fill?: boolean
}

/** Flat SVG line chart â€” no gradients, 1.5px stroke. */
export function Sparkline({
  values,
  width = 180,
  height = 44,
  ariaLabel,
  className,
  fill = true,
}: SparklineProps) {
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const series = values.length > 0 ? values : [0, 0]
  const max = Math.max(...series, 1)
  const min = Math.min(...series, 0)
  const span = max - min || 1
  const padding = 4
  const stepX = series.length > 1 ? (width - padding * 2) / (series.length - 1) : 0

  const points = series.map((value, index) => {
    const x = padding + index * stepX
    const y = height - padding - ((value - min) / span) * (height - padding * 2)
    return { x, y }
  })

  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ')
  const area = `${line} L${points[points.length - 1].x} ${height - padding} L${points[0].x} ${height - padding} Z`

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={cn('overflow-visible', className)}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={width} height={height} />
        </clipPath>
      </defs>
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1"
      />
      {fill ? <path d={area} className="fill-primary/10" clipPath={`url(#${clipId})`} /> : null}
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle
        cx={points[points.length - 1].x}
        cy={points[points.length - 1].y}
        r="2.5"
        fill="currentColor"
      />
    </svg>
  )
}

export interface BarChartData {
  label: string
  value: number
}

export interface BarChartProps {
  data: BarChartData[]
  height?: number
  ariaLabel: string
  className?: string
  formatValue?: (value: number) => string
}

/** Flat vertical bar chart with an accessible description. */
export function BarChart({ data, height = 120, ariaLabel, className, formatValue }: BarChartProps) {
  const max = Math.max(...data.map((item) => item.value), 1)
  const total = data.reduce((sum, item) => sum + item.value, 0)

  if (total === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-md border border-dashed border-border text-xs text-faint',
          className,
        )}
        style={{ height }}
      >
        <span aria-hidden="true">â€”</span>
        <span className="sr-only">{ariaLabel}</span>
      </div>
    )
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-end gap-1" style={{ height }} role="img" aria-label={ariaLabel}>
        {data.map((item, index) => {
          const ratio = item.value / max
          const barHeight = item.value === 0 ? 2 : Math.max(4, Math.round(ratio * (height - 4)))
          return (
            <div
              key={`${item.label}-${index}`}
              className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
              title={`${item.label}: ${formatValue ? formatValue(item.value) : item.value}`}
            >
              <span className="pointer-events-none hidden rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text group-hover:block">
                {formatValue ? formatValue(item.value) : item.value}
              </span>
              <span
                className={cn(
                  'w-full rounded-t-[3px] transition-colors',
                  item.value === 0 ? 'bg-raised' : 'bg-primary/80 group-hover:bg-primary',
                )}
                style={{ height: barHeight }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-faint">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  )
}

export interface DistributionSegment {
  key: string
  label: string
  value: number
  className: string
}

export interface DistributionBarProps {
  segments: DistributionSegment[]
  ariaLabel: string
  className?: string
}

/** Stacked horizontal distribution (project status breakdown). */
export function DistributionBar({ segments, ariaLabel, className }: DistributionBarProps) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        role="img"
        aria-label={`${ariaLabel}: ${segments
          .map((segment) => `${segment.label} ${segment.value}`)
          .join(', ')}`}
        className="flex h-2 w-full overflow-hidden rounded-full bg-raised"
      >
        {total === 0 ? null : (
          <>
            {segments
              .filter((segment) => segment.value > 0)
              .map((segment) => (
                <span
                  key={segment.key}
                  className={cn('h-full', segment.className)}
                  style={{ width: `${(segment.value / total) * 100}%` }}
                />
              ))}
          </>
        )}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-sm', segment.className)} />
            <span>{segment.label}</span>
            <span className="tabular-nums text-faint">{segment.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
