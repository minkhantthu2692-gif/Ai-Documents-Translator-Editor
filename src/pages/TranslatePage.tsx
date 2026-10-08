import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Button, Card, Progress, Select, StatusPanel, Switch } from '@/components/ui'
import { PageContainer, PageHeader, PageLayout } from '@/components/layout/Page'
import { detectLanguage } from '@/core/langDetect'
import type { FsmState } from '@/core/fsm'
import { REASON_CODES } from '@/core/reasonCodes'
import type { PreflightCheck } from '@/pdf/preflight'
import {
  FALLBACK_CHAINS,
  defaultModelFor,
  freeTierLimits,
  modelsFor,
  type ProviderId,
} from '@/config/models.config'
import { languageLabel, languageSelectOptions } from '@/config/languages.config'
import { apiKeyRepo, type ApiKeySummary } from '@/db/repo-apiKeys'
import { blockRepo } from '@/db/repo-content'
import { projectRepo } from '@/db/repo-projects'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { TranslationRunError } from '@/translate/translationClient'
import { buildCoverage } from '@/translate/coverage'
import { getAdapter } from '@/providers'
import { systemPrompt, temperatureFor, userPrompt } from '@/translate/prompts'
import { validateResponse } from '@/translate/batchValidation'
import { useTranslateStore } from '@/stores/translateStore'
import { useImportedModelsStore } from '@/stores/importedModelsStore'
import {
  cancelTranslate,
  pauseTranslate,
  restoreTranslate,
  startTranslate,
  subscribeTranslate,
} from '@/translate/translateQueue'
import {
  applySignal,
  createTranslateMachine,
  signalForPhase,
  type TranslateSignal,
} from '@/translate/translateFsm'
import {
  QUALITY_LEVELS,
  type QualityLevel,
  type RotationStrategy,
  type TerminologyScope,
  type TranslatePhase,
  type TranslateRunConfig,
  type TranslationBatch,
} from '@/translate/types'
import { toast } from '@/stores/toastStore'

const configKey = (projectId: string): string => `translate.config.${projectId}`

function formatEta(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  return `${seconds}s`
}

