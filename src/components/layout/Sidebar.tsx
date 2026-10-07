import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { NAV_ITEMS } from './navigation'
import { IconChevronLeft, IconChevronRight } from './icons'

export interface SidebarProps {
  collapsed: boolean
  onToggleCollapse?: () => void
  /** Drawer variant used under the md breakpoint. */
  variant?: 'rail' | 'drawer'
  onNavigate?: () => void
}

export function Sidebar({
  collapsed,
  onToggleCollapse,
  variant = 'rail',
  onNavigate,
}: SidebarProps) {
  const { t } = useTranslation()
  const drawer = variant === 'drawer'

  return (
    <nav
      aria-label={t('nav.mainNavigation')}
      className={cn(
        'flex h-full min-h-0 flex-col border-r border-border bg-surface',
        drawer
          ? 'w-64'
          : collapsed
            ? 'w-[var(--sidebar-collapsed-width)]'
            : 'w-[var(--sidebar-width)]',
        'transition-[width] duration-150',
      )}
    >
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.id}>
              <NavLink
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                title={!drawer && collapsed ? t(item.labelKey) : undefined}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-focus',
                    isActive
                      ? 'bg-info-bg text-primary'
                      : 'text-muted hover:bg-raised hover:text-text',
                    !drawer && collapsed && 'justify-center px-0',
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className={cn('truncate', !drawer && collapsed && 'sr-only')}>
                  {t(item.labelKey)}
                </span>
              </NavLink>
            </li>
          )
        })}
      </ul>

      {onToggleCollapse ? (
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={t('header.toggleSidebar')}
            aria-expanded={!collapsed}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-text',
              collapsed && 'justify-center px-0',
            )}
          >
            {collapsed ? (
              <IconChevronRight className="h-4 w-4" />
            ) : (
              <IconChevronLeft className="h-4 w-4" />
            )}
            <span className={cn(collapsed && 'sr-only')}>{t('header.toggleSidebar')}</span>
          </button>
        </div>
      ) : null}
    </nav>
  )
}
