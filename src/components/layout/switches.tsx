import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useUiStore, type Theme } from '@/stores/uiStore'
import { IconMoon, IconSun, IconSystem, IconGlobe } from './icons'
import type { Language } from '@/i18n'

const THEMES: Theme[] = ['light', 'dark', 'system']
const THEME_LABEL_KEY: Record<Theme, string> = {
  light: 'header.themeLight',
  dark: 'header.themeDark',
  system: 'header.themeSystem',
}
const THEME_ICON: Record<Theme, typeof IconSun> = {
  light: IconSun,
  dark: IconMoon,
  system: IconSystem,
}

function nextTheme(current: Theme): Theme {
  const index = THEMES.indexOf(current)
  return THEMES[(index + 1) % THEMES.length]
}

/** Three-way segmented theme control (used in the header on >= md and in Settings). */
export function ThemeSegment({ className }: { className?: string }) {
  const { t } = useTranslation()
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)

  return (
    <div
      role="group"
      aria-label={t('header.theme')}
      className={cn(
        'flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5',
        className,
      )}
    >
      {THEMES.map((option) => {
        const Icon = THEME_ICON[option]
        const active = theme === option
        return (
          <button
            key={option}
            type="button"
            aria-label={t(THEME_LABEL_KEY[option])}
            aria-pressed={active}
            onClick={() => setTheme(option)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors',
              active ? 'bg-primary text-on-primary' : 'text-muted hover:bg-raised hover:text-text',
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        )
      })}
    </div>
  )
}

/** Single button that cycles light → dark → system (compact/mobile header). */
export function ThemeCycle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const Icon = THEME_ICON[theme]
  const label = `${t('header.switchTheme')}: ${t(THEME_LABEL_KEY[theme])}`

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(nextTheme(theme))}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition-colors hover:bg-raised hover:text-text',
        className,
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

const LANGUAGES: Language[] = ['en', 'my']

/** Segmented language switch: English / မြန်မာ. */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t } = useTranslation()
  const language = useUiStore((state) => state.language)
  const setLanguage = useUiStore((state) => state.setLanguage)

  return (
    <div
      role="group"
      aria-label={t('header.switchLanguage')}
      className={cn(
        'flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5',
        className,
      )}
    >
      <span aria-hidden="true" className="pl-1.5 pr-0.5 text-faint">
        <IconGlobe className="h-3.5 w-3.5" />
      </span>
      {LANGUAGES.map((option) => {
        const active = language === option
        return (
          <button
            key={option}
            type="button"
            lang={option}
            aria-pressed={active}
            aria-label={option === 'en' ? t('header.languageEn') : t('header.languageMy')}
            onClick={() => setLanguage(option)}
            className={cn(
              'h-7 rounded-[4px] px-2 text-[11px] font-semibold transition-colors',
              option === 'my' && 'font-mm',
              active ? 'bg-primary text-on-primary' : 'text-muted hover:bg-raised hover:text-text',
            )}
          >
            {option === 'en' ? 'EN' : 'မြန်မာ'}
          </button>
        )
      })}
    </div>
  )
}
