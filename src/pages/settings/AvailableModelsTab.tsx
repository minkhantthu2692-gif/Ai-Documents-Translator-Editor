/**
 * Settings → Available Models.
 *
 * Two lists, deliberately separated:
 *
 *  1. **Default & imported** — what every model dropdown in the app offers:
 *     the bundled registry plus ids imported from list (2) (removable).
 *  2. **Currently available** — fetched live from each provider's `/models`
 *     endpoint with that provider's configured key (results cached 24h, the
 *     same cache the AI Providers card reads); every row is importable.
 *
 * All four providers always render: a missing key, a rejected key, a locked
 * vault or an offline fetch degrades to its own hint instead of blanking the
 * tab. Capabilities (image/audio input, reasoning, tools) show only when the
 * endpoint reports them — absence means "not stated", not "unsupported".
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Input, Select, Skeleton, type BadgeTone } from '@/components/ui'
import { IconPlus, IconRefresh, IconSearch, IconTrash } from '@/components/layout/icons'
import { PROVIDERS, isBundledModel, modelsFor, type ProviderId } from '@/config/models.config'
import { logEvent } from '@/core/eventLogger'
import { apiKeyRepo } from '@/db/repo-apiKeys'
import { settingsRepo } from '@/db/repo-settings'
import { discoverModels, loadCachedDiscovery, saveDiscovery } from '@/providers/discovery'
import type { DiscoveredModel } from '@/providers/types'
import { useImportedModelsStore } from '@/stores/importedModelsStore'
import { toast } from '@/stores/toastStore'

/** Same per-provider base URL key the AI Providers card writes. */
const providerBaseUrlKey = (provider: ProviderId): string => `ai.baseUrl.${provider}`

type FetchStatus = 'idle' | 'loading' | 'live' | 'cached' | 'no_key' | 'error'
type ErrorKind = 'no_key' | 'invalid_key' | 'network' | 'vault' | 'unknown'

interface ProviderState {
  status: FetchStatus
  errorKind: ErrorKind | null
  detail: string | null
  /** Live or cached list (models that can generate content only). */
  models: DiscoveredModel[]
  checkedAt: number | null
}

const IDLE: ProviderState = {
  status: 'idle',
  errorKind: null,
  detail: null,
  models: [],
  checkedAt: null,
}

function idleStates(): Record<ProviderId, ProviderState> {
  return { gemini: IDLE, openrouter: IDLE, groq: IDLE, openai: IDLE }
}

/** Maps an adapter/discovery error onto the hint the tab can act on. */
function classifyError(error: string | null): ErrorKind {
  if (error === 'NO_KEY') return 'no_key'
  if (!error) return 'unknown'
  if (/\b(?:401|403)\b|unauthorized|forbidden|api[ _-]?key|permission/i.test(error)) {
    return 'invalid_key'
  }
  if (/network|failed to fetch|load failed|timed?[- ]?out|offline|aborted|cors/i.test(error)) {
    return 'network'
  }
  return 'unknown'
}

const statusTone: Record<FetchStatus, BadgeTone> = {
  idle: 'neutral',
  loading: 'primary',
  live: 'success',
  cached: 'neutral',
  no_key: 'warning',
  error: 'danger',
}

function StatusBadge({ status }: { status: FetchStatus }) {
  const { t } = useTranslation()
  switch (status) {
    case 'loading':
      return <Badge tone={statusTone.loading}>{t('settings.models.fetchingBadge')}</Badge>
    case 'live':
      return <Badge tone={statusTone.live}>{t('settings.models.liveBadge')}</Badge>
    case 'cached':
      return <Badge tone={statusTone.cached}>{t('settings.models.cachedBadge')}</Badge>
    case 'no_key':
      return <Badge tone={statusTone.no_key}>{t('settings.models.noKeyBadge')}</Badge>
    case 'error':
      return <Badge tone={statusTone.error}>{t('settings.models.errorBadge')}</Badge>
    default:
      return <Badge tone={statusTone.idle}>{t('settings.models.idleBadge')}</Badge>
  }
}

