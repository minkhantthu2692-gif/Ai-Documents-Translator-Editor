import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Standard page padding: content never stretches into empty space. */
export function PageContainer({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-h-full flex-col gap-3 p-3 sm:gap-4 sm:p-4 lg:p-5', className)}>
      {children}
    </div>
  )
}

export interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  /** Rendered above the title (badges, counts). */
  meta?: ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, actions, meta, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        {meta ? <div className="mb-1 flex flex-wrap items-center gap-2">{meta}</div> : null}
        <h1 className="text-lg font-semibold leading-tight text-text sm:text-xl">{title}</h1>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-xs text-muted sm:text-sm">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/**
 * Two-column page layout: primary column scrolls, inspector is a fixed-width
 * side panel visible from lg (1024px) upward.
 */
export function PageLayout({
  children,
  inspector,
  inspectorOpen = true,
  className,
}: {
  children: ReactNode
  inspector?: ReactNode
  inspectorOpen?: boolean
  className?: string
}) {
  if (!inspector || !inspectorOpen) {
    return (
      <div className={cn('grid min-h-0 flex-1 grid-cols-1 gap-3 sm:gap-4', className)}>
        {children}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'grid min-h-0 flex-1 grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[minmax(0,1fr)_300px]',
        className,
      )}
    >
      <div className="grid-fill flex min-w-0 flex-col gap-3 sm:gap-4">{children}</div>
      <aside className="grid-fill flex min-w-0 flex-col gap-3 sm:gap-4 xl:overflow-y-auto">
        {inspector}
      </aside>
    </div>
  )
}
