import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Button, Card, ConfirmDialog, Input, Select, Switch } from '@/components/ui'
import { IconRefresh } from '@/components/layout/icons'
import { SETTING_KEYS } from '@/db/repo-settings'
import { outboxRepo } from '@/db/repo-outbox'
import type { SyncToggle } from '@/db/types'
import { sealText, type SealedPayload } from '@/core/crypto'
import { logEvent } from '@/core/eventLogger'
import { cn } from '@/lib/cn'
import { errorMemory } from '@/assistant'
import { toast } from '@/stores/toastStore'
import {
  defaultEntityToggles,
  toSyncErrorCode,
  useSyncStore,
  type EntityToggles,
  type SyncUiStatus,
} from '@/sync'
import { useSetting } from './useSetting'

interface TokenSetting {
  sealed: SealedPayload | null
  lastFour: string
}

const EMPTY_TOKEN: TokenSetting = { sealed: null, lastFour: '' }

/** Stable fallback — `useSetting` puts this in useLiveQuery deps. */
const ENTITY_FALLBACK = defaultEntityToggles()

/**
 * The switches that map one-to-one onto wire entities. Provider settings and
 * API keys sit outside this list: the first is a *filter* over the settings
 * sheet rather than an entity, and the second is kept apart because turning it
 * on writes secrets in the clear.
 */
const ENTITY_ROWS: { entity: SyncToggle; testId: string; labelKey: string }[] = [
  { entity: 'projects', testId: 'sync-toggle-projects', labelKey: 'settings.data.entityProjects' },
  { entity: 'pages', testId: 'sync-toggle-pages', labelKey: 'settings.data.entityPages' },
  { entity: 'blocks', testId: 'sync-toggle-blocks', labelKey: 'settings.data.entityBlocks' },
  { entity: 'glossary', testId: 'sync-toggle-glossary', labelKey: 'settings.data.entityGlossary' },
  {
    entity: 'providerSettings',
    testId: 'sync-toggle-providerSettings',
    labelKey: 'settings.data.entityProviderSettings',
  },
  { entity: 'settings', testId: 'sync-toggle-settings', labelKey: 'settings.data.entitySettings' },
  {
    entity: 'usageStats',
    testId: 'sync-toggle-usage',
    labelKey: 'settings.data.entityUsage',
  },
]

const STATUS_DOTS: Record<SyncUiStatus, string> = {
  disabled: 'bg-fg-subtle',
  idle: 'bg-success',
  syncing: 'bg-info animate-pulse',
  error: 'bg-danger',
  offline: 'bg-warning',
}

/**
 * Cloud sync card (extracted from DataTab in Phase 5).
 *
 * Everything that talks to the Apps Script backend lives here: URL + sealed
 * token, enable/auto-sync switches, interval, conflict policy, per-entity
 * toggles, the Sync Now / Test connection / Delete cloud data buttons and the
 * live status line (`sync-status[data-state=…]`). IndexedDB remains the
 * source of truth — the sheet is only a relay between devices.
 */
