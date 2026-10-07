import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Tabs, type TabItem } from '@/components/ui'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { GeneralTab } from './settings/GeneralTab'
import { CacheTab } from './settings/CacheTab'
import { DataTab } from './settings/DataTab'
import { ProvidersTab } from './settings/ProvidersTab'
import { AssistantTab } from './settings/AssistantTab'
import { AboutTab } from './settings/AboutTab'

const TAB_IDS = ['general', 'cache', 'data', 'providers', 'assistant', 'about'] as const
type TabId = (typeof TAB_IDS)[number]

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value)
}

export function SettingsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const active: TabId = isTabId(rawTab) ? rawTab : 'general'

  const items = useMemo<TabItem[]>(
    () => [
      { id: 'general', label: t('settings.tabs.general'), content: <GeneralTab /> },
      { id: 'cache', label: t('settings.tabs.cache'), content: <CacheTab /> },
      { id: 'data', label: t('settings.tabs.data'), content: <DataTab /> },
      { id: 'providers', label: t('settings.tabs.providers'), content: <ProvidersTab /> },
      { id: 'assistant', label: t('settings.tabs.assistant'), content: <AssistantTab /> },
      { id: 'about', label: t('settings.tabs.about'), content: <AboutTab /> },
    ],
    [t],
  )

  return (
    <PageContainer>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      <Tabs
        items={items}
        value={active}
        onChange={(id) => setSearchParams({ tab: id }, { replace: true })}
        ariaLabel={t('settings.title')}
        className="min-h-0 flex-1"
      />
    </PageContainer>
  )
}
