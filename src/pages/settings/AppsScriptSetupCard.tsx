import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card } from '@/components/ui'
import { IconChevronDown, IconDownload } from '@/components/layout/icons'
import { downloadAppsScript, downloadAppsScriptManifest } from '@/sync'

/**
 * Settings → Data — how to stand up the Apps Script backend, plus the two
 * buttons that hand over the files.
 *
 * The guide used to live only in `docs/GOOGLE_APPS_SCRIPT_SETUP.md`, which
 * meant a user had to find the repository to learn what to paste. It is
 * rendered here as native, translatable markup rather than the raw Markdown —
 * there is no Markdown renderer in this bundle, and a translated step list
 * reads better than an English document inside a Myanmar UI.
 */
const STEPS: { title: string; body: string }[] = [
  { title: 'settings.appsScript.step1', body: 'settings.appsScript.step1Body' },
  { title: 'settings.appsScript.step2', body: 'settings.appsScript.step2Body' },
  { title: 'settings.appsScript.step3', body: 'settings.appsScript.step3Body' },
  { title: 'settings.appsScript.step4', body: 'settings.appsScript.step4Body' },
  { title: 'settings.appsScript.step5', body: 'settings.appsScript.step5Body' },
  { title: 'settings.appsScript.step6', body: 'settings.appsScript.step6Body' },
]

export function AppsScriptSetupCard() {
  const { t } = useTranslation()
  // Open by default: the guide is the reason this card exists, and hiding the
  // only instructions for setting up sync behind a click defeats the purpose.
  const [open, setOpen] = useState(true)

  return (
    <Card title={t('settings.appsScript.title')} description={t('settings.appsScript.desc')}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="apps-script-download-code"
            iconLeft={<IconDownload className="h-4 w-4" />}
            onClick={() => void downloadAppsScript()}
          >
            {t('settings.appsScript.downloadCode')}
          </Button>
          <Button
            data-testid="apps-script-download-manifest"
            variant="secondary"
            iconLeft={<IconDownload className="h-4 w-4" />}
            onClick={() => void downloadAppsScriptManifest()}
          >
            {t('settings.appsScript.downloadManifest')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('settings.appsScript.downloadHint')}</p>

        <Button
          data-testid="apps-script-guide-toggle"
          variant="ghost"
          className="justify-start self-start"
          aria-expanded={open}
          iconLeft={
            <IconChevronDown
              className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`}
            />
          }
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('settings.appsScript.hideGuide') : t('settings.appsScript.showGuide')}
        </Button>

        {open ? (
          <div className="flex flex-col gap-4">
            <ol data-testid="apps-script-guide" className="flex flex-col gap-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-xs font-semibold text-muted"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{t(step.title)}</p>
                    <p className="text-xs text-muted">{t(step.body)}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div
              data-testid="apps-script-update-note"
              className="rounded-md border border-border bg-surface-2 px-3 py-2"
            >
              <p className="text-sm font-medium text-text">
                {t('settings.appsScript.updateTitle')}
              </p>
              <p className="text-xs text-muted">{t('settings.appsScript.updateBody')}</p>
            </div>

            <p className="text-xs text-muted">{t('settings.appsScript.ownNote')}</p>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
