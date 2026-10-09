import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Badge,
  Button,
  Card,
  IconButton,
  Input,
  Select,
  Switch,
  type BadgeTone,
} from '@/components/ui'
import {
  IconAlert,
  IconExternal,
  IconKey,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@/components/layout/icons'
import { PROVIDERS, defaultModelFor, type ProviderId } from '@/config/models.config'
import { logEvent } from '@/core/eventLogger'
import { isVaultUnlocked, unlockVault, vaultPassphrase } from '@/core/vault'
import { apiKeyRepo, type ApiKeySummary } from '@/db/repo-apiKeys'
import { downloadKeyBundle, importKeyBundleFromFile } from '@/db/keyBundle'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { useImportedModelsStore } from '@/stores/importedModelsStore'
import { getAdapter } from '@/providers'
import {
  buildModelOptions,
  discoverModels,
  loadCachedDiscovery,
  saveDiscovery,
  type DiscoveryResult,
  type ModelOption,
} from '@/providers/discovery'
import type { TestKeyResult } from '@/providers/types'
import { toast } from '@/stores/toastStore'

const providerModelKey = (provider: ProviderId): string => `ai.model.${provider}`
const providerBaseUrlKey = (provider: ProviderId): string => `ai.baseUrl.${provider}`

type BusyKind = 'refresh' | 'sample' | null

interface TestState {
  kind: string
  latencyMs: number
  detail: string
}

/* ------------------------------------------------------------------ */
/* Vault                                                               */
/* ------------------------------------------------------------------ */

function VaultCard() {
  const { t } = useTranslation()
  const [passphrase, setPassphrase] = useState('')
  const [active, setActive] = useState(isVaultUnlocked())

  function apply() {
    const hasPassphrase = passphrase.trim().length > 0
    unlockVault(hasPassphrase ? passphrase : null)
    setPassphrase('')
    setActive(isVaultUnlocked())
    toast(
      'success',
      hasPassphrase ? t('settings.providers.vaultActive') : t('settings.providers.vaultDevice'),
    )
  }

  function forget() {
    unlockVault(null)
    setActive(false)
    toast('info', t('settings.providers.vaultDevice'))
  }

  return (
    <Card
      title={t('settings.providers.vault')}
      description={t('settings.providers.vaultDesc')}
      actions={
        active ? (
          <Button size="sm" variant="secondary" onClick={forget}>
            {t('settings.providers.vaultLock')}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap items-end gap-2" data-testid="vault-form">
        <Input
          type="password"
          autoComplete="off"
          className="max-w-xs flex-1"
          label={t('settings.providers.passphrase')}
          placeholder={t('settings.providers.vaultPlaceholder')}
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          data-testid="vault-passphrase"
        />
        <Button
          size="sm"
          onClick={apply}
          disabled={passphrase.trim().length === 0 && !active}
          data-testid="vault-apply"
        >
          {t('settings.providers.vaultUnlock')}
        </Button>
        <Badge tone={active ? 'success' : 'neutral'}>
          {active ? t('settings.providers.vaultActive') : t('settings.providers.vaultDevice')}
        </Badge>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* One key row                                                         */
/* ------------------------------------------------------------------ */

interface KeyRowProps {
  summary: ApiKeySummary
  provider: ProviderId
  baseUrl?: string
  onChanged: () => void
}

function KeyRow({ summary, provider, baseUrl, onChanged }: KeyRowProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<TestState | null>(null)
  const [nickname, setNickname] = useState(summary.label)

  const statusKey =
    summary.enabled === false
      ? 'disabled'
      : summary.status === 'valid'
        ? 'healthy'
        : summary.status === 'cooling'
          ? 'cooling'
          : summary.status === 'invalid'
            ? 'invalid'
            : summary.status === 'quota'
              ? 'quota'
              : 'unknown'

  const statusTone: BadgeTone =
    statusKey === 'healthy'
      ? 'success'
      : statusKey === 'cooling' || statusKey === 'quota'
        ? 'warning'
        : statusKey === 'invalid'
          ? 'danger'
          : 'neutral'

  async function runTest() {
    setBusy(true)
    setTest(null)
    try {
      const secret = await apiKeyRepo.reveal(summary.id)
      const result: TestKeyResult = await getAdapter(provider).testKey(secret, {
        baseUrl: baseUrl || undefined,
      })
      setTest({ kind: result.kind, latencyMs: result.latencyMs, detail: result.detail })
      // Only a definitive verdict changes the status: a network hiccup must not
      // condemn a perfectly good key.
      if (result.ok) await apiKeyRepo.setStatus(summary.id, 'valid', result.detail)
      else if (result.kind === 'quota')
        await apiKeyRepo.setStatus(summary.id, 'quota', result.detail)
      else if (result.kind === 'invalid' || result.kind === 'unsupported')
        await apiKeyRepo.setStatus(summary.id, 'invalid', result.detail)

      logEvent({
        state: 'SETTINGS',
        action: 'provider.testKey',
        severity: result.ok ? 'success' : 'warning',
        messageMy: `${provider} သော့ စမ်းသပ်မှု ${result.ok ? 'အောင်မြင်သည်' : 'မအောင်မြင်ပါ'}`,
        messageEn: `Key test for ${provider}: ${result.ok ? 'ok' : result.kind} in ${result.latencyMs} ms`,
        technicalDetail: result.detail,
      })
      onChanged()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTest({ kind: 'network', latencyMs: 0, detail: message })
      toast('danger', t('settings.providers.testFailed', { detail: message }))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    await apiKeyRepo.remove(summary.id)
    onChanged()
    toast('success', t('settings.providers.removed'))
  }

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-raised/40 px-3 py-2.5"
      data-testid={`key-${summary.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs tabular-nums text-text" data-testid="key-masked">
          ••••••••{summary.lastFour}
        </span>
        <Badge tone={statusTone}>{t(`settings.providers.status.${statusKey}`)}</Badge>
        {summary.cooldownUntil > Date.now() ? (
          <span className="text-[11px] tabular-nums text-warning" data-testid="key-cooldown">
            {t('settings.providers.cooldownUntil', {
              time: new Date(summary.cooldownUntil).toLocaleTimeString(),
            })}
          </span>
        ) : null}
        <span className="ms-auto flex items-center gap-3">
          <span className="inline-flex" data-testid="key-enabled">
            <Switch
              checked={summary.enabled}
              label={t('settings.providers.enableKey')}
              hideLabel
              onChange={(next) => {
                void apiKeyRepo.setEnabled(summary.id, next).then(onChanged)
              }}
            />
          </span>
          <IconButton
            label={t('common.delete')}
            variant="danger"
            size="sm"
            icon={<IconTrash className="h-4 w-4" />}
            onClick={() => void remove()}
            data-testid="key-remove"
          />
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Input
          className="max-w-[16rem] flex-1"
          label={t('settings.providers.nickname')}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          onBlur={() => void apiKeyRepo.setLabel(summary.id, nickname).then(onChanged)}
          data-testid="key-nickname"
        />
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          onClick={() => void runTest()}
          data-testid="key-test"
        >
          {t('settings.providers.testKey')}
        </Button>
        {test ? (
          <span
            className="pb-2 text-[11px] tabular-nums text-muted"
            data-testid="key-test-result"
            title={test.detail}
          >
            {t('settings.providers.testResult', { kind: test.kind, latency: test.latencyMs })}
          </span>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        {t('settings.providers.usageCounts', {
          requests: summary.requests,
          tokensIn: summary.tokensIn,
          tokensOut: summary.tokensOut,
        })}
      </p>
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* One provider card                                                   */
/* ------------------------------------------------------------------ */

interface ProviderCardProps {
  providerId: ProviderId
  keys: ApiKeySummary[]
  isActive: boolean
  onChanged: () => void
}

function ProviderCard({ providerId, keys, isActive, onChanged }: ProviderCardProps) {
  const { t } = useTranslation()
  const meta = PROVIDERS.find((entry) => entry.id === providerId)
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState<BusyKind>(null)
  const [draftSecret, setDraftSecret] = useState('')
  const [draftNickname, setDraftNickname] = useState('')
  const [sample, setSample] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [cached, storedModel, storedBase] = await Promise.all([
        loadCachedDiscovery(providerId),
        settingsRepo.get<string>(providerModelKey(providerId), ''),
        settingsRepo.get<string>(providerBaseUrlKey(providerId), ''),
      ])
      if (cancelled) return
      setDiscovery(cached)
      setBaseUrl(storedBase)
      setModel(storedModel || defaultModelFor(providerId))
    })()
    return () => {
      cancelled = true
    }
  }, [providerId])

  const options: ModelOption[] = useMemo(
    () => buildModelOptions(providerId, discovery),
    [providerId, discovery],
  )
  const selected = options.find((option) => option.id === model) ?? options[0]
  const usableKey = keys.find((key) => key.enabled !== false && key.status !== 'invalid')

  async function refreshModels() {
    setBusy('refresh')
    try {
      const secret = usableKey ? await apiKeyRepo.reveal(usableKey.id) : null
      const result = await discoverModels(providerId, secret, { baseUrl: baseUrl || undefined })
      await saveDiscovery(result)
      setDiscovery(result)
      onChanged()
      toast(
        result.source === 'live' ? 'success' : 'info',
        result.source === 'live'
          ? t('settings.providers.modelsLive', { count: result.models.length })
          : t('settings.providers.modelsFallback'),
      )
    } finally {
      setBusy(null)
    }
  }

  async function saveModel(value: string) {
    setModel(value)
    await settingsRepo.set(providerModelKey(providerId), value, 'ai')
    // Keep the active pair in step so pre-flight and the translate page see it.
    const active = await settingsRepo.get<string>(SETTING_KEYS.provider, 'gemini')
    if (active === providerId) await settingsRepo.set(SETTING_KEYS.model, value, 'ai')
  }

  async function activate() {
    const chosen = model || defaultModelFor(providerId)
    setModel(chosen)
    await settingsRepo.set(SETTING_KEYS.provider, providerId, 'ai')
    await settingsRepo.set(SETTING_KEYS.model, chosen, 'ai')
    onChanged()
    toast('success', t('settings.providers.activated', { provider: meta?.label ?? providerId }))
  }

  async function addKey() {
    const secret = draftSecret.trim()
    if (secret.length < 8) {
      toast('danger', t('settings.providers.keyTooShort'))
      return
    }
    try {
      await apiKeyRepo.create({
        provider: providerId,
        label: draftNickname.trim() || meta?.label || providerId,
        secret,
        passphrase: vaultPassphrase(),
      })
      setDraftSecret('')
      setDraftNickname('')
      onChanged()
      toast('success', t('settings.providers.added'))
      logEvent({
        state: 'SETTINGS',
        action: 'provider.addKey',
        severity: 'success',
        messageMy: `${meta?.label ?? providerId} သော့ ထည့်ပြီး`,
        messageEn: `Added an API key for ${meta?.label ?? providerId}`,
      })
    } catch (error) {
      toast('danger', error instanceof Error ? error.message : String(error))
    }
  }

  async function testSample() {
    if (!usableKey || !selected) return
    setBusy('sample')
    setSample(null)
    try {
      const secret = await apiKeyRepo.reveal(usableKey.id)
      const result = await getAdapter(providerId).translate(
        secret,
        {
          model: selected.id,
          system:
            'You translate one line of a document. Return only JSON {"t":"<translation>"} using standard written Burmese Unicode, never Zawgyi.',
          user: 'Translate: The maintenance window starts at 09:00 on Monday.',
          temperature: 0.1,
          maxOutputTokens: 200,
        },
        { baseUrl: baseUrl || undefined },
      )
      const match = /"t"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(result.text)
      setSample(match ? match[1] : result.text.slice(0, 200))
    } catch (error) {
      toast(
        'danger',
        t('settings.providers.sampleFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card
      title={meta?.label ?? providerId}
      description={t(`settings.providers.freeTierNote.${providerId}`)}
      actions={
        isActive ? (
          <Badge tone="success">{t('settings.providers.activeProvider')}</Badge>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void activate()}
            data-testid={`use-provider-${providerId}`}
          >
            {t('settings.providers.useProvider')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3" data-testid={`provider-${providerId}`}>
        <div className="flex flex-wrap gap-2">
          <a href={meta?.getKeyUrl} target="_blank" rel="noreferrer noopener">
            <Button size="sm" variant="ghost" iconLeft={<IconExternal className="h-4 w-4" />}>
              {t('settings.providers.getKey')}
            </Button>
          </a>
          <a href={meta?.docsUrl} target="_blank" rel="noreferrer noopener">
            <Button size="sm" variant="ghost">
              {t('settings.providers.docs')}
            </Button>
          </a>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Select
            label={t('settings.providers.model')}
            value={model}
            options={options.map((option) => ({
              value: option.id,
              label: option.free
                ? `${option.label} · ${t('settings.providers.freeBadge')}`
                : option.label,
              disabled: option.available === 'no',
            }))}
            onChange={(event) => void saveModel(event.target.value)}
            data-testid={`model-${providerId}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<IconRefresh className="h-4 w-4" />}
              loading={busy === 'refresh'}
              onClick={() => void refreshModels()}
              disabled={busy !== null && busy !== 'refresh'}
              data-testid={`refresh-models-${providerId}`}
            >
              {t('settings.providers.refreshModels')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'sample'}
              onClick={() => void testSample()}
              disabled={(busy !== null && busy !== 'sample') || !usableKey}
              data-testid={`sample-test-${providerId}`}
            >
              {t('settings.providers.sampleTest')}
            </Button>
          </div>
        </div>

        {selected ? (
          <div
            className="flex flex-wrap items-center gap-2 text-[11px] text-muted"
            data-testid="model-badges"
          >
            <span className="font-medium text-text">{selected.label}</span>
            {selected.free ? (
              <Badge tone="success">{t('settings.providers.freeBadge')}</Badge>
            ) : null}
            {selected.contextWindow ? (
              <Badge tone="neutral">
                {t('settings.providers.contextBadge', { value: selected.contextWindow })}
              </Badge>
            ) : null}
            {selected.recommendedForPdf ? (
              <Badge tone="info">{t('settings.providers.pdfBadge')}</Badge>
            ) : null}
            {selected.verifyAvailability ? (
              <Badge tone="warning">{t('settings.providers.verifyBadge')}</Badge>
            ) : null}
            <Badge tone={discovery?.source === 'live' ? 'success' : 'neutral'}>
              {discovery?.source === 'live'
                ? t('settings.providers.modelsLive', { count: discovery.models.length })
                : t('settings.providers.modelsFallback')}
            </Badge>
          </div>
        ) : null}

        {sample ? (
          <p
            className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text"
            data-testid="sample-result"
          >
            {sample}
          </p>
        ) : null}

        {meta?.customBaseUrl ? (
          <Input
            label={t('settings.providers.baseUrl')}
            hint={t('settings.providers.baseUrlDesc')}
            value={baseUrl}
            placeholder={meta.baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={() => void settingsRepo.set(providerBaseUrlKey(providerId), baseUrl, 'ai')}
            data-testid={`base-url-${providerId}`}
          />
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-xs font-medium text-text">
            {t('settings.providers.keysTitle')}
            <Badge tone="neutral">{keys.length}</Badge>
          </p>

          {keys.length === 0 ? (
            <p className="text-xs text-muted" data-testid="no-keys">
              {t('settings.providers.emptyProvider')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {keys.map((key) => (
                <KeyRow
                  key={key.id}
                  summary={key}
                  provider={providerId}
                  baseUrl={baseUrl || undefined}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <Input
              type="password"
              autoComplete="off"
              className="min-w-[14rem] flex-1"
              label={t('settings.providers.secretPlaceholder')}
              value={draftSecret}
              onChange={(event) => setDraftSecret(event.target.value)}
              data-testid={`new-secret-${providerId}`}
            />
            <Input
              className="max-w-[12rem] flex-1"
              label={t('settings.providers.nicknamePlaceholder')}
              value={draftNickname}
              onChange={(event) => setDraftNickname(event.target.value)}
              data-testid={`new-nickname-${providerId}`}
            />
            <Button
              size="sm"
              iconLeft={<IconPlus className="h-4 w-4" />}
              onClick={() => void addKey()}
              data-testid={`add-key-${providerId}`}
            >
              {t('settings.providers.addKey')}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Key / provider transfer                                             */
/* ------------------------------------------------------------------ */

/**
 * Moves a whole provider setup to another machine in one file.
 *
 * The full database backup deliberately cannot: its ciphers are sealed under a
 * device-bound key, so a restored key is undecryptable anywhere else. This
 * file travels in the clear and is re-sealed on arrival — which is why the
 * card says so out loud rather than quietly handing over credentials.
 */
function KeyTransferCard({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function handleExport() {
    setBusy(true)
    try {
      const { file, bundle, undecryptable } = await downloadKeyBundle()
      // Counts and a filename only — the secrets live in the file, never here.
      logEvent({
        state: 'SETTINGS',
        action: 'provider.exportKeys',
        severity: 'success',
        messageMy: `သော့ ${bundle.keys.length} ခု ထုတ်ယူပြီး`,
        messageEn: `Exported ${bundle.keys.length} API keys`,
        technicalDetail: `${file} · ${bundle.keys.length} keys · ${Object.keys(bundle.providers).length} providers`,
      })
      toast(
        'success',
        t('settings.providers.keysExported', { count: bundle.keys.length, file }),
        undecryptable > 0
          ? t('settings.providers.keysLocked', { count: undecryptable })
          : undefined,
      )
    } catch (error) {
      toast('danger', t('toast.failed'), error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleImport(file: File) {
    setBusy(true)
    try {
      const report = await importKeyBundleFromFile(file)
      // The imported-model list is cached in a store — make it re-read.
      useImportedModelsStore.setState({ loaded: false })
      await useImportedModelsStore.getState().ensureLoaded()
      onChanged()
      logEvent({
        state: 'SETTINGS',
        action: 'provider.importKeys',
        severity: 'success',
        messageMy: `သော့ ${report.keysAdded} ခု ထည့်ပြီး`,
        messageEn: `Imported ${report.keysAdded} API keys`,
        technicalDetail: JSON.stringify(report),
      })
      toast(
        report.keysAdded === 0 ? 'info' : 'success',
        t('settings.providers.keysImported', {
          added: report.keysAdded,
          skipped: report.keysSkipped,
        }),
        report.activeProvider ?? file.name,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent({
        state: 'SETTINGS',
        action: 'provider.importKeys.failed',
        reasonCode: 'BACKUP_INVALID',
        severity: 'error',
        technicalDetail: message,
      })
      toast('danger', t('settings.providers.keysImportFailed'), message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Card
      title={t('settings.providers.transferTitle')}
      description={t('settings.providers.transferDesc')}
    >
      <div className="flex flex-col gap-3" data-testid="key-transfer">
        <p
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-xs leading-relaxed text-text"
          data-testid="key-transfer-warning"
        >
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>{t('settings.providers.transferWarn')}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() => void handleExport()}
            data-testid="keys-export"
          >
            {t('settings.providers.keysExport')}
          </Button>
          <input
            ref={fileRef}
            data-testid="keys-file"
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label={t('settings.providers.keysImport')}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleImport(file)
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() => fileRef.current?.click()}
            data-testid="keys-import"
          >
            {t('settings.providers.keysImport')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Tab                                                                 */
/* ------------------------------------------------------------------ */

export function ProvidersTab() {
  const { t } = useTranslation()
  const keys = useLiveQuery(() => apiKeyRepo.list(), [], [] as ApiKeySummary[])
  const [activeProvider, setActiveProvider] = useState<ProviderId>('gemini')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    void settingsRepo
      .get<string>(SETTING_KEYS.provider, 'gemini')
      .then((value) =>
        setActiveProvider(
          (PROVIDERS.find((entry) => entry.id === value)?.id ?? 'gemini') as ProviderId,
        ),
      )
  }, [reloadToken])

  const onChanged = useCallback(() => setReloadToken((value) => value + 1), [])

  const grouped = useMemo(() => {
    const map = new Map<ProviderId, ApiKeySummary[]>()
    for (const provider of PROVIDERS) map.set(provider.id, [])
    for (const key of keys ?? []) {
      const list = map.get(key.provider as ProviderId)
      if (list) list.push(key)
    }
    return map
  }, [keys])

  return (
    <div className="flex flex-col gap-4" data-testid="providers-tab">
      <VaultCard />
      <KeyTransferCard onChanged={onChanged} />
      <Card title={t('settings.providers.title')} description={t('settings.providers.subtitle')}>
        <div className="flex items-start gap-3 rounded-md border border-dashed border-border bg-raised/40 px-3 py-3">
          <span aria-hidden="true" className="mt-0.5 text-faint">
            <IconKey className="h-4 w-4" />
          </span>
          <p className="text-xs leading-relaxed text-muted">
            {t('settings.providers.keyStorageDesc')}
          </p>
        </div>
      </Card>
      {PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider.id}
          providerId={provider.id}
          keys={grouped.get(provider.id) ?? []}
          isActive={provider.id === activeProvider}
          onChanged={onChanged}
        />
      ))}
    </div>
  )
}
