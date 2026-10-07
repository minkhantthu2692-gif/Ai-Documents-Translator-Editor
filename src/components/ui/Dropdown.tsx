/**
 * Dropdown menu (Phase 4).
 *
 * A flat popover used for the font family / font size / "Export as" menus:
 * one trigger button, a menu of actions, keyboard navigation and no shadows
 * (the design system is borders-only). It stays uncontrolled so the caller
 * owns the selected value — the menu just reports what was picked.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'

export interface DropdownAction {
  id: string
  label: ReactNode
  /** Right-aligned hint: shortcut, current value, count. */
  hint?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** Renders the check mark (the caller knows the current value). */
  selected?: boolean
  danger?: boolean
  onSelect?: () => void
}

export type DropdownEntry =
  | DropdownAction
  | { id: string; kind: 'separator' }
  | { id: string; kind: 'heading'; label: ReactNode }

export interface DropdownProps {
  /** Trigger label (text + optional icon). */
  trigger: ReactNode
  entries: DropdownEntry[]
  align?: 'start' | 'end'
  /** Fixed menu width; otherwise the menu grows with its content. */
  width?: number
  disabled?: boolean
  /** Accessible name for the trigger (when the trigger is only an icon). */
  label?: string
  triggerClassName?: string
  menuClassName?: string
  testId?: string
  onOpenChange?: (open: boolean) => void
}

export function Dropdown({
  trigger,
  entries,
  align = 'start',
  width,
  disabled,
  label,
  triggerClassName,
  menuClassName,
  testId,
  onOpenChange,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  const change = useCallback(
    (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  const close = useCallback(
    (returnFocus = false) => {
      change(false)
      if (returnFocus) triggerRef.current?.focus()
    },
    [change],
  )

  // Click / focus outside closes the menu.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) change(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, change])

  const items = useCallback(
    () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLButtonElement>(
          'button[data-dropdown-item]:not([disabled])',
        ) ?? [],
      ),
    [],
  )

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items()
    if (list.length === 0) return
    const current = list.findIndex((item) => item === document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      change(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next =
        current < 0
          ? delta > 0
            ? 0
            : list.length - 1
          : (current + delta + list.length) % list.length
      list[next]?.focus()
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      list[0]?.focus()
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      list[list.length - 1]?.focus()
    }
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      change(true)
      requestAnimationFrame(() => items()[0]?.focus())
      return
    }
    if (event.key === 'Escape') close()
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => change(!open)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-sm text-text',
          'transition-colors hover:border-border-strong',
          'disabled:cursor-not-allowed disabled:text-faint',
          open && 'border-border-strong',
          triggerClassName,
        )}
      >
        {trigger}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-faint transition-transform',
            open && 'rotate-180',
          )}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          style={width ? { width } : undefined}
          className={cn(
            'absolute z-40 mt-1 min-w-max overflow-hidden rounded-md border border-border bg-raised py-1',
            align === 'end' ? 'right-0' : 'left-0',
            menuClassName,
          )}
        >
          {entries.map((entry) => {
            if ('kind' in entry && entry.kind === 'separator') {
              return <div key={entry.id} role="separator" className="my-1 h-px bg-border" />
            }
            if ('kind' in entry && entry.kind === 'heading') {
              return (
                <div
                  key={entry.id}
                  className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint"
                >
                  {entry.label}
                </div>
              )
            }
            const action = entry
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                data-dropdown-item=""
                disabled={action.disabled}
                onClick={() => {
                  action.onSelect?.()
                  close(true)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text',
                  'hover:bg-surface focus-visible:bg-surface focus-visible:outline-none',
                  'disabled:cursor-not-allowed disabled:text-faint',
                  action.danger && 'text-danger',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                    !action.selected && 'invisible',
                  )}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 8.5l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                {action.icon}
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.hint ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-faint">
                    {action.hint}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