export function TranslatePage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()

  const project = useLiveQuery(
    async () => (projectId ? ((await projectRepo.get(projectId)) ?? null) : null),
    [projectId],
    undefined,
  )
  const apiKeys = useLiveQuery(() => apiKeyRepo.list(), [], [] as ApiKeySummary[])

  const progress = useTranslateStore((state) => state.progress)
  const failure = useTranslateStore((state) => state.failure)
  const keyStates = useTranslateStore((state) => state.keyStates)

  const machineRef = useRef(createTranslateMachine())
  const [fsmState, setFsmState] = useState<FsmState>('TRANSLATING')
  const [config, setConfig] = useState<TranslateRunConfig | null>(null)
  const [coverage, setCoverage] = useState<Awaited<ReturnType<typeof buildCoverage>> | null>(null)
  const [sourceChoice, setSourceChoice] = useState<string>('')
  const [detected, setDetected] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [sample, setSample] = useState<{ ok: boolean; text: string } | null>(null)
  const [sampleBusy, setSampleBusy] = useState(false)

  const phase: TranslatePhase = progress.phase
  const previousPhase = useRef<TranslatePhase | null>(null)

  /* ---------------------------------------------------------------- */
  /* Load config + resume a run that survived a refresh                */
  /* ---------------------------------------------------------------- */

  const refreshCoverage = useCallback(
    async (activeConfig: TranslateRunConfig) => {
      if (!projectId) return
      try {
        setCoverage(await buildCoverage(projectId, activeConfig))
      } catch {
        setCoverage(null)
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    void (async () => {
      // Imported models must be registered before the stale-config heal
      // below, or an imported id would read as unknown and get wiped.
      await useImportedModelsStore.getState().ensureLoaded()
      if (cancelled) return
      const [stored, provider, storedModel] = await Promise.all([
        settingsRepo.get<TranslateRunConfig | null>(configKey(projectId), null),
        settingsRepo.get<ProviderId>(SETTING_KEYS.provider, 'gemini'),
        settingsRepo.get<string>(SETTING_KEYS.model, ''),
      ])
      if (cancelled) return
      const base =
        stored && stored.projectId === projectId
          ? stored
          : (() => {
              const model = storedModel || defaultModelFor(provider)
              return {
                projectId,
                provider,
                model,
                quality: 'medium' as QualityLevel,
                sourceLang: 'en',
                targetLang: 'my',
                translateImages: true,
                terminologyScope: 'first' as TerminologyScope,
                fallbackModels: FALLBACK_CHAINS[provider].filter((id) => id !== model),
                strategy: 'round-robin' as RotationStrategy,
              } satisfies TranslateRunConfig
            })()

      const record = await projectRepo.get(projectId)
      if (record && !stored) {
        base.sourceLang = record.sourceLang || base.sourceLang
        base.targetLang = record.targetLang || base.targetLang
      }

      // Providers retire model ids, so a saved config can outlive the
      // bundled list. A model this provider no longer offers would render
      // as the wrong <option> (the native select shows the first one) and
      // run as a dead id — reset it to the provider's current default.
      // The openai-compatible provider is exempt: local endpoints serve
      // ids that are not in the bundled registry.
      let healedModel: string | null = null
      const chain = FALLBACK_CHAINS[base.provider]
      if (
        base.provider !== 'openai' &&
        chain &&
        chain.length > 0 &&
        !modelsFor(base.provider).some((entry) => entry.id === base.model)
      ) {
        base.model = chain[0]
        base.fallbackModels = chain.filter((id) => id !== base.model)
        healedModel = base.model
        await settingsRepo.set(configKey(projectId), base, 'translate')
      }

      setConfig(base)
      setSourceChoice(base.sourceLang)
      setConfirmed(true)
      if (healedModel) toast('info', t('translate.modelHealed', { model: healedModel }))

      const pending = await restoreTranslate(projectId, true)
      await refreshCoverage(base)
      if (pending > 0) toast('info', t('translate.resumedRun', { count: pending }))
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, refreshCoverage, t])

  /* ---------------------------------------------------------------- */
  /* Queue → FSM + coverage refresh                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!projectId) return
    const unsubscribe = subscribeTranslate((event) => {
      if (event.type !== 'phase' || !config) return
      if (event.phase === 'done' || event.phase === 'running' || event.phase === 'failed') {
        void refreshCoverage(config)
      }
    })
    return () => {
      unsubscribe()
    }
  }, [projectId, config, refreshCoverage])

  /** Queue phase → pipeline state machine (the Status Panel reads it). */
  useEffect(() => {
    const previous = previousPhase.current
    previousPhase.current = phase
    if (previous === phase) return
    if (!project) return

    let signal: TranslateSignal | null = null
    if (phase === 'waiting' && progress.waitingUntil) {
      signal = {
        type: 'waiting',
        until: progress.waitingUntil,
        reason: progress.waitingReason ?? 'ALL_KEYS_COOLING_DOWN',
      }
    } else if (phase === 'running' && previous === 'waiting') {
      signal = { type: 'resumed', until: progress.waitingUntil ?? undefined }
    } else {
      signal = signalForPhase(phase, previous, failure?.reasonCode ?? 'ALL_KEYS_COOLING_DOWN')
    }
    if (signal) setFsmState(applySignal(machineRef.current, signal))
  }, [phase, progress.waitingUntil, progress.waitingReason, failure, project])

  /** One tick per second while a rate-limit cooldown counts down. */
  useEffect(() => {
    if (phase !== 'waiting') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  /* ---------------------------------------------------------------- */
  /* Config editing                                                    */
  /* ---------------------------------------------------------------- */

  const updateConfig = useCallback(
    async (patch: Partial<TranslateRunConfig>) => {
      if (!config || !projectId) return
      const next: TranslateRunConfig = { ...config, ...patch }
      setConfig(next)
      await settingsRepo.set(configKey(projectId), next, 'translate')
      await refreshCoverage(next)
    },
    [config, projectId, refreshCoverage],
  )

  const detectSource = useCallback(async () => {
    if (!projectId) return
    const blocks = await blockRepo.listByProject(projectId)
    const sample = blocks
      .filter((block) => block.sourceText.trim().length > 0)
      .slice(0, 40)
      .map((block) => block.sourceText)
      .join(' ')
      .slice(0, 4000)
    const result = detectLanguage(sample)
    if (result.lang) setDetected(result.lang)
    else setDetected(null)
  }, [projectId])

  function chooseSource(value: string) {
    setSourceChoice(value)
    if (value === 'auto') {
      setConfirmed(false)
      setDetected(null)
      void detectSource()
      return
    }
    setConfirmed(true)
    setDetected(null)
    void updateConfig({ sourceLang: value })
  }

  function confirmDetected() {
    if (!detected) return
    setConfirmed(true)
    setSourceChoice(detected)
    void updateConfig({ sourceLang: detected })
  }

  /* ---------------------------------------------------------------- */
  /* Sample-line test: one real request, real prompt, real validation  */
  /* ---------------------------------------------------------------- */

  async function handleSampleTest() {
    if (!config || !projectId || sampleBusy) return
    setSampleBusy(true)
    setSample(null)
    try {
      const usable = (apiKeys ?? []).find(
        (key) =>
          key.provider === config.provider && key.enabled !== false && key.status !== 'invalid',
      )
      if (!usable) {
        toast('danger', t('settings.providers.emptyProvider'))
        return
      }
      const blocks = await blockRepo.listByProject(projectId)
      const source =
        blocks.find((block) => block.sourceText.trim().length > 0)?.sourceText.trim() ?? ''
      if (!source) {
        toast('info', t('translate.nothingToTranslate'))
        return
      }

      const batch: TranslationBatch = {
        id: `sample#${projectId}`,
        pageIndex: 0,
        index: 0,
        tokens: Math.ceil(source.length / 4),
        lines: [
          {
            id: 'sample-0',
            text: source,
            pageIndex: 0,
            order: 0,
            listMarker: null,
            placeholders: [],
          },
        ],
      }
      const secret = await apiKeyRepo.reveal(usable.id)
      const result = await getAdapter(config.provider).translate(
        secret,
        {
          model: config.model,
          system: systemPrompt({
            quality: config.quality,
            sourceLang: config.sourceLang,
            targetLang: config.targetLang,
            glossary: [],
            terminologyScope: config.terminologyScope,
          }),
          user: userPrompt(batch),
          temperature: temperatureFor(config.quality),
          maxOutputTokens: 400,
        },
        { baseUrl: config.baseUrl },
      )
      const verdict = validateResponse(result.text, batch)
      setSample(
        verdict.ok
          ? { ok: true, text: verdict.lines[0]?.text ?? '' }
          : { ok: false, text: verdict.detail || result.text.slice(0, 300) },
      )
    } catch (error) {
      toast(
        'danger',
        t('settings.providers.sampleFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setSampleBusy(false)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Run controls                                                      */
  /* ---------------------------------------------------------------- */

  async function handleStart() {
    if (!config || !projectId) return
    try {
      const outcome = await startTranslate(projectId, config)
      if (outcome.pending === 0) toast('info', t('translate.nothingToTranslate'))
      else toast('success', t('translate.started', { count: outcome.pending }))
    } catch (error) {
      if (error instanceof TranslationRunError) {
        useTranslateStore.getState().setFailure({
          reasonCode: error.reasonCode,
          message: error.message,
        })
        toast('danger', t('translate.failedToast', { reason: error.reasonCode }))
      } else {
        toast('danger', error instanceof Error ? error.message : String(error))
      }
    }
  }

  function handleFix() {
    if (
      failure &&
      (failure.reasonCode === 'NO_API_KEY' ||
        failure.reasonCode === 'KEYS_LOCKED' ||
        failure.reasonCode === 'INVALID_KEY')
    ) {
      navigate('/settings')
      return
    }
    // Rebuild from the config on screen instead of resuming the previous
    // in-memory run: that run can still hold the provider/model the user
    // has since changed — exactly how one MODEL_UNAVAILABLE kept repeating
    // after every switch. startTranslate re-plans from Dexie, so lines
    // already translated stay done and only the pending ones re-run.
    void handleStart()
  }

  const percent =
    progress.total > 0
      ? Math.round(((progress.alreadyDone + progress.done) / progress.total) * 100)
      : 0
  const waitingSeconds =
    phase === 'waiting' && progress.waitingUntil
      ? Math.max(0, Math.ceil((progress.waitingUntil - now) / 1000))
      : 0

  /* ---------------------------------------------------------------- */
  /* Preflight checks for the Status Panel                             */
  /* ---------------------------------------------------------------- */

  const checks = useMemo<PreflightCheck[]>(() => {
    if (!config) return []
    const usable = (apiKeys ?? []).filter(
      (key) =>
        key.provider === config.provider && key.enabled !== false && key.status !== 'invalid',
    )
    const cooling = usable.filter((key) => key.cooldownUntil > Date.now())
    const out: PreflightCheck[] = []

    out.push(
      usable.length === 0
        ? {
            id: 'apiKey',
            status: 'fail',
            labelKey: 'preflight.apiKey',
            reasonCode: 'NO_API_KEY',
            detailMy: 'AI သော့ မထည့်ရသေးပါ',
            detailEn: `No usable API key for ${config.provider}`,
            fix: {
              id: 'open_providers',
              kind: 'navigation',
              labelEn: 'Open AI Providers',
              labelMy: 'AI ပံ့ပိုးသူများ ဖွင့်ရန်',
            },
          }
        : {
            id: 'apiKey',
            status: cooling.length > 0 ? 'warn' : 'pass',
            labelKey: 'preflight.apiKey',
            reasonCode: cooling.length > 0 ? 'ALL_KEYS_COOLING_DOWN' : null,
            detailMy: `အသုံးပြုနိုင်သော သော့ ${usable.length} ခု`,
            detailEn:
              cooling.length > 0
                ? `${usable.length} key(s), ${cooling.length} cooling down`
                : `${usable.length} key(s) ready`,
            fix: null,
          },
    )

    const limits = freeTierLimits(config.provider, config.model)
    out.push({
      id: 'quota',
      status: limits.maxRequests > 0 ? 'pass' : 'pending',
      labelKey: 'preflight.quota',
      reasonCode: null,
      detailMy:
        limits.maxRequests > 0
          ? `တစ်နေ့လျှင် တောင်းဆိုမှု ${limits.maxRequests}`
          : 'အခမဲ့ အဆင့်သတ်မှတ်ချက် မသိရှိရသေးပါ',
      detailEn:
        limits.maxRequests > 0
          ? `Free tier: ${limits.maxRequests} requests/day`
          : 'Free-tier limit unknown for this model',
      fix: null,
    })

    const languagesOk =
      config.sourceLang !== config.targetLang &&
      config.sourceLang.length > 0 &&
      config.targetLang.length > 0
    out.push(
      languagesOk
        ? {
            id: 'languages',
            status: confirmed ? 'pass' : 'warn',
            labelKey: 'preflight.languages',
            reasonCode: confirmed ? null : 'LANGUAGES_MISSING',
            detailMy: `${languageLabel(config.sourceLang)} → ${languageLabel(config.targetLang)}`,
            detailEn: confirmed
              ? `${languageLabel(config.sourceLang)} → ${languageLabel(config.targetLang)}`
              : 'Confirm the detected source language',
            fix: confirmed
              ? null
              : {
                  id: 'confirm_language',
                  kind: 'config',
                  labelEn: 'Confirm detected language',
                  labelMy: 'ဖော်ပြထားသော ဘာသာစကား အတည်ပြုရန်',
                },
          }
        : {
            id: 'languages',
            status: 'fail',
            labelKey: 'preflight.languages',
            reasonCode: 'LANGUAGES_MISSING',
            detailMy: 'ဘာသာစကားနှစ်ခု မပြည့်စုံပါ',
            detailEn: 'Pick two different languages',
            fix: {
              id: 'pick_languages',
              kind: 'config',
              labelEn: 'Pick both languages',
              labelMy: 'ဘာသာစကားနှစ်ခု ရွေးရန်',
            },
          },
    )

    return out
  }, [config, apiKeys, confirmed])

  const blockers = checks.filter((check) => check.status === 'fail')
  const startDisabled = blockers.length > 0 || !config || !confirmed || phase === 'running'

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  if (!projectId || project === null) {
    return (
      <PageContainer>
        <Card title={t('translate.title')}>
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted">{t('translate.noProject')}</p>
            <Link to="/projects">
              <Button variant="secondary" size="sm">
                {t('workspace.backToProjects')}
              </Button>
            </Link>
          </div>
        </Card>
      </PageContainer>
    )
  }

  if (project === undefined) {
    return (
      <PageContainer>
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-4 w-1/3 rounded-md" />
          <div className="skeleton-shimmer h-40 w-full rounded-md" />
        </div>
      </PageContainer>
    )
  }

  const phaseLabel = t(`translate.phase.${phase}`)
  const activeKeyState = keyStates.length > 0 ? keyStates : null

  return (
    <PageContainer>
      <PageHeader
        title={t('translate.title')}
        subtitle={project ? project.name : t('translate.subtitle')}
        meta={<Badge tone={phase === 'failed' ? 'danger' : 'primary'}>{phaseLabel}</Badge>}
        actions={
          <Link to={`/workspace/${projectId}`}>
            <Button variant="ghost" size="sm">
              {t('translate.backToWorkspace')}
            </Button>
          </Link>
        }
      />

      <PageLayout
        inspector={
          <>
            <StatusPanel
              data-testid="translate-status"
              checks={checks}
              current={{
                stage: 'translate',
                done: percent,
                total: 100,
                detail: `${phaseLabel} · ${t(`workspace.phases.${fsmState}`)}`,
              }}
              onStart={() => void handleStart()}
              startLabel={t('translate.start')}
              startDisabled={startDisabled}
              onFix={handleFix}
              actions={
                <>
                  {phase === 'running' || phase === 'waiting' ? (
                    <Button size="sm" onClick={pauseTranslate} data-testid="translate-pause">
                      {t('translate.pause')}
                    </Button>
                  ) : null}
                  {phase === 'paused' || phase === 'failed' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleStart()}
                      data-testid="translate-resume"
                    >
                      {t('translate.resume')}
                    </Button>
                  ) : null}
                  {failure ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={handleFix}
                      data-testid="translate-fix"
                    >
                      {t('translate.fixResume')}
                    </Button>
                  ) : null}
                  {progress.failed > 0 && phase !== 'running' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleStart()}
                      data-testid="translate-retry"
                    >
                      {t('translate.retryFailed')}
                    </Button>
                  ) : null}
                  {phase === 'running' || phase === 'paused' || phase === 'waiting' ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={cancelTranslate}
                      data-testid="translate-cancel"
                    >
                      {t('translate.cancel')}
                    </Button>
                  ) : null}
                </>
              }
            />

            <Card title={t('translate.keyStatus')}>
              {activeKeyState === null ? (
                <p className="text-xs text-muted">{t('translate.keyStatusEmpty')}</p>
              ) : (
                <ul className="flex flex-col gap-2" data-testid="key-status-list">
                  {activeKeyState.map((state) => {
                    const record = (apiKeys ?? []).find((key) => key.id === state.id)
                    const cooling = state.cooldownUntil > now
                    return (
                      <li
                        key={state.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="font-mono tabular-nums text-text">
                          {record ? `••••••••${record.lastFour}` : state.id.slice(0, 8)}
                        </span>
                        <Badge
                          tone={
                            cooling ? 'warning' : state.status === 'invalid' ? 'danger' : 'success'
                          }
                        >
                          {cooling
                            ? t('translate.cooldown', {
                                seconds: Math.ceil((state.cooldownUntil - now) / 1000),
                              })
                            : t(`translate.keyHealth.${state.status}`)}
                        </Badge>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* ---- configuration ---------------------------------------- */}
          <Card title={t('translate.configuration')} description={t('translate.configNote')}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label={t('translate.sourceLanguage')}
                value={sourceChoice}
                options={[
                  { value: 'auto', label: t('translate.autoDetect') },
                  ...languageSelectOptions(),
                ]}
                onChange={(event) => chooseSource(event.target.value)}
                hint={
                  sourceChoice === 'auto'
                    ? confirmed && detected
                      ? t('translate.autoDetected', { lang: languageLabel(detected) })
                      : t('translate.autoDetectPending')
                    : undefined
                }
                data-testid="source-language"
              />
              <Select
                label={t('translate.targetLanguage')}
                value={config?.targetLang ?? 'my'}
                options={languageSelectOptions()}
                onChange={(event) => void updateConfig({ targetLang: event.target.value })}
                data-testid="target-language"
              />

              {sourceChoice === 'auto' && !confirmed ? (
                <div className="sm:col-span-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2">
                  <p className="text-xs text-text">
                    {detected
                      ? t('translate.autoDetected', { lang: languageLabel(detected) })
                      : t('translate.autoDetectUnknown')}
                  </p>
                  {detected ? (
                    <Button size="sm" onClick={confirmDetected} data-testid="confirm-language">
                      {t('translate.autoDetectConfirm')}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <Select
                label={t('translate.provider')}
                value={config?.provider ?? 'gemini'}
                options={[
                  { value: 'gemini', label: 'Google Gemini' },
                  { value: 'openrouter', label: 'OpenRouter' },
                  { value: 'groq', label: 'Groq' },
                  { value: 'openai', label: 'OpenAI-compatible' },
                ]}
                onChange={(event) => {
                  const provider = event.target.value as ProviderId
                  const model = defaultModelFor(provider)
                  void updateConfig({
                    provider,
                    model,
                    fallbackModels: FALLBACK_CHAINS[provider].filter((id) => id !== model),
                  })
                }}
                data-testid="provider-select"
              />
              <Select
                label={t('translate.model')}
                value={config?.model ?? ''}
                options={modelsFor(config?.provider ?? 'gemini').map((spec) => ({
                  value: spec.id,
                  label: spec.free ? `${spec.label} · ${t('translate.freeBadge')}` : spec.label,
                }))}
                onChange={(event) => void updateConfig({ model: event.target.value })}
                hint={t('translate.modelHint')}
                data-testid="model-select"
              />

              <Select
                label={t('translate.quality')}
                value={config?.quality ?? 'medium'}
                options={QUALITY_LEVELS.map((level) => ({
                  value: level,
                  label: t(`translate.quality${level.charAt(0).toUpperCase()}${level.slice(1)}`),
                }))}
                onChange={(event) =>
                  void updateConfig({ quality: event.target.value as QualityLevel })
                }
                data-testid="quality-select"
              />
              <Select
                label={t('translate.terminologyScope')}
                value={config?.terminologyScope ?? 'first'}
                options={[
                  { value: 'first', label: t('translate.scopeFirst') },
                  { value: 'document', label: t('translate.scopeDocument') },
                  { value: 'every', label: t('translate.scopeEvery') },
                ]}
                onChange={(event) =>
                  void updateConfig({ terminologyScope: event.target.value as TerminologyScope })
                }
                data-testid="scope-select"
              />

              <div className="flex items-start">
                <Switch
                  checked={config?.translateImages ?? true}
                  label={t('translate.imageTranslation')}
                  description={t('translate.imageTranslationDesc')}
                  onChange={(next) => void updateConfig({ translateImages: next })}
                />
              </div>
              <Select
                label={t('translate.strategy')}
                value={config?.strategy ?? 'round-robin'}
                options={[
                  { value: 'round-robin', label: t('translate.strategyRoundRobin') },
                  { value: 'least-used', label: t('translate.strategyLeastUsed') },
                ]}
                onChange={(event) =>
                  void updateConfig({ strategy: event.target.value as RotationStrategy })
                }
                data-testid="strategy-select"
              />

              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={sampleBusy}
                  onClick={() => void handleSampleTest()}
                  data-testid="sample-test"
                >
                  {t('settings.providers.sampleTest')}
                </Button>
                {sample ? (
                  <span
                    className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs"
                    data-testid="sample-result"
                  >
                    <Badge tone={sample.ok ? 'success' : 'warning'}>
                      {sample.ok ? t('status.checkPass') : t('status.checkWarn')}
                    </Badge>
                    <span className="truncate text-text" title={sample.text}>
                      {sample.text}
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
          </Card>

          {/* ---- progress -------------------------------------------- */}
          <Card title={t('translate.progress')}>
            <div className="flex flex-col gap-3" data-testid="translate-progress">
              <Progress
                value={percent}
                label={t('translate.overall', {
                  done: progress.alreadyDone + progress.done,
                  total: progress.total,
                })}
                showLabel
                tone={phase === 'failed' ? 'danger' : phase === 'done' ? 'success' : 'primary'}
              />

              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div>
                  <p className="text-faint">{t('translate.pageProgress')}</p>
                  <p className="tabular-nums text-text" data-testid="page-progress">
                    {progress.pageIndex !== null
                      ? t('translate.pageValue', {
                          page: progress.pageIndex + 1,
                          done: progress.pageDone,
                          total: progress.pageTotal,
                        })
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-faint">{t('translate.eta')}</p>
                  <p className="tabular-nums text-text" data-testid="eta">
                    {progress.etaMs !== null && phase === 'running'
                      ? formatEta(progress.etaMs)
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-faint">{t('translate.reqPerMin')}</p>
                  <p className="tabular-nums text-text" data-testid="req-per-min">
                    {progress.requestsPerMinute.toFixed(1)}
                  </p>
                </div>
                <div>
                  <p className="text-faint">{t('translate.activeKey')}</p>
                  <p className="font-mono tabular-nums text-text" data-testid="active-key">
                    {progress.activeKey ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-faint">{t('translate.tokens')}</p>
                  <p className="tabular-nums text-text" data-testid="tokens">
                    {progress.tokensIn} / {progress.tokensOut}
                  </p>
                </div>
                <div>
                  <p className="text-faint">{t('translate.retries')}</p>
                  <p className="tabular-nums text-text" data-testid="retries">
                    {progress.retries}
                  </p>
                </div>
                <div>
                  <p className="text-faint">{t('translate.modelUsed')}</p>
                  <p className="truncate text-text" data-testid="model-used">
                    {progress.model ?? config?.model ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-faint">{t('translate.failedLines')}</p>
                  <p className="tabular-nums text-text" data-testid="failed-lines">
                    {progress.failed}
                  </p>
                </div>
              </div>

              {phase === 'waiting' ? (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-text"
                  data-testid="waiting-banner"
                >
                  <span>
                    {progress.waitingReason === 'QUOTA_EXHAUSTED'
                      ? t('translate.waitingQuota')
                      : t('translate.waitingKeys')}
                  </span>
                  <Badge tone="warning">
                    {t('translate.waitingUntil', { seconds: waitingSeconds })}
                  </Badge>
                </div>
              ) : null}

              {failure ? (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-xs"
                  data-testid="failure-banner"
                >
                  <span className="text-text">
                    {i18n.language === 'my'
                      ? (REASON_CODES[failure.reasonCode]?.messageMy ?? failure.message)
                      : (REASON_CODES[failure.reasonCode]?.messageEn ?? failure.message)}
                  </span>
                  <Button size="sm" variant="primary" onClick={handleFix}>
                    {t('translate.fixResume')}
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>

          {/* ---- coverage -------------------------------------------- */}
          {coverage ? (
            <Card title={t('translate.coverage')} data-testid="coverage-card">
              <div className="flex flex-col gap-2">
                <p className="text-sm text-text" data-testid="coverage-line">
                  {t('translate.coverageLine', {
                    translated: coverage.translated,
                    total: coverage.total,
                    flagged: coverage.flagged,
                  })}
                </p>
                <p className="text-xs text-muted">
                  {t('translate.qualityScore', { value: coverage.qualityScore })}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {coverage.perPage.slice(0, 12).map((page) => (
                    <li key={page.pageIndex}>
                      <Badge tone={page.score !== null && page.score >= 80 ? 'success' : 'warning'}>
                        {t('translate.pageScore', {
                          page: page.pageIndex + 1,
                          value: page.score ?? 0,
                        })}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          ) : null}
        </div>
      </PageLayout>
    </PageContainer>
  )
}