function ErrorHint({ kind, detail }: { kind: ErrorKind; detail: string | null }) {
  const { t } = useTranslation()
  switch (kind) {
    case 'no_key':
      return <>{t('settings.models.noKey')}</>
    case 'invalid_key':
      return <>{t('settings.models.invalidKey')}</>
    case 'network':
      return <>{t('settings.models.networkError')}</>
    case 'vault':
      return <>{t('settings.models.vaultLocked')}</>
    default:
      return <>{t('settings.models.unknownError', { detail: (detail ?? '').slice(0, 200) })}</>
  }
}

/* ------------------------------------------------------------------ */
/* One model row (shared by both lists)                               */
/* ------------------------------------------------------------------ */

interface ListedModel {
  provider: ProviderId
  id: string
  label: string
  free: boolean
  contextWindow: number | null
  capabilities: string[] | null
}

interface ModelRowViewProps {
  row: ListedModel
  /** Badge next to the name (Bundled / Imported). */
  originBadge?: ReactNode
  /** Extra badges in the meta row (PDF-recommended, verify…). */
  metaBadges?: ReactNode
  action?: ReactNode
}

function ModelRowView({ row, originBadge, metaBadges, action }: ModelRowViewProps) {
  const { t } = useTranslation()
  const meta = PROVIDERS.find((entry) => entry.id === row.provider)
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-raised/40 px-3 py-2">
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text">{row.label}</span>
          <Badge tone="neutral">{meta?.label ?? row.provider}</Badge>
          {originBadge}
        </div>
        <p className="truncate font-mono text-[11px] text-muted" data-testid="model-row-id">
          {row.id}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="model-row-meta">
        <Badge tone={row.free ? 'success' : 'neutral'}>
          {row.free ? t('settings.providers.freeBadge') : t('settings.models.paidBadge')}
        </Badge>
        {row.contextWindow ? (
          <Badge tone="neutral">
            {t('settings.providers.contextBadge', { value: row.contextWindow })}
          </Badge>
        ) : null}
        {metaBadges}
        {row.capabilities?.map((capability) => (
          <span
            key={capability}
            className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted"
            data-testid="model-capability"
          >
            {capability}
          </span>
        ))}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* Tab                                                                */
/* ------------------------------------------------------------------ */

interface DefaultRow extends ListedModel {
  origin: 'bundled' | 'imported'
  recommended: boolean
  verify: boolean
}

interface AvailableRow extends ListedModel {
  bundled: boolean
  imported: boolean
}

export function AvailableModelsTab() {
  const { t } = useTranslation()
  const [, setSearchParams] = useSearchParams()
  const imported = useImportedModelsStore((state) => state.specs)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | ProviderId>('all')
  const [states, setStates] = useState<Record<ProviderId, ProviderState>>(idleStates)

  const importedKeys = useMemo(
    () => new Set(imported.map((spec) => `${spec.provider}/${spec.id}`)),
    [imported],
  )

  const matches = useCallback(
    (row: { provider: ProviderId; id: string; label: string }): boolean => {
      if (filter !== 'all' && row.provider !== filter) return false
      const needle = query.trim().toLowerCase()
      if (!needle) return true
      const meta = PROVIDERS.find((entry) => entry.id === row.provider)
      const haystack = `${row.label} ${row.id} ${meta?.label ?? row.provider}`
      return haystack.toLowerCase().includes(needle)
    },
    [filter, query],
  )

  /** One provider's refresh: key → live list, degrading to the last cache. */
  const refresh = useCallback(async (provider: ProviderId, signal?: AbortSignal): Promise<void> => {
    setStates((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], status: 'loading', errorKind: null, detail: null },
    }))
    try {
      const keys = await apiKeyRepo.list()
      const providerKeys = keys.filter((key) => key.provider === provider)
      const usable = providerKeys.find((key) => key.enabled !== false && key.status !== 'invalid')
      const cached = await loadCachedDiscovery(provider)
      const keepModels = cached?.models.filter((model) => model.usable) ?? []
      const keepCheckedAt = cached?.checkedAt ?? null

      if (!usable) {
        // A missing key and a key we already know is bad need different hints.
        const missing = providerKeys.length === 0
        setStates((prev) => ({
          ...prev,
          [provider]: {
            status: missing ? 'no_key' : 'error',
            errorKind: missing ? 'no_key' : 'invalid_key',
            detail: missing ? null : providerKeys[0].statusDetail || null,
            models: keepModels,
            checkedAt: keepCheckedAt,
          },
        }))
        return
      }

      let secret: string
      try {
        secret = await apiKeyRepo.reveal(usable.id)
      } catch {
        setStates((prev) => ({
          ...prev,
          [provider]: {
            status: 'error',
            errorKind: 'vault',
            detail: null,
            models: keepModels,
            checkedAt: keepCheckedAt,
          },
        }))
        return
      }

      const baseUrl = await settingsRepo.get<string>(providerBaseUrlKey(provider), '')
      const result = await discoverModels(provider, secret, {
        baseUrl: baseUrl || undefined,
        signal,
      })
      if (signal?.aborted) return
      if (result.source === 'live') {
        await saveDiscovery(result)
        setStates((prev) => ({
          ...prev,
          [provider]: {
            status: 'live',
            errorKind: null,
            detail: null,
            models: result.models.filter((model) => model.usable),
            checkedAt: result.checkedAt,
          },
        }))
        return
      }
      // Keep the last good list on screen while the error is shown.
      setStates((prev) => ({
        ...prev,
        [provider]: {
          status: 'error',
          errorKind: classifyError(result.error),
          detail: result.error,
          models: keepModels,
          checkedAt: keepCheckedAt,
        },
      }))
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      setStates((prev) => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          status: 'error',
          errorKind: classifyError(message),
          detail: message,
        },
      }))
    }
  }, [])

  // Mount: registered imports first, then the cached lists (instant paint),
  // then one live refresh per provider that has a usable key.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      await useImportedModelsStore.getState().ensureLoaded()
      if (cancelled) return
      const cached = await Promise.all(PROVIDERS.map((entry) => loadCachedDiscovery(entry.id)))
      if (cancelled) return
      setStates((prev) => {
        const next = { ...prev }
        PROVIDERS.forEach((entry, index) => {
          const hit = cached[index]
          if (hit && hit.source === 'live' && hit.models.length > 0) {
            next[entry.id] = {
              status: 'cached',
              errorKind: null,
              detail: null,
              models: hit.models.filter((model) => model.usable),
              checkedAt: hit.checkedAt,
            }
          }
        })
        return next
      })
      await Promise.all(PROVIDERS.map((entry) => refresh(entry.id, controller.signal)))
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [refresh])

  const goToProviders = useCallback(() => {
    setSearchParams({ tab: 'providers' }, { replace: true })
  }, [setSearchParams])

  const handleImport = async (row: AvailableRow): Promise<void> => {
    const added = await useImportedModelsStore.getState().importModel({
      provider: row.provider,
      id: row.id,
      label: row.label,
      contextWindow: row.contextWindow,
      free: row.free,
    })
    if (added) {
      toast('success', t('settings.models.importedToast', { id: row.label }))
      logEvent({
        state: 'SETTINGS',
        action: 'model.import',
        severity: 'success',
        messageMy: `မော်ဒယ် ${row.id} ကို မော်ဒယ် စာရင်းထဲ ထည့်ပြီး`,
        messageEn: `Imported model ${row.id} into the model list`,
        technicalDetail: `provider=${row.provider} model=${row.id}`,
      })
    } else {
      toast('info', t('settings.models.inList'))
    }
  }

  const handleRemove = async (row: DefaultRow): Promise<void> => {
    await useImportedModelsStore.getState().removeModel(row.provider, row.id)
    toast('info', t('settings.models.removedToast', { id: row.label }))
    logEvent({
      state: 'SETTINGS',
      action: 'model.remove',
      severity: 'info',
      messageMy: `မော်ဒယ် ${row.id} ကို မော်ဒယ် စာရင်းမှ ဖယ်ရှားပြီး`,
      messageEn: `Removed model ${row.id} from the model list`,
      technicalDetail: `provider=${row.provider} model=${row.id}`,
    })
  }

  const defaultGroups = useMemo(
    () =>
      PROVIDERS.map((entry) => ({
        provider: entry.id,
        rows: modelsFor(entry.id)
          .map<DefaultRow>((spec) => ({
            provider: entry.id,
            id: spec.id,
            label: spec.label,
            free: spec.free,
            contextWindow: spec.contextWindow > 0 ? spec.contextWindow : null,
            capabilities: null,
            origin: importedKeys.has(`${entry.id}/${spec.id}`) ? 'imported' : 'bundled',
            recommended: Boolean(spec.recommendedForPdf),
            verify: Boolean(spec.verifyAvailability),
          }))
          .filter((row) => matches(row)),
      })).filter((group) => group.rows.length > 0),
    [importedKeys, matches],
  )

  const availableGroups = useMemo(
    () =>
      PROVIDERS.filter((entry) => filter === 'all' || filter === entry.id).map((entry) => {
        const state = states[entry.id]
        return {
          provider: entry.id,
          state,
          rows: state.models
            .map<AvailableRow>((model) => ({
              provider: entry.id,
              id: model.id,
              label: model.label || model.id,
              free: model.free,
              contextWindow: model.contextWindow,
              capabilities: model.capabilities ?? null,
              bundled: isBundledModel(entry.id, model.id),
              imported: importedKeys.has(`${entry.id}/${model.id}`),
            }))
            .filter((row) => matches(row)),
        }
      }),
    [states, filter, importedKeys, matches],
  )

  const nothingVisible =
    defaultGroups.length === 0 && availableGroups.every((group) => group.rows.length === 0)

  return (
    <div className="flex flex-col gap-4" data-testid="available-models-tab">
      <Card title={t('settings.models.title')} description={t('settings.models.subtitle')}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <Input
              label={t('settings.models.search')}
              placeholder={t('settings.models.searchPlaceholder')}
              iconLeft={<IconSearch className="h-4 w-4" />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              data-testid="models-search"
            />
          </div>
          <div className="w-52">
            <Select
              label={t('settings.models.providerFilter')}
              value={filter}
              onChange={(event) => setFilter(event.target.value as 'all' | ProviderId)}
              options={[
                { value: 'all', label: t('settings.models.allProviders') },
                ...PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label })),
              ]}
              data-testid="models-filter"
            />
          </div>
        </div>
      </Card>

      {/* 1 — what the app's model dropdowns offer */}
      <Card
        title={t('settings.models.defaultTitle')}
        description={t('settings.models.defaultDesc')}
      >
        <div className="flex flex-col gap-4" data-testid="default-models">
          {defaultGroups.length === 0 ? (
            <p className="text-sm text-muted">{t('settings.models.noMatches')}</p>
          ) : (
            defaultGroups.map((group) => (
              <section key={group.provider} className="flex flex-col gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                  {PROVIDERS.find((entry) => entry.id === group.provider)?.label ?? group.provider}
                </p>
                <ul className="flex flex-col gap-2">
                  {group.rows.map((row) => (
                    <ModelRowView
                      key={`${row.provider}/${row.id}`}
                      row={row}
                      originBadge={
                        row.origin === 'imported' ? (
                          <Badge tone="info">{t('settings.models.importedBadge')}</Badge>
                        ) : (
                          <Badge tone="neutral">{t('settings.models.bundledBadge')}</Badge>
                        )
                      }
                      metaBadges={
                        <>
                          {row.recommended ? (
                            <Badge tone="info">{t('settings.providers.pdfBadge')}</Badge>
                          ) : null}
                          {row.verify ? (
                            <Badge tone="warning">{t('settings.providers.verifyBadge')}</Badge>
                          ) : null}
                        </>
                      }
                      action={
                        row.origin === 'imported' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            iconLeft={<IconTrash className="h-3.5 w-3.5" />}
                            onClick={() => void handleRemove(row)}
                            data-testid="model-remove"
                          >
                            {t('common.remove')}
                          </Button>
                        ) : null
                      }
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </Card>

      {/* 2 — what the providers report today */}
      <Card
        title={t('settings.models.availableTitle')}
        description={t('settings.models.availableDesc')}
      >
        <div className="flex flex-col gap-5" data-testid="available-models">
          {availableGroups.map((group) => {
            const meta = PROVIDERS.find((entry) => entry.id === group.provider)
            const state = group.state
            return (
              <section
                key={group.provider}
                data-testid={`models-provider-${group.provider}`}
                data-state={state.status}
                className="flex flex-col gap-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-text">
                    {meta?.label ?? group.provider}
                    <StatusBadge status={state.status} />
                    <span className="text-[11px] font-normal text-muted">
                      {t('settings.models.count', { count: state.models.length })}
                    </span>
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconLeft={<IconRefresh className="h-3.5 w-3.5" />}
                    loading={state.status === 'loading'}
                    onClick={() => void refresh(group.provider)}
                    data-testid={`models-refresh-${group.provider}`}
                  >
                    {t('settings.providers.refreshModels')}
                  </Button>
                </div>

                {state.status === 'loading' && state.models.length === 0 ? (
                  <Skeleton lines={3} />
                ) : null}

                {state.status === 'no_key' ? (
                  <p
                    className="flex flex-wrap items-center gap-2 text-xs text-muted"
                    data-testid="models-notice"
                  >
                    {t('settings.models.noKey')}
                    <Button size="sm" variant="link" onClick={goToProviders}>
                      {t('settings.models.openProviders')}
                    </Button>
                  </p>
                ) : null}

                {state.status === 'error' && state.errorKind ? (
                  <div
                    className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-raised px-3 py-2 text-xs text-danger"
                    data-testid="models-error"
                  >
                    <ErrorHint kind={state.errorKind} detail={state.detail} />
                    {state.errorKind === 'invalid_key' || state.errorKind === 'vault' ? (
                      <Button size="sm" variant="link" onClick={goToProviders}>
                        {t('settings.models.openProviders')}
                      </Button>
                    ) : null}
                    {state.errorKind === 'network' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void refresh(group.provider)}
                      >
                        {t('common.retry')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {state.checkedAt && (state.status === 'live' || state.status === 'cached') ? (
                  <p className="text-[11px] text-faint">
                    {t('settings.models.checkedAt', {
                      when: new Date(state.checkedAt).toLocaleString(),
                    })}
                  </p>
                ) : null}

                {group.rows.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {group.rows.map((row) => (
                      <ModelRowView
                        key={`${row.provider}/${row.id}`}
                        row={row}
                        action={
                          row.bundled ? (
                            <Badge tone="neutral">{t('settings.models.inList')}</Badge>
                          ) : row.imported ? (
                            <Badge tone="info">{t('settings.models.importedBadge')}</Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              iconLeft={<IconPlus className="h-3.5 w-3.5" />}
                              onClick={() => void handleImport(row)}
                              data-testid="model-import"
                            >
                              {t('settings.models.import')}
                            </Button>
                          )
                        }
                      />
                    ))}
                  </ul>
                ) : state.status === 'loading' ||
                  state.status === 'no_key' ||
                  state.status === 'error' ? null : (
                  <p className="text-xs text-muted">{t('settings.models.noAvailable')}</p>
                )}
              </section>
            )
          })}

          {nothingVisible ? (
            <p className="text-sm text-muted">{t('settings.models.noMatches')}</p>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
