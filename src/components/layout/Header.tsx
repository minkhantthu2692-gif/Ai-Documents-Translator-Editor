import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@/stores/uiStore'
import { IconMenu, IconClose, IconAlert } from './icons'
import { LanguageSwitch, ThemeCycle, ThemeSegment } from './switches'

export interface HeaderProps {
  onOpenMenu: () => void
  onCloseMenu: () => void
  menuOpen: boolean
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])
  return online
}

export function Header({ onOpenMenu, onCloseMenu, menuOpen }: HeaderProps) {
  const { t } = useTranslation()
  const online = useOnlineStatus()
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)

  return (
    <header className="z-header flex h-[var(--header-height)] shrink-0 items-center gap-2 border-b border-border bg-surface px-2 sm:px-3">
      <button
        type="button"
        onClick={menuOpen ? onCloseMenu : onOpenMenu}
        aria-label={menuOpen ? t('nav.closeMenu') : t('nav.openMenu')}
        aria-expanded={menuOpen}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-raised hover:text-text md:hidden"
      >
        <span aria-hidden="true" className="flex h-4 w-4">
          {menuOpen ? <IconClose /> : <IconMenu />}
        </span>
      </button>

      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={t('header.toggleSidebar')}
        aria-expanded={!sidebarCollapsed}
        className="hidden h-9 w-9 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-raised hover:text-text md:flex"
      >
        <span aria-hidden="true" className="flex h-4 w-4">
          <IconMenu />
        </span>
      </button>

      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-[13px] font-bold text-on-primary"
        >
          A
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-text">
            {t('common.appName')}
          </p>
          {!online ? (
            <p className="flex items-center gap-1 text-[11px] leading-tight text-warning">
              <IconAlert className="h-3 w-3" />
              {t('state.offline')}
            </p>
          ) : null}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <LanguageSwitch />
        <div className="hidden md:block">
          <ThemeSegment />
        </div>
        <div className="md:hidden">
          <ThemeCycle />
        </div>
      </div>
    </header>
  )
}
