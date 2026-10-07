import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { BOTTOM_NAV_ITEMS } from './navigation'

/** Mobile-only bottom navigation (visible below md / 768px). */
export function BottomTabBar() {
  const { t } = useTranslation()

  return (
    <nav
      aria-label={t('nav.mainNavigation')}
      className="z-header flex h-[var(--bottombar-height)] shrink-0 items-stretch border-t border-border bg-surface md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {BOTTOM_NAV_ITEMS.map((item) => {
        const Icon = item.icon
        return (
          <NavLink
            key={item.id}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors',
                isActive ? 'text-primary' : 'text-muted hover:text-text',
              )
            }
          >
            <Icon className="h-5 w-5" />
            <span className="truncate">{t(item.labelKey)}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
