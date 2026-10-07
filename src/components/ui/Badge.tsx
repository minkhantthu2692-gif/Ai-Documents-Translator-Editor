import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  size?: 'sm' | 'md'
  dot?: boolean
  className?: string
  title?: string
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'border-border bg-raised text-muted',
  primary: 'border-primary/40 bg-info-bg text-primary',
  success: 'border-success/40 bg-success-bg text-success',
  warning: 'border-warning/40 bg-warning-bg text-warning',
  danger: 'border-danger/40 bg-danger-bg text-danger',
  info: 'border-info/40 bg-info-bg text-info',
}

const dotClasses: Record<BadgeTone, string> = {
  neutral: 'bg-faint',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

export function Badge({
  children,
  tone = 'neutral',
  size = 'sm',
  dot,
  className,
  title,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs',
        toneClasses[tone],
        className,
      )}
    >
      {dot ? (
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', dotClasses[tone])} />
      ) : null}
      {children}
    </span>
  )
}
