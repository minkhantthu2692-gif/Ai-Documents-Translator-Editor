import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Button, Card, ConfirmDialog, Input, Switch } from '@/components/ui'
import { cacheRepo, DEFAULT_MAX_BYTES, DEFAULT_TTL_MS } from '@/db/repo-cache'
import { CACHE_KINDS, type CacheKind } from '@/db/types'
import { SETTING_KEYS } from '@/db/repo-settings'
import { logEvent } from '@/core/eventLogger'
import { toast } from '@/stores/toastStore'
import { formatBytes } from '@/lib/format'
import { useSetting } from './useSetting'

const DEFAULT_TTL_DAYS: Record<CacheKind, number> = {
  translation: DEFAULT_TTL_MS.translation / 86_400_000,
  pageRender: DEFAULT_TTL_MS.pageRender / 86_400_000,
  ocr: DEFAULT_TTL_MS.ocr / 86_400_000,
  font: DEFAULT_TTL_MS.font / 86_400_000,
}

const DEFAULT_MAX_MB: Record<CacheKind, number> = {
  translation: DEFAULT_MAX_BYTES.translation / (1024 * 1024),
  pageRender: DEFAULT_MAX_BYTES.pageRender / (1024 * 1024),
  ocr: DEFAULT_MAX_BYTES.ocr / (1024 * 1024),
  font: DEFAULT_MAX_BYTES.font / (1024 * 1024),
}

export function CacheTab() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useSetting<boolean>(SETTING_KEYS.cacheEnabled, true)
  const [ttlDays, setTtlDays] = useSetting<Record<string, number>>(SETTING_KEYS.cacheTtl, {
    ...DEFAULT_TTL_DAYS,
  })
  const [maxMb, setMaxMb] = useSetting<Record<string, number>>(SETTING_KEYS.cacheMaxBytes, {
    ...DEFAULT_MAX_MB,
  })

  const sizes = useLiveQuery(() => cacheRepo.sizes(), [])
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draftTtl, setDraftTtl] = useState<Record<string, number>>({ ...DEFAULT_TTL_DAYS })
  const [draftMax, setDraftMax] = useState<Record<string, number>>({ ...DEFAULT_MAX_MB })

  async function clearKind(kind: CacheKind) {
    const removed = await cacheRepo.clearKind(kind)
    const label = t(`settings.cache.kinds.${kind}`)
    logEvent({
      state: 'SETTINGS',
      action: 'cache.clear',
      severity: 'info',
      messageMy: `${label} ကက်ရှ် ဖျက်ပြီး (${removed} ခု)`,
      messageEn: `Cleared ${kind} cache (${removed} entries)`,
      technicalDetail: `kind=${kind} removed=${removed}`,
    })
    toast('success', t('settings.cache.cleared', { kind: label }))
  }

  async function clearAll() {
    setBusy(true)
    try {
      await cacheRepo.purgeExpired()
      const removed = await cacheRepo.clearAll()
      logEvent({
        state: 'SETTINGS',
        action: 'cache.clearAll',
        severity: 'warning',
        messageMy: `ကက်ရှ်အားလုံး ဖျက်ပြီး (${removed} ခု)`,
        messageEn: `Cleared all caches (${removed} entries)`,
        technicalDetail: `removed=${removed}`,
      })
      toast('success', t('settings.cache.allCleared'))
      setConfirmClearAll(false)
    } finally {
      setBusy(false)
    }
  }

  async function saveBudgets() {
    await setTtlDays(draftTtl)
    await setMaxMb(draftMax)
    for (const kind of CACHE_KINDS) {
      await cacheRepo.evict(kind, (draftMax[kind] ?? DEFAULT_MAX_MB[kind]) * 1024 * 1024)
    }
    logEvent({
      state: 'SETTINGS',
      action: 'cache.budgets',
      severity: 'success',
      messageMy: 'ကက်ရှ် ကန့်သတ်ချက်များ သိမ်းပြီး',
      messageEn: 'Cache budgets saved and applied',
      technicalDetail: JSON.stringify({ ttl: draftTtl, max: draftMax }),
    })
    toast('success', t('settings.cache.budgetsSaved'))
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('settings.cache.title')}>
        <div className="flex flex-col gap-4">
          <Switch
            checked={enabled}
            onChange={(next) => void setEnabled(next)}
            label={t('settings.cache.enabled')}
            description={t('settings.cache.enabledDesc')}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-raised/50 px-3 py-2.5">
            <div>
              <p className="text-xs text-faint">{t('settings.cache.totalSize')}</p>
              <p className="text-lg font-semibold tabular-nums text-text">
                {formatBytes(sizes?.total ?? 0)}
              </p>
            </div>
            <div className="text-right text-xs text-muted">
              {CACHE_KINDS.map((kind) => (
                <p key={kind}>
                  {t(`settings.cache.kinds.${kind}`)}:{' '}
                  <span className="tabular-nums text-text">{formatBytes(sizes?.[kind] ?? 0)}</span>
                </p>
              ))}
            </div>
          </div>

          <ul className="flex flex-col gap-2">
            {CACHE_KINDS.map((kind) => (
              <li
                key={kind}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 last:border-b-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">
                    {t(`settings.cache.kinds.${kind}`)}
                    <Badge tone="neutral" className="ml-2">
                      {t('settings.cache.entries', { count: sizes?.entries[kind] ?? 0 })}
                    </Badge>
                  </p>
                  <p className="text-[11px] tabular-nums text-faint">
                    {formatBytes(sizes?.[kind] ?? 0)}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => void clearKind(kind)}>
                  {t('settings.cache.clearType')}
                </Button>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="max-w-xl text-xs text-muted">{t('settings.cache.clearAllBody')}</p>
            <Button variant="danger" size="sm" onClick={() => setConfirmClearAll(true)}>
              {t('settings.cache.clearAll')}
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title={t('settings.cache.budgets')}
        description={t('settings.cache.budgetDesc')}
        actions={
          <Button size="sm" variant="primary" onClick={() => void saveBudgets()}>
            {t('settings.cache.saveBudgets')}
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {CACHE_KINDS.map((kind) => (
            <div key={kind} className="rounded-md border border-border p-3">
              <p className="mb-2 text-xs font-medium text-text">
                {t(`settings.cache.kinds.${kind}`)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  label={t('settings.cache.ttl')}
                  value={String(draftTtl[kind] ?? ttlDays[kind] ?? DEFAULT_TTL_DAYS[kind])}
                  onChange={(event) =>
                    setDraftTtl((current) => ({
                      ...current,
                      [kind]: Number(event.target.value),
                    }))
                  }
                />
                <Input
                  type="number"
                  min={1}
                  max={4096}
                  label={t('settings.cache.maxSize')}
                  value={String(draftMax[kind] ?? maxMb[kind] ?? DEFAULT_MAX_MB[kind])}
                  onChange={(event) =>
                    setDraftMax((current) => ({
                      ...current,
                      [kind]: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-faint">{t('settings.cache.ttlDesc')}</p>
      </Card>

      <ConfirmDialog
        open={confirmClearAll}
        title={t('settings.cache.clearAllTitle')}
        body={t('settings.cache.clearAllBody')}
        confirmLabel={t('settings.cache.clearAll')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        loading={busy}
        onConfirm={() => void clearAll()}
        onCancel={() => setConfirmClearAll(false)}
      />
    </div>
  )
}
