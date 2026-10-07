import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { BottomTabBar } from './BottomTabBar'
import { Toaster } from '@/components/ui'
import { applyPersistedLanguage, applyTheme, useUiStore } from '@/stores/uiStore'

/**
 * Application shell.
 *
 * Desktop (>=768px): sidebar + main content, header on top.
 * Mobile (<768px):   header + main + bottom tab bar, navigation as a drawer.
 * The shell fills the viewport (100dvh) and only the main region scrolls.
 */
export function AppShell() {
  const { t } = useTranslation()
  const location = useLocation()
  const theme = useUiStore((state) => state.theme)
  const language = useUiStore((state) => state.language)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const mobileNavOpen = useUiStore((state) => state.mobileNavOpen)
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)

  // Apply theme + language whenever they change (persisted by the UI store).
  useEffect(() => {
    applyTheme(theme)
    applyPersistedLanguage(language)
  }, [theme, language])

  // Keep 'system' theme in sync with the OS while the app is open.
  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return undefined
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [theme])

  // Navigation always closes the mobile drawer.
  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname, setMobileNavOpen])

  // Escape closes the drawer.
  useEffect(() => {
    if (!mobileNavOpen) return undefined
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mobileNavOpen, setMobileNavOpen])

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg">
      <a
        href="#main-content"
        className="sr-only absolute left-2 top-2 z-toast rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text focus:not-sr-only focus:outline-2 focus:outline-focus"
      >
        {t('nav.skipToContent')}
      </a>

      <Header
        menuOpen={mobileNavOpen}
        onOpenMenu={() => setMobileNavOpen(true)}
        onCloseMenu={() => setMobileNavOpen(false)}
      />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden shrink-0 md:flex" aria-label={t('nav.mainNavigation')}>
          <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
        </aside>

        <main
          id="main-content"
          tabIndex={-1}
          className="app-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
        >
          <Outlet />
        </main>
      </div>

      <BottomTabBar />

      {mobileNavOpen ? (
        <div className="fixed inset-0 z-drawer md:hidden">
          <div
            className="absolute inset-0 bg-text/30"
            aria-hidden="true"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 shadow-panel">
            <Sidebar
              variant="drawer"
              collapsed={false}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <Toaster />
    </div>
  )
}
