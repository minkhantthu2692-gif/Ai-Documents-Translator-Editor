import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  /** Hides the visible label text (still announced). */
  hideLabel?: boolean
  id?: string
  className?: string
  /** Rendered as `data-testid` on the switch button (smoke/UI tests). */
  testId?: string
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  hideLabel,
  id,
  className,
  testId,
}: SwitchProps) {
  const generatedId = useId()
  const switchId = id ?? generatedId
  const labelId = `${switchId}-label`
  const descriptionId = description ? `${switchId}-description` : undefined

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label
          htmlFor={switchId}
          id={labelId}
          className={cn('cursor-pointer text-sm font-medium text-text', hideLabel && 'sr-only')}
        >
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        id={switchId}
        data-testid={testId}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-primary bg-primary' : 'border-border-strong bg-raised',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'inline-block h-3.5 w-3.5 transform rounded-full transition-transform',
            checked ? 'translate-x-[18px] bg-on-primary' : 'translate-x-[3px] bg-faint',
          )}
        />
      </button>
    </div>
  )
}
