import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui'
import { LanguageSwitch, ThemeSegment } from '@/components/layout/switches'
import { settingsRepo } from '@/db/repo-settings'
import { useUiStore } from '@/stores/uiStore'
import { logEvent } from '@/core/eventLogger'

export function GeneralTab() {
  const { t, i18n } = useTranslation()
  const language = useUiStore((state) => state.language)
  const theme = useUiStore((state) => state.theme)

  // Mirror UI preferences into Dexie so backups and future sync include them.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await settingsRepo.set('ui.language', language, 'ui')
      if (cancelled) return
      await settingsRepo.set('ui.theme', theme, 'ui')
    })()
    return () => {
      cancelled = true
    }
  }, [language, theme])

  useEffect(() => {
    logEvent({
      state: 'SETTINGS',
      action: 'ui.preferences',
      severity: 'info',
      messageMy: `မျက်နှာပြင် ဘာသာစကား/အပြင်အဆင်: ${language} / ${theme}`,
      messageEn: `UI language/theme applied: ${language} / ${theme}`,
      technicalDetail: `lang=${language} theme=${theme}`,
    })
  }, [language, theme])

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={t('settings.general.language')}
        description={t('settings.general.languageDesc')}
        actions={<LanguageSwitch />}
      >
        <p className="text-xs leading-relaxed text-muted">{t('settings.general.samplePreview')}:</p>
        <p
          className={
            i18n.language === 'my'
              ? 'mm-text mt-1.5 rounded-md border border-border bg-raised/50 px-3 py-2 text-sm text-text'
              : 'mt-1.5 rounded-md border border-border bg-raised/50 px-3 py-2 text-sm text-text'
          }
        >
          {t('settings.general.sampleText')}
        </p>
      </Card>

      <Card
        title={t('settings.general.theme')}
        description={t('settings.general.themeDesc')}
        actions={<ThemeSegment />}
      >
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <div>
            <dt className="text-faint">{t('header.theme')}</dt>
            <dd className="mt-0.5 font-medium text-text">
              {theme === 'light'
                ? t('header.themeLight')
                : theme === 'dark'
                  ? t('header.themeDark')
                  : t('header.themeSystem')}
            </dd>
          </div>
          <div>
            <dt className="text-faint">{t('header.language')}</dt>
            <dd className="mt-0.5 font-medium text-text">
              {language === 'en' ? t('header.languageEn') : t('header.languageMy')}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  )
}
