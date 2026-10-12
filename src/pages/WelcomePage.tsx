import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card } from '@/components/ui'
import { SUPPORTED_LANGUAGES, type Language } from '@/i18n'
import { applyTheme, useUiStore } from '@/stores/uiStore'
import {
  IconCheck,
  IconDatabase,
  IconFile,
  IconGlobe,
  IconKey,
  IconLanguage,
  IconMoon,
  IconSun,
  IconSystem,
} from '@/components/layout/icons'
import { cn } from '@/lib/cn'

type SyncChoice = 'skip' | 'settings'
type ThemeOption = 'light' | 'dark' | 'system'

const THEME_OPTIONS: ThemeOption[] = ['light', 'dark', 'system']
const THEME_LABEL_KEY: Record<ThemeOption, string> = {
  light: 'welcome.themeLight',
  dark: 'welcome.themeDark',
  system: 'welcome.themeSystem',
}
const THEME_ICON: Record<ThemeOption, typeof IconSun> = {
  light: IconSun,
  dark: IconMoon,
  system: IconSystem,
}
const LANGUAGE_LABEL: Record<Language, string> = { en: 'English', my: 'မြန်မာ' }

/** The product pitch on the left of the landing screen, in reading order. */
const FEATURES: Array<{ icon: typeof IconFile; titleKey: string; descKey: string }> = [
  {
    icon: IconFile,
    titleKey: 'welcome.fLayoutTitle',
    descKey: 'welcome.fLayoutDesc',
  },
  {
    icon: IconGlobe,
    titleKey: 'welcome.fFormatsTitle',
    descKey: 'welcome.fFormatsDesc',
  },
  {
    icon: IconLanguage,
    titleKey: 'welcome.fFontsTitle',
    descKey: 'welcome.fFontsDesc',
  },
  {
    icon: IconKey,
    titleKey: 'welcome.fKeysTitle',
    descKey: 'welcome.fKeysDesc',
  },
  {
    icon: IconDatabase,
    titleKey: 'welcome.fLocalTitle',
    descKey: 'welcome.fLocalDesc',
  },
  {
    icon: IconSun,
    titleKey: 'welcome.fSyncTitle',
    descKey: 'welcome.fSyncDesc',
  },
]

interface StepProps {
  index: number
  title: string
  description: string
  children: ReactNode
}

/** One numbered choice inside the setup panel — label, hint, then the control. */
function Step({ index, title, description, children }: StepProps) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border bg-raised text-[10px] font-semibold tabular-nums text-muted">
          {index}
        </span>
        <h3 className="text-[13px] font-semibold text-text">{title}</h3>
      </div>
      <p className="mt-1 pl-7 text-xs leading-relaxed text-muted">{description}</p>
      <div className="mt-2.5 pl-7">{children}</div>
    </section>
  )
}

