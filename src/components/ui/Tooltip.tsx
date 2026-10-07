import { cloneElement, useId, isValidElement, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface TooltipProps {
  content: ReactNode
  children: ReactElement
  placement?: 'top' | 'bottom'
  className?: string
}

/**
 * Hover/focus tooltip. The trigger receives aria-describedby so screen readers
 * announce the same text that pointer users see.
 */
export function Tooltip({ content, children, placement = 'top', className }: TooltipProps) {
  const id = useId()
  const tooltipId = `tooltip-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`

  if (!isValidElement(children)) return children

  const childProps = children.props as Record<string, unknown>
  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    'aria-describedby':
      [childProps['aria-describedby'], tooltipId].filter(Boolean).join(' ') || undefined,
    onMouseEnter: (event: MouseEvent) => {
      ;(childProps.onMouseEnter as ((e: MouseEvent) => void) | undefined)?.(event)
    },
    onMouseLeave: (event: MouseEvent) => {
      ;(childProps.onMouseLeave as ((e: MouseEvent) => void) | undefined)?.(event)
    },
    onFocus: (event: FocusEvent) => {
      ;(childProps.onFocus as ((e: FocusEvent) => void) | undefined)?.(event)
    },
    onBlur: (event: FocusEvent) => {
      ;(childProps.onBlur as ((e: FocusEvent) => void) | undefined)?.(event)
    },
  })

  return (
    <span className={cn('group/tooltip relative inline-flex', className)}>
      {trigger}
      <span
        id={tooltipId}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-text shadow-panel',
          'group-hover/tooltip:block group-focus-within/tooltip:block',
          placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {content}
      </span>
    </span>
  )
}
