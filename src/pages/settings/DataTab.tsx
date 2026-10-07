import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Button, Card, ConfirmDialog, Input, Select, Switch } from '@/components/ui'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { downloadBackup, restoreBackupFromFile } from '@/db/backup'
import { deleteDatabase } from '@/db/db'
import { outboxRepo } from '@/db/repo-outbox'
import { destroyDeviceSecret, sealText, type SealedPayload } from '@/core/crypto'
import { logEvent } from '@/core/eventLogger'
import { toast } from '@/stores/toastStore'
import { useUiStore } from '@/stores/uiStore'
import { useSetting } from './useSetting'

interface TokenSetting {
  sealed: SealedPayload | null
  lastFour: string
}

const EMPTY_TOKEN: TokenSetting = { sealed: null, lastFour: '' }

export function DataTab() {
  const { t } = useTranslation()
  const [appsScriptUrl, setAppsScriptUrl] = useSetting<string>(SETTING_KEYS.appsScriptUrl, '')
  const [tokenSetting, setTokenSetting] = useSetting<TokenSetting>(
    SETTING_KEYS.appsScriptToken,
    EMPTY_TOKEN,
  )
  const [syncEnabled, setSyncEnabled] = useSetting<boolean>(SETTING_KEYS.syncEnabled, false)
  const [autoSync, setAutoSync] = useSetting<boolean>(SETTING_KEYS.autoSync, false)
  const [interval, setIntervalMinutes] = useSetting<number>(SETTING_KEYS.autoSyncInterval, 15)
  const [conflictPolicy, setConflictPolicy] = useSetting<string>(
    SETTING_KEYS.conflictPolicy,
    'newest',
  )

  const pendingSync = useLiveQuery(() => outboxRepo.pendingCount(), [])
  const fileRef = useRef<HTMLInputElement>(null)
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('replace')
  const [tokenDraft, setTokenDraft] = useState('')
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [busy, setBusy] = useState(false)

  async function saveToken() {
    const value = tokenDraft.trim()
    if (!value) return
    const sealed = await sealText(value)
    await setTokenSetting({ sealed, lastFour: value.slice(-4) })
    setTokenDraft('')
    logEvent({
      state: 'SETTINGS',
      action: 'sync.token.save',
      severity: 'success',
      messageMy: 'ဝင်ရောက်ခွင့်သော့ ကုဒ်ပြင်းထပ်၍ သိမ်းပြီး',
      messageEn: 'Access token encrypted and stored',
      technicalDetail: 'AES-GCM / PBKDF2-SHA256 150000 iterations',
    })
    toast('success', t('common.saved'))
  }

  async function exportBackup() {
    setBusy(true)
    try {
      const file = await downloadBackup()
      logEvent({
        state: 'BACKUP',
        action: 'backup.export',
        severity: 'success',
        messageMy: `မိတ္တူ ထုတ်ယူပြီး: ${file}`,
        messageEn: `Backup exported: ${file}`,
        technicalDetail: file,
      })
      toast('success', t('settings.data.exported', { file }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast('danger', t('toast.failed'), message)
    } finally {
      setBusy(false)
    }
  }

  async function importBackup(file: File) {
    setBusy(true)
    try {
      const report = await restoreBackupFromFile(file, importMode)
      logEvent({
        state: 'BACKUP',
        action: 'backup.import',
        severity: report.warnings.length > 0 ? 'warning' : 'success',
        messageMy: `မိတ္တူ သွင်းယူပြီး (${importMode})`,
        messageEn: `Backup imported (${importMode})`,
        technicalDetail: JSON.stringify(report),
      })

      // Apply UI preferences that travelled with the backup.
      const language = await settingsRepo.get<string>('ui.language', '')
      if (language === 'en' || language === 'my') useUiStore.getState().setLanguage(language)
      const theme = await settingsRepo.get<string>('ui.theme', '')
      if (theme === 'light' || theme === 'dark' || theme === 'system') {
        useUiStore.getState().setTheme(theme)
      }

      toast(
        report.warnings.length > 0 ? 'warning' : 'success',
        t('settings.data.imported'),
        report.warnings.length > 0 ? report.warnings.join(', ') : file.name,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent({
        state: 'BACKUP',
        action: 'backup.import.failed',
        reasonCode: 'BACKUP_INVALID',
        severity: 'error',
        technicalDetail: message,
      })
      toast('danger', t('settings.data.importFailed'), message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function deleteEverything() {
    setBusy(true)
    try {
      destroyDeviceSecret()
      await deleteDatabase()
      toast('success', t('settings.data.deleted'))
      window.setTimeout(() => window.location.reload(), 350)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast('danger', t('toast.failed'), message)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={t('settings.data.sync')}
        description={t('settings.data.cloudNote')}
        actions={
          pendingSync ? (
            <Badge tone="warning" dot>
              {t('settings.data.syncPending', { count: pendingSync })}
            </Badge>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label={t('settings.data.appsScriptUrl')}
            hint={t('settings.data.appsScriptUrlDesc')}
            type="url"
            inputMode="url"
            placeholder="https://script.google.com/macros/s/…/exec"
            value={appsScriptUrl}
            onChange={(event) => void setAppsScriptUrl(event.target.value)}
          />

          <Input
            label={t('settings.data.appsScriptToken')}
            hint={t('settings.data.appsScriptTokenDesc')}
            type="password"
            autoComplete="off"
            placeholder={tokenSetting.sealed ? `••••${tokenSetting.lastFour}` : ''}
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            onBlur={() => void saveToken()}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Switch
              checked={syncEnabled}
              onChange={(next) => void setSyncEnabled(next)}
              label={t('settings.data.syncEnabled')}
              description={t('settings.data.syncEnabledDesc')}
            />
            <Switch
              checked={autoSync}
              onChange={(next) => void setAutoSync(next)}
              label={t('settings.data.autoSync')}
              description={t('settings.data.autoSyncDesc')}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t('settings.data.interval')}
              type="number"
              min={1}
              max={1440}
              value={String(interval)}
              onChange={(event) => void setIntervalMinutes(Number(event.target.value))}
            />
            <Select
              label={t('settings.data.conflict')}
              value={conflictPolicy}
              onChange={(event) => void setConflictPolicy(event.target.value)}
              options={[
                { value: 'local', label: t('settings.data.conflictLocal') },
                { value: 'remote', label: t('settings.data.conflictRemote') },
                { value: 'newest', label: t('settings.data.conflictNewest') },
              ]}
            />
          </div>
        </div>
      </Card>

      <Card title={t('settings.data.backup')}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">{t('settings.data.exportDesc')}</p>
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() => void exportBackup()}
            >
              {t('settings.data.exportBackup')}
            </Button>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-48 flex-1">
              <Select
                label={t('settings.data.importMode')}
                value={importMode}
                onChange={(event) => setImportMode(event.target.value as 'replace' | 'merge')}
                options={[
                  { value: 'replace', label: t('settings.data.modeReplace') },
                  { value: 'merge', label: t('settings.data.modeMerge') },
                ]}
                hint={t('settings.data.importDesc')}
              />
            </div>
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-label={t('settings.data.importBackup')}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void importBackup(file)
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() => fileRef.current?.click()}
              >
                {t('settings.data.importBackup')}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card title={t('settings.data.danger')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-xs leading-relaxed text-muted">
            {t('settings.data.deleteAllBody')}
          </p>
          <Button variant="danger" size="sm" onClick={() => setConfirmDeleteAll(true)}>
            {t('settings.data.deleteAllTitle')}
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDeleteAll}
        title={t('settings.data.deleteAllTitle')}
        body={t('settings.data.deleteAllBody')}
        confirmLabel={t('settings.data.deleteAllConfirm')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        loading={busy}
        onConfirm={() => void deleteEverything()}
        onCancel={() => setConfirmDeleteAll(false)}
      />
    </div>
  )
}
