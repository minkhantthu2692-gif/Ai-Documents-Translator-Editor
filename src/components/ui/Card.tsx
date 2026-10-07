import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  /** Removes the inner padding (for tables/lists that manage their own). */
  flush?: boolean
  /** Renders the header as a link-styled row. */
  padded?: boolean
}

export function Card({
  title,
  description,
  actions,
  footer,
  flush,
  padded = true,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <section
      className={cn('flex min-w-0 flex-col rounded-md border border-border bg-surface', className)}
      {...rest}
    >
      {title || actions || description ? (
        <header
          className={cn(
            'flex items-start justify-between gap-3 border-b border-border',
            padded ? 'px-4 py-3' : 'px-4 py-3',
          )}
        >
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-text">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-h-0 flex-1', padded && !flush ? 'p-4' : '')}>{children}</div>
      {footer ? (
        <footer className="border-t border-border px-4 py-3 text-xs text-muted">{footer}</footer>
      ) : null}
    </section>
  )
}
