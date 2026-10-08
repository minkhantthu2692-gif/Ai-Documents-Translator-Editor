import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, ConfirmDialog, Select } from '@/components/ui'
import { settingsRepo } from '@/db/repo-settings'
import { downloadBackup, restoreBackupFromFile } from '@/db/backup'
import { deleteDatabase } from '@/db/db'
import { destroyDeviceSecret } from '@/core/crypto'
import { logEvent } from '@/core/eventLogger'
import { toast } from '@/stores/toastStore'
import { useUiStore } from '@/stores/uiStore'
import { SyncCard } from './SyncCard'

/**
 * Data tab: cloud sync (delegated to `SyncCard`), local backup export/import
 * and the danger zone. The backup file input is the only `<input type=file>`
 * on this page — the smoke test drives it directly.
 */
export function DataTab() {
  const { t } = useTranslation()

  const fileRef = useRef<HTMLInputElement>(null)
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('replace')
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [busy, setBusy] = useState(false)

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
      <SyncCard />

      <Card title={t('settings.data.backup')}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">{t('settings.data.exportDesc')}</p>
            <Button
              data-testid="backup-export"
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
                data-testid="backup-file"
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
                data-testid="backup-import"
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
          <Button
            data-testid="delete-local"
            variant="danger"
            size="sm"
            onClick={() => setConfirmDeleteAll(true)}
          >
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
