/**
 * Knowledge page (Phase 4): one place for everything a translator learns —
 * the glossary manager, the translation-memory browser and the preset
 * project templates.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, type TabItem } from '@/components/ui'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { GlossaryTab } from './knowledge/GlossaryTab'
import { TmTab } from './knowledge/TmTab'
import { TemplatesTab } from './knowledge/TemplatesTab'

export function KnowledgePage() {
  const { t } = useTranslation()
  const [active, setActive] = useState('glossary')

  const items = useMemo<TabItem[]>(
    () => [
      { id: 'glossary', label: t('knowledge.tabs.glossary'), content: <GlossaryTab /> },
      { id: 'tm', label: t('knowledge.tabs.tm'), content: <TmTab /> },
      { id: 'templates', label: t('knowledge.tabs.templates'), content: <TemplatesTab /> },
    ],
    [t],
  )

  return (
    <PageContainer>
      <PageHeader title={t('knowledge.title')} subtitle={t('knowledge.subtitle')} />

      <Tabs
        items={items}
        value={active}
        onChange={setActive}
        ariaLabel={t('knowledge.title')}
        className="min-h-0 flex-1"
      />
    </PageContainer>
  )
}
