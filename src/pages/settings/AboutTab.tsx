import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui'
import { DB_NAME, DB_SCHEMA_VERSION } from '@/db/db'
import { BACKUP_SCHEMA_VERSION } from '@/db/backup'

const REPO_URL = 'https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor.git'

export function AboutTab() {
  const { t } = useTranslation()
  const version = import.meta.env.VITE_APP_VERSION ?? '0.1.0'

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('settings.about.title')}>
        <dl className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
            <dt className="text-muted">{t('settings.about.version')}</dt>
            <dd className="tabular-nums text-text">{version}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
            <dt className="text-muted">{t('settings.about.schema')}</dt>
            <dd className="tabular-nums text-text">
              {DB_NAME} v{DB_SCHEMA_VERSION} · backup v{BACKUP_SCHEMA_VERSION}
            </dd>
          </div>
          <div className="flex flex-col gap-1 border-b border-border pb-2">
            <dt className="text-muted">{t('settings.about.storage')}</dt>
            <dd className="text-text">{t('settings.about.storageDesc')}</dd>
          </div>
          <div className="flex flex-col gap-1 border-b border-border pb-2">
            <dt className="text-muted">{t('settings.about.offline')}</dt>
            <dd className="text-text">{t('settings.about.offlineDesc')}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted">{t('settings.about.repo')}</dt>
            <dd>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-accent underline-offset-4 hover:underline"
              >
                {REPO_URL}
              </a>
            </dd>
          </div>
        </dl>
      </Card>

      <Card title={t('settings.about.licensesTitle')}>
        <p className="text-xs leading-relaxed text-muted">{t('settings.about.licenses')}</p>
      </Card>
    </div>
  )
}
