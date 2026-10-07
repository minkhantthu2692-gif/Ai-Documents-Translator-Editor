import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Tooltip } from './Tooltip'

export type IconButtonVariant = 'ghost' | 'secondary' | 'danger' | 'primary'
export type IconButtonSize = 'sm' | 'md'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only controls must expose an accessible name. */
  label: string
  icon: ReactNode
  variant?: IconButtonVariant
  size?: IconButtonSize
  /** Renders the label in a tooltip (default true). */
  tooltip?: boolean
}

const variantClasses: Record<IconButtonVariant, string> = {
  ghost: 'border-transparent bg-transparent text-muted hover:bg-raised hover:text-text',
  secondary: 'border-border bg-surface text-text hover:bg-raised hover:border-border-strong',
  danger: 'border-danger bg-danger text-on-danger hover:opacity-90',
  primary: 'border-primary bg-primary text-on-primary hover:bg-primary-hover',
}

const sizeClasses: Record<IconButtonSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    tooltip = true,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center rounded-md border transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
        {icon}
      </span>
    </button>
  )

  if (!tooltip) return button
  return <Tooltip content={label}>{button}</Tooltip>
})