/**
 * First-run landing + setup, one screen (the combined form the spec allows).
 *
 * Shown at `/` until `onboarded` is set: a two-column landing — what the app
 * does on the left, the three setup choices on the right — so a first-time
 * visitor reads the pitch and finishes setup without scrolling on desktop.
 * Pick the UI language, the theme and whether cloud sync will be set up later,
 * then "Get started" heads to the new-project flow.
 *
 * It renders outside the AppShell on purpose — a fresh install has nothing to
 * navigate to yet — so it applies the theme itself. A factory reset clears the
 * persisted store, which brings this screen back.
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
    <main className="min-h-screen bg-bg">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center px-5 py-10 lg:py-14">
        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:gap-14">
          {/* ---------------------------------------------------------------- */}
          {/* Product: who this is for and what it does.                        */}
          {/* ---------------------------------------------------------------- */}
          <section className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-surface text-primary">
                <IconLanguage className="h-5 w-5" />
              </span>
              <span className="min-w-0 truncate text-sm font-semibold text-text">
                {t('common.appName')}
              </span>
            </div>

            <p className="mt-7 inline-flex items-center rounded-sm border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-accent">
              {t('welcome.kicker')}
            </p>
            <h1 className="mt-3 max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-text sm:text-4xl">
              {t('welcome.headline')}
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
              {t('welcome.subtitle')}
            </p>

            <h2 className="mt-9 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('welcome.featuresTitle')}
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {FEATURES.map((feature) => {
                const FeatureIcon = feature.icon
                return (
                  <div
                    key={feature.titleKey}
                    className="rounded-md border border-border bg-surface p-4"
                  >
                    <p className="flex items-center gap-2 text-[13px] font-semibold text-text">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-sm border border-border bg-raised text-accent">
                        <FeatureIcon />
                      </span>
                      <span className="min-w-0">{t(feature.titleKey)}</span>
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      {t(feature.descKey)}
                    </p>
                  </div>
                )
              })}
            </div>

            <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-faint">
              <IconCheck className="mt-px h-3.5 w-3.5 text-success" />
              {t('welcome.localFirst')}
            </p>
          </section>

          {/* ---------------------------------------------------------------- */}
          {/* Setup: the three choices, then the way out.                       */}
          {/* ---------------------------------------------------------------- */}
          <section className="w-full">
            <Card title={t('welcome.setupTitle')} description={t('welcome.setupLede')}>
              <div className="flex flex-col gap-5">
                <Step
                  index={1}
                  title={t('welcome.stepLanguage')}
                  description={t('welcome.languageDesc')}
                >
                  <div className="grid grid-cols-2 gap-2">
                    {SUPPORTED_LANGUAGES.map((code) => (
                      <button
                        key={code}
                        type="button"
                        lang={code}
                        aria-pressed={language === code}
                        onClick={() => setLanguage(code)}
                        className={cn(
                          'flex h-9 items-center justify-center gap-1.5 rounded-md border text-sm font-medium transition-colors',
                          language === code
                            ? 'border-primary bg-primary/10 text-text'
                            : 'border-border bg-raised text-muted hover:border-border-strong hover:text-text',
                          // The Latin UI stack has no Myanmar glyphs: fall back to
                          // the bundled faces so this label never renders as boxes.
                          code === 'my' && 'mm-text',
                        )}
                      >
                        {language === code ? (
                          <IconCheck className="h-3.5 w-3.5 text-primary" />
                        ) : null}
                        {LANGUAGE_LABEL[code]}
                      </button>
                    ))}
                  </div>
                </Step>

                <Step
                  index={2}
                  title={t('welcome.stepAppearance')}
                  description={t('welcome.themeDesc')}
                >
                  <div className="grid grid-cols-3 gap-2">
                    {THEME_OPTIONS.map((option) => {
                      const ThemeIcon = THEME_ICON[option]
                      return (
                        <button
                          key={option}
                          type="button"
                          aria-pressed={theme === option}
                          aria-label={t(THEME_LABEL_KEY[option])}
                          onClick={() => setTheme(option)}
                          className={cn(
                            'flex flex-col items-center gap-1.5 rounded-md border px-2 py-2.5 text-xs font-medium transition-colors',
                            theme === option
                              ? 'border-primary bg-primary/10 text-text'
                              : 'border-border bg-raised text-muted hover:border-border-strong hover:text-text',
                          )}
                        >
                          <ThemeIcon className="h-4 w-4" />
                          <span>{t(THEME_LABEL_KEY[option])}</span>
                        </button>
                      )
                    })}
                  </div>
                </Step>

                <Step index={3} title={t('welcome.stepSync')} description={t('welcome.syncDesc')}>
                  <div className="flex flex-col gap-2">
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                        syncChoice === 'skip'
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-border-strong',
                      )}
                    >
                      <input
                        type="radio"
                        name="welcome-sync-choice"
                        checked={syncChoice === 'skip'}
                        onChange={() => setSyncChoice('skip')}
                        className="mt-0.5 accent-[rgb(var(--color-primary))]"
                      />
                      <span className="min-w-0 text-text">
                        <span className="font-medium">{t('welcome.syncSkip')}</span>
                        <span className="block text-xs leading-relaxed text-muted">
                          {t('welcome.syncSkipDesc')}
                        </span>
                      </span>
                    </label>
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                        syncChoice === 'settings'
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-border-strong',
                      )}
                    >
                      <input
                        type="radio"
                        name="welcome-sync-choice"
                        checked={syncChoice === 'settings'}
                        onChange={() => setSyncChoice('settings')}
                        className="mt-0.5 accent-[rgb(var(--color-primary))]"
                      />
                      <span className="min-w-0 text-text">
                        <span className="font-medium">{t('welcome.syncLater')}</span>
                        <span className="block text-xs leading-relaxed text-muted">
                          {t('welcome.syncLaterDesc')}
                        </span>
                      </span>
                    </label>
                  </div>
                </Step>

                <div className="flex flex-col gap-2.5 border-t border-border pt-4">
                  <Button
                    variant="primary"
                    size="lg"
                    fullWidth
                    data-testid="welcome-get-started"
                    onClick={() =>
                      finish(syncChoice === 'settings' ? '/settings?tab=data' : '/projects/new')
                    }
                  >
                    {t('welcome.getStarted')}
                  </Button>
                  <button
                    type="button"
                    className="text-center text-xs text-muted transition-colors hover:text-accent"
                    onClick={() => finish('/')}
                  >
                    {t('welcome.skipToDashboard')}
                  </button>
                  <p className="text-center text-[11px] leading-relaxed text-faint">
                    {t('welcome.changeLater')}
                  </p>
                </div>
              </div>
            </Card>
          </section>
        </div>
      </div>
    </main>
  )
}
