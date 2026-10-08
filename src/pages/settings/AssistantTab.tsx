import { useTranslation } from 'react-i18next'
import { Button, Card, Switch } from '@/components/ui'
import { IconSparkle } from '@/components/layout/icons'
import { SETTING_KEYS } from '@/db/repo-settings'
import { logEvent } from '@/core/eventLogger'
import { useAssistantStore } from '@/stores/assistantStore'
import { useSetting } from './useSetting'

export function AssistantTab() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useSetting<boolean>(SETTING_KEYS.assistantEnabled, true)
  const openDialog = useAssistantStore((state) => state.openDialog)

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

      <Card title={t('assistant.title')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">{t('assistant.openDesc')}</p>
          <div>
            <Button
              data-testid="assistant-open"
              iconLeft={<IconSparkle className="h-4 w-4" />}
              onClick={() => openDialog()}
            >
              {t('assistant.launch')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
