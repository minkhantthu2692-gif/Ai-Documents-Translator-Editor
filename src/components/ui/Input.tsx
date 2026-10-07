import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  iconLeft?: ReactNode
  /** Hides the visual label but keeps it for screen readers. */
  hideLabel?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, iconLeft, hideLabel, className, id, type = 'text', ...rest },
  ref,
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = `${inputId}-hint`
  const describedBy = [hint ? hintId : null, error ? `${inputId}-error` : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label
          htmlFor={inputId}
          className={cn('text-[13px] font-medium text-text', hideLabel && 'sr-only')}
        >
          {label}
        </label>
      ) : null}
      <div className="relative">
        {iconLeft ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 flex h-4 w-4 -translate-y-1/2 text-faint"
          >
            {iconLeft}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          type={type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            'h-9 w-full rounded-md border bg-surface px-3 text-sm text-text placeholder:text-faint',
            'transition-colors hover:border-border-strong',
            'disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint',
            error ? 'border-danger' : 'border-border',
            iconLeft ? 'pl-8' : null,
            className,
          )}
          {...rest}
        />
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, rows = 4, ...rest },
  ref,
) {
  const generatedId = useId()
  const areaId = id ?? generatedId
  const hintId = `${areaId}-hint`
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={areaId} className="text-[13px] font-medium text-text">
          {label}
        </label>
      ) : null}
      <textarea
        ref={ref}
        id={areaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint ? hintId : undefined}
        className={cn(
          'w-full resize-y rounded-md border bg-surface px-3 py-2 text-sm text-text placeholder:text-faint',
          'transition-colors hover:border-border-strong',
          error ? 'border-danger' : 'border-border',
          className,
        )}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
})
