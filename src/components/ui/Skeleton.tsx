import { cn } from '@/lib/cn'

export interface SkeletonProps {
  /** CSS width, e.g. '100%', '12rem'. */
  width?: string
  height?: string
  rounded?: 'sm' | 'md' | 'full'
  className?: string
  /** Number of stacked lines (for text blocks). */
  lines?: number
}

const roundedClasses = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  full: 'rounded-full',
} as const

export function Skeleton({
  width = '100%',
  height = '1rem',
  rounded = 'md',
  className,
  lines = 1,
}: SkeletonProps) {
  if (lines > 1) {
    return (
      <div className={cn('flex flex-col gap-2', className)} aria-hidden="true">
        {Array.from({ length: lines }).map((_, index) => (
          <span
            key={index}
            className={cn('skeleton-shimmer block', roundedClasses[rounded])}
            style={{
              width: index === lines - 1 ? '60%' : width,
              height,
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn('skeleton-shimmer block', roundedClasses[rounded], className)}
      style={{ width, height }}
    />
  )
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn('rounded-md border border-border bg-surface p-4', className)}
      aria-hidden="true"
    >
      <Skeleton width="45%" height="0.75rem" />
      <div className="mt-3">
        <Skeleton width="70%" height="1.5rem" />
      </div>
      <div className="mt-3">
        <Skeleton width="100%" height="0.5rem" />
      </div>
    </div>
  )
}
