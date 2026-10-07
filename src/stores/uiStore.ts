/**
 * UI state: theme, language and panel layout.
 * Persisted to localStorage under `aidt.ui` — the inline boot script in
 * index.html reads the same key to avoid a flash of the wrong theme.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import i18n, { applyDocumentLanguage, type Language } from '@/i18n'

export type Theme = 'light' | 'dark' | 'system'
export type ProjectsView = 'list' | 'grid'

interface UiState {
  theme: Theme
  language: Language
  sidebarCollapsed: boolean
  mobileNavOpen: boolean
  inspectorOpen: boolean
  projectsView: ProjectsView
  setTheme: (theme: Theme) => void
  setLanguage: (language: Language) => void
  toggleSidebar: () => void
  setMobileNavOpen: (open: boolean) => void
  toggleInspector: () => void
  setProjectsView: (view: ProjectsView) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      language: 'en',
      sidebarCollapsed: false,
      mobileNavOpen: false,
      inspectorOpen: true,
      projectsView: 'grid',
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => {
        void i18n.changeLanguage(language)
        applyDocumentLanguage(language)
        set({ language })
      },
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
      toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),
      setProjectsView: (projectsView) => set({ projectsView }),
    }),
    {
      name: 'aidt.ui',
      version: 1,
      partialize: (state) => ({
        theme: state.theme,
        language: state.language,
        sidebarCollapsed: state.sidebarCollapsed,
        projectsView: state.projectsView,
        inspectorOpen: state.inspectorOpen,
      }),
    },
  ),
)

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Resolves 'system' against the OS preference. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return theme
}

/** Applies theme class + colour-scheme + lang to <html>. */
export function applyTheme(theme: Theme): 'light' | 'dark' {
  const resolved = resolveTheme(theme)
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.classList.toggle('dark', resolved === 'dark')
    root.style.colorScheme = resolved
  }
  return resolved
}

/** Applies the persisted language to i18next and <html lang>. */
export function applyPersistedLanguage(language: Language): void {
  void i18n.changeLanguage(language)
  applyDocumentLanguage(language)
}
