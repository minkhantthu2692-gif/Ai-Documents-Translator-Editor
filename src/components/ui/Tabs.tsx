import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface TabItem {
  id: string
  label: ReactNode
  content: ReactNode
  disabled?: boolean
}

export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  /** Accessible name for the tablist. */
  ariaLabel: string
  className?: string
  /** Rendered above the tab strip (e.g. descriptions). */
  extra?: ReactNode
}

export function Tabs({ items, value, onChange, ariaLabel, className, extra }: TabsProps) {
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === value),
  )

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = items.filter((item) => !item.disabled)
    if (enabled.length === 0) return
    const currentIndex = enabled.findIndex((item) => item.id === value)
    let nextIndex = currentIndex

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % enabled.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + enabled.length) % enabled.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = enabled.length - 1
    } else {
      return
    }

    event.preventDefault()
    const next = enabled[nextIndex]
    onChange(next.id)
    const button = listRef.current?.querySelector<HTMLButtonElement>(`#${cssId(baseId, next.id)}`)
    button?.focus()
  }

  const active = items[activeIndex]

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-border pb-px"
      >
        {items.map((item) => {
          const selected = item.id === value
          return (
            <button
              key={item.id}
              id={cssId(baseId, item.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={cssId(baseId, `${item.id}-panel`)}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
              className={cn(
                'relative whitespace-nowrap rounded-t-md border-b-2 px-3.5 py-2 text-sm font-medium transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
                selected
                  ? 'border-primary text-text'
                  : 'border-transparent text-muted hover:bg-raised hover:text-text',
              )}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {extra ? <div className="pt-3">{extra}</div> : null}
      {active ? (
        <div
          id={cssId(baseId, `${active.id}-panel`)}
          role="tabpanel"
          aria-labelledby={cssId(baseId, active.id)}
          tabIndex={0}
          className="min-h-0 flex-1 pt-4 outline-none"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  )
}

function cssId(base: string, value: string): string {
  return `${base}${value}`.replace(/[^a-zA-Z0-9_-]/g, '')
}
