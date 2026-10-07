import { useTranslation } from 'react-i18next'
import { Badge, Card, EmptyState } from '@/components/ui'
import { IconKey, IconSparkle } from '@/components/layout/icons'

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'groq', label: 'Groq' },
  { id: 'ollama', label: 'Ollama (local)' },
]

export function ProvidersTab() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={t('settings.providers.title')}
        description={t('settings.providers.keyStorageDesc')}
      >
        <div className="flex items-start gap-3 rounded-md border border-dashed border-border bg-raised/40 px-3 py-3">
          <span aria-hidden="true" className="mt-0.5 text-faint">
            <IconKey className="h-4 w-4" />
          </span>
          <p className="text-xs leading-relaxed text-muted">
            <span className="font-medium text-text">{t('settings.providers.keyStorage')}</span>
            <br />
            {t('settings.providers.keyStorageDesc')}
          </p>
        </div>
      </Card>

      <Card title={t('settings.providers.providersList')}>
        <EmptyState
          title={t('settings.providers.placeholderTitle')}
          body={t('settings.providers.placeholderBody')}
          icon={<IconSparkle className="h-10 w-10" />}
        />
        <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PROVIDERS.map((provider) => (
            <li
              key={provider.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="truncate text-text">{provider.label}</span>
              <Badge tone="neutral">{t('common.disabled')}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
