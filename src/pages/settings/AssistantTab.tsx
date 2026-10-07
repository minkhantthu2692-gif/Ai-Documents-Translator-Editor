import { useTranslation } from 'react-i18next'
import { Card, Switch } from '@/components/ui'
import { SETTING_KEYS } from '@/db/repo-settings'
import { logEvent } from '@/core/eventLogger'
import { useSetting } from './useSetting'

export function AssistantTab() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useSetting<boolean>(SETTING_KEYS.assistantEnabled, true)

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('settings.assistant.title')}>
        <Switch
          checked={enabled}
          onChange={(next) => {
            void setEnabled(next)
            logEvent({
              state: 'SETTINGS',
              action: 'assistant.toggle',
              severity: 'info',
              messageMy: next ? 'ရေးသားမှုလက်ထောက် ဖွင့်ပြီး' : 'ရေးသားမှုလက်ထောက် ပိတ်ပြီး',
              messageEn: next ? 'Writing assistant enabled' : 'Writing assistant disabled',
              technicalDetail: `assistant.enabled=${String(next)}`,
            })
          }}
          label={t('settings.assistant.enabled')}
          description={t('settings.assistant.enabledDesc')}
        />
      </Card>
    </div>
  )
}