export function SyncCard() {
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
  const [entities, setEntities] = useSetting<EntityToggles>(
    SETTING_KEYS.syncEntities,
    ENTITY_FALLBACK,
  )

  const pendingSync = useLiveQuery(() => outboxRepo.pendingCount(), [])

  const status = useSyncStore((state) => state.status)
  const running = useSyncStore((state) => state.running)
  const lastStats = useSyncStore((state) => state.lastStats)
  const lastError = useSyncStore((state) => state.lastError)
  const refresh = useSyncStore((state) => state.refresh)
  const run = useSyncStore((state) => state.run)
  const testConnection = useSyncStore((state) => state.testConnection)
  const wipeCloud = useSyncStore((state) => state.wipeCloud)

  const [tokenDraft, setTokenDraft] = useState('')
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [busy, setBusy] = useState<'test' | 'wipe' | null>(null)
  /**
   * Entities the backend declared support for after the last successful test —
   * `null` when this device has never probed it. Drives the "your Code.gs is
   * too old" notice: without it a key push would fail the *entire* batch on an
   * older deployment.
   */
  const [serverEntities, setServerEntities] = useState<string[] | null>(null)

  // Pull the config (and env fallbacks) into the store on first render.
  useEffect(() => {
    void refresh()
  }, [refresh])

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

  async function onSyncNow() {
    const outcome = await run('manual')
    if (outcome.ok) {
      const stats = outcome.stats
      toast(
        'success',
        t('settings.data.syncDone'),
        t('settings.data.statsLine', {
          pushed: stats.pushed,
          pulled: stats.appliedRemote,
          conflicts: stats.conflicts,
        }),
      )
      if (stats.hasMore) toast('info', t('settings.data.syncMore'))
    } else {
      errorMemory.remember(outcome.code, outcome.message)
      toast('danger', `${t('settings.data.syncFailed')} · ${outcome.code}`, outcome.message)
    }
  }

  async function onTest() {
    setBusy('test')
    try {
      const result = await testConnection()
      setServerEntities(result.entities)
      toast(
        'success',
        t('settings.data.testOk', {
          ms: result.latencyMs,
          sheets: result.sheetNames.length,
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errorMemory.remember(toSyncErrorCode(error), message)
      toast('danger', t('settings.data.testFailed'), message)
    } finally {
      setBusy(null)
    }
  }

  async function onWipe() {
    setBusy('wipe')
    try {
      const cleared = await wipeCloud()
      toast('success', t('settings.data.wiped', { count: cleared }))
      logEvent({
        state: 'SETTINGS',
        action: 'sync.wipe',
        severity: 'warning',
        messageMy: `Cloud ဒေတာ ဖျက်ပြီး (${cleared})`,
        messageEn: `Cloud data wiped (${cleared})`,
        technicalDetail: `cleared=${cleared}`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errorMemory.remember(toSyncErrorCode(error), message)
      toast('danger', t('settings.data.wipeFailed'), message)
    } finally {
      setBusy(null)
      setConfirmWipe(false)
    }
  }

  function toggleEntity(entity: SyncToggle, next: boolean) {
    void setEntities({ ...entities, [entity]: next })
  }

  const keysOn = entities.apiKeys ?? ENTITY_FALLBACK.apiKeys

  /**
   * Key rows only travel once the backend declares an ApiKeys sheet. Until a
   * probe says otherwise they stay queued — an older Code.gs would reject the
   * whole batch during validation, before a single row is written.
   */
  const keysBackendNote = !keysOn
    ? null
    : serverEntities === null
      ? { testId: 'keys-held', tone: 'text-muted', message: t('settings.data.keysHeld') }
      : serverEntities.includes('apiKeys')
        ? null
        : {
            testId: 'keys-old-backend',
            tone: 'text-danger',
            message: t('settings.data.oldBackend'),
          }

  const statusLabel: Record<SyncUiStatus, string> = {
    disabled: t('settings.data.statusDisabled'),
    idle: t('settings.data.statusIdle'),
    syncing: t('settings.data.statusSyncing'),
    error: t('settings.data.statusError'),
    offline: t('settings.data.statusOffline'),
  }

  return (
    <>
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
          {/* Live status line ------------------------------------------------ */}
          <div
            data-testid="sync-status"
            data-state={status}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2"
            aria-live="polite"
          >
            <span className="inline-flex items-center gap-2 text-sm font-medium text-fg">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOTS[status]}`} aria-hidden="true" />
              {statusLabel[status]}
            </span>
            <span className="text-xs text-fg-muted">
              {lastStats
                ? t('settings.data.statsLine', {
                    pushed: lastStats.pushed,
                    pulled: lastStats.appliedRemote,
                    conflicts: lastStats.conflicts,
                  })
                : t('settings.data.noRuns')}
            </span>
          </div>

          {lastError ? (
            <p data-testid="sync-error" className="text-xs text-danger">
              {lastError.code}: {lastError.message}
            </p>
          ) : null}

          {/* Configuration ---------------------------------------------------- */}
          <Input
            data-testid="sync-url"
            label={t('settings.data.appsScriptUrl')}
            hint={t('settings.data.appsScriptUrlDesc')}
            type="url"
            inputMode="url"
            placeholder="https://script.google.com/macros/s/…/exec"
            value={appsScriptUrl}
            onChange={(event) => void setAppsScriptUrl(event.target.value)}
          />

          <Input
            data-testid="sync-token"
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
              testId="sync-enabled"
              checked={syncEnabled}
              onChange={(next) => void setSyncEnabled(next)}
              label={t('settings.data.syncEnabled')}
              description={t('settings.data.syncEnabledDesc')}
            />
            <Switch
              testId="sync-autosync"
              checked={autoSync}
              onChange={(next) => void setAutoSync(next)}
              label={t('settings.data.autoSync')}
              description={t('settings.data.autoSyncDesc')}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              data-testid="sync-interval"
              label={t('settings.data.interval')}
              type="number"
              min={1}
              max={1440}
              value={String(interval)}
              onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            />
            <Select
              data-testid="sync-policy"
              label={t('settings.data.conflict')}
              value={conflictPolicy}
              onChange={(event) => setConflictPolicy(event.target.value)}
              options={[
                { value: 'local', label: t('settings.data.conflictLocal') },
                { value: 'remote', label: t('settings.data.conflictRemote') },
                { value: 'newest', label: t('settings.data.conflictNewest') },
              ]}
            />
          </div>

          {/* Selective per-entity toggles ------------------------------------ */}
          <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {t('settings.data.entities')}
            </legend>
            <div className="flex flex-col gap-1">
              <p className="text-xs text-fg-muted">{t('settings.data.entitiesDesc')}</p>
              <p className="text-xs text-fg-muted">{t('settings.data.entityProviderDesc')}</p>
              <p className="text-xs text-fg-muted">{t('settings.data.entitySettingsDesc')}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {ENTITY_ROWS.map((row) => (
                <Switch
                  key={row.entity}
                  testId={row.testId}
                  checked={entities[row.entity] ?? ENTITY_FALLBACK[row.entity]}
                  onChange={(next) => toggleEntity(row.entity, next)}
                  label={t(row.labelKey)}
                />
              ))}
            </div>

            {/* API keys — a separate, off-by-default opt-in, because turning it
                on writes every key to the sheet in readable text. */}
            <div
              className={cn(
                'rounded-md border p-3 transition-colors',
                keysOn ? 'border-warning/60 bg-warning/10' : 'border-border',
              )}
            >
              <Switch
                testId="sync-toggle-apiKeys"
                checked={keysOn}
                onChange={(next) => toggleEntity('apiKeys', next)}
                label={t('settings.data.entityKeys')}
                description={t('settings.data.entityKeysDesc')}
              />
              {keysOn ? (
                <div data-testid="keys-sync-warning" className="mt-2 flex flex-col gap-1">
                  <p className="text-xs font-semibold text-warning">
                    {t('settings.data.keysWarningTitle')}
                  </p>
                  <p className="text-xs text-fg-muted">{t('settings.data.keysWarning')}</p>
                </div>
              ) : null}
              {keysBackendNote ? (
                <p
                  data-testid={keysBackendNote.testId}
                  className={`mt-2 text-xs ${keysBackendNote.tone}`}
                >
                  {keysBackendNote.message}
                </p>
              ) : null}
            </div>
          </fieldset>

          {/* Actions ---------------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              data-testid="sync-now"
              loading={running}
              onClick={() => void onSyncNow()}
              iconLeft={<IconRefresh className="h-4 w-4" />}
            >
              {t('settings.data.syncNow')}
            </Button>
            <Button
              data-testid="test-connection"
              variant="secondary"
              loading={busy === 'test'}
              onClick={() => void onTest()}
            >
              {t('settings.data.testConnection')}
            </Button>
            <Button
              data-testid="wipe-cloud"
              variant="danger"
              size="sm"
              onClick={() => setConfirmWipe(true)}
            >
              {t('settings.data.wipeCloud')}
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmWipe}
        title={t('settings.data.wipeCloudTitle')}
        body={t('settings.data.wipeCloudBody')}
        confirmLabel={t('settings.data.wipeCloudConfirm')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        loading={busy === 'wipe'}
        onConfirm={() => void onWipe()}
        onCancel={() => setConfirmWipe(false)}
      />
    </>
  )
}
