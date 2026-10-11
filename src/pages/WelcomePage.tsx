import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card } from '@/components/ui'
import { SUPPORTED_LANGUAGES, type Language } from '@/i18n'
import { applyTheme, useUiStore } from '@/stores/uiStore'

type SyncChoice = 'skip' | 'settings'
type ThemeOption = 'light' | 'dark' | 'system'

const THEME_OPTIONS: ThemeOption[] = ['light', 'dark', 'system']
const THEME_LABEL_KEY: Record<ThemeOption, string> = {
  light: 'welcome.themeLight',
  dark: 'welcome.themeDark',
  system: 'welcome.themeSystem',
}
const LANGUAGE_LABEL: Record<Language, string> = { en: 'English', my: 'မြန်မာ' }

/**
 * First-run landing + setup, one screen (the combined form the spec allows).
 *
 * Shown at `/` until `onboarded` is set: pick the UI language, the theme and
 * whether cloud sync will be set up later, then "Get started" heads to the
 * new-project flow. It renders outside the AppShell on purpose — a fresh
 * install has nothing to navigate to yet — so it applies the theme itself.
 * A factory reset clears the persisted store, which brings this screen back.
 */
export function WelcomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const language = useUiStore((state) => state.language)
  const setLanguage = useUiStore((state) => state.setLanguage)
  const completeOnboarding = useUiStore((state) => state.completeOnboarding)
  const [syncChoice, setSyncChoice] = useState<SyncChoice>('skip')

  // The theme effect normally lives in the AppShell, which this page bypasses.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  function finish(destination: string) {
    completeOnboarding()
    navigate(destination, { replace: true })
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-xl">
        <header className="mb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            {t('welcome.kicker')}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-text">{t('common.appName')}</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">{t('welcome.subtitle')}</p>
        </header>

        <div className="flex flex-col gap-4">
          <Card title={t('welcome.stepLanguage')} description={t('welcome.languageDesc')}>
            <div className="flex flex-wrap gap-2">
              {SUPPORTED_LANGUAGES.map((code) => (
                <Button
                  key={code}
                  lang={code}
                  variant={language === code ? 'primary' : 'secondary'}
                  onClick={() => setLanguage(code)}
                >
                  {LANGUAGE_LABEL[code]}
                </Button>
              ))}
            </div>
          </Card>

          <Card title={t('welcome.stepAppearance')} description={t('welcome.themeDesc')}>
            <div className="flex flex-wrap gap-2">
              {THEME_OPTIONS.map((option) => (
                <Button
                  key={option}
                  variant={theme === option ? 'primary' : 'secondary'}
                  aria-label={t(THEME_LABEL_KEY[option])}
                  onClick={() => setTheme(option)}
                >
                  {t(THEME_LABEL_KEY[option])}
                </Button>
              ))}
            </div>
          </Card>

          <Card title={t('welcome.stepSync')} description={t('welcome.syncDesc')}>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-text">
                <input
                  type="radio"
                  name="welcome-sync-choice"
                  checked={syncChoice === 'skip'}
                  onChange={() => setSyncChoice('skip')}
                  className="mt-0.5 accent-[rgb(var(--color-primary))]"
                />
                <span>
                  <span className="font-medium">{t('welcome.syncSkip')}</span>
                  <span className="block text-xs text-muted">{t('welcome.syncSkipDesc')}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-text">
                <input
                  type="radio"
                  name="welcome-sync-choice"
                  checked={syncChoice === 'settings'}
                  onChange={() => setSyncChoice('settings')}
                  className="mt-0.5 accent-[rgb(var(--color-primary))]"
                />
                <span>
                  <span className="font-medium">{t('welcome.syncLater')}</span>
                  <span className="block text-xs text-muted">{t('welcome.syncLaterDesc')}</span>
                </span>
              </label>
            </div>
          </Card>

          <div className="flex flex-col items-center gap-3 pt-2">
            <Button
              variant="primary"
              data-testid="welcome-get-started"
              onClick={() =>
                finish(syncChoice === 'settings' ? '/settings?tab=data' : '/projects/new')
              }
            >
              {t('welcome.getStarted')}
            </Button>
            <button
              type="button"
              className="text-xs text-muted transition-colors hover:text-accent"
              onClick={() => finish('/')}
            >
              {t('welcome.skipToDashboard')}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
