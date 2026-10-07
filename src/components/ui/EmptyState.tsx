import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  title: string
  body?: string
  action?: ReactNode
  /** Decorative illustration / icon. */
  icon?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

const defaultIcon = (
  <svg
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="h-10 w-10"
  >
    <rect x="10" y="8" width="28" height="34" rx="3" />
    <path d="M17 17h14M17 24h14M17 31h9" strokeLinecap="round" />
  </svg>
)

export function EmptyState({ title, body, action, icon, size = 'md', className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-md border border-dashed border-border bg-surface/60 text-center',
        size === 'sm' ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-10',
        className,
      )}
    >
      <span aria-hidden="true" className="text-faint">
        {icon ?? defaultIcon}
      </span>
      <div className="max-w-sm">
        <p className="text-sm font-medium text-text">{title}</p>
        {body ? <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p> : null}
      </div>
      {action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  )
}
