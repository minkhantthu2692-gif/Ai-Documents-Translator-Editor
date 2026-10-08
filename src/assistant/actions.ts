/**
 * One-click safe actions offered under assistant answers.
 *
 * "Safe" means: no API key material is read, written or displayed; nothing is
 * deleted without an explicit existing confirmation flow; every action is
 * idempotent. Effects the dialog must perform (navigation, sync trigger) are
 * returned as data instead of executed here, so this module stays testable
 * without a router or React.
 */

import { apiKeyRepo } from '@/db/repo-apiKeys'
import { cacheRepo } from '@/db/repo-cache'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import { getDb } from '@/db/db'
import type { SafeActionId } from './types'

export type ActionEffect =
  { type: 'navigate'; to: string } | { type: 'sync-now' } | { type: 'reload' }

export interface ActionOutcome {
  ok: boolean
  /** Toast copy (component picks by language). */
  titleEn: string
  titleMy: string
  effect?: ActionEffect
}

export interface RunActionOptions {
  /** True when the answer that offered the action was sync-related. */
  syncContext?: boolean
}

const DEFAULT_BATCH_MAX_LINES = 25
const MIN_BATCH_MAX_LINES = 5

function navigate(to: string, en: string, my: string): ActionOutcome {
  return { ok: true, titleEn: en, titleMy: my, effect: { type: 'navigate', to } }
}

/**
 * Executes one assistant action.
 *
 * @param id       Action id from `SafeActionId`.
 * @param options  Context hints (sync answers retry the sync, others reload).
 */
export async function runSafeAction(
  id: string,
  options: RunActionOptions = {},
): Promise<ActionOutcome> {
  switch (id as SafeActionId) {
    case 'rotate-key': {
      // Clearing cooldowns never exposes a key — it only lets the pool try the
      // stored keys again; pasting a replacement still happens in Settings.
      const rows = await apiKeyRepo.list()
      let cleared = 0
      const db = getDb()
      for (const row of rows) {
        if ((row.cooldownUntil ?? 0) > 0 || row.cooldownReason) {
          await db.apiKeys.update(row.id, { cooldownUntil: 0, cooldownReason: null })
          cleared += 1
        }
      }
      return {
        ok: true,
        titleEn:
          cleared > 0
            ? `Cooldowns cleared on ${cleared} key(s) — the pool will try them again. Paste a replacement key in AI Providers if the old one was rejected.`
            : 'No key is cooling down. Paste a replacement key in Settings → AI Providers if the old one was rejected.',
        titleMy:
          cleared > 0
            ? `သော့ ${cleared} ခု၏ အအေးခံချိန် ဖျက်ပြီး — ပြန်စမ်းပါမည်။ သော့ဟောင်း ငြင်းဆိုခံရပါက AI Providers တွင် အသစ် ထည့်ပါ။`
            : `လက်ရှိ အအေးခံနေသော သော့ မရှိပါ။ သော့ဟောင်း ငြင်းဆိုခံရပါက Settings → AI Providers တွင် အသစ် ထည့်ပါ။`,
        effect: { type: 'navigate', to: '/settings?tab=providers' },
      }
    }

    case 'reduce-batch': {
      const current = await settingsRepo.get<number>(
        SETTING_KEYS.batchMaxLines,
        DEFAULT_BATCH_MAX_LINES,
      )
      const safeCurrent =
        typeof current === 'number' && Number.isFinite(current) && current > 0
          ? Math.floor(current)
          : DEFAULT_BATCH_MAX_LINES
      const next = Math.max(MIN_BATCH_MAX_LINES, Math.floor(safeCurrent * 0.6))
      if (next !== safeCurrent) {
        await settingsRepo.set(SETTING_KEYS.batchMaxLines, next, 'translate')
      }
      return {
        ok: next !== safeCurrent,
        titleEn:
          next !== safeCurrent
            ? `Batch size reduced from ${safeCurrent} to ${next} lines — the next run sends fewer, shorter requests.`
            : `Batch size is already at the minimum (${MIN_BATCH_MAX_LINES} lines).`,
        titleMy:
          next !== safeCurrent
            ? `လုပ်ဆောင်ချက်အစုကို ${safeCurrent} မှ ${next} စာကြောင်းအထိ လျှော့ပြီး — နောက်တစ်ကြိမ်တွင် တောင်းဆိုမှု နည်းနည်းသာ သွားပါမည်။`
            : `လုပ်ဆောင်ချက်အစု အနည်းဆုံး (${MIN_BATCH_MAX_LINES} စာကြောင်း) သို့ ရောက်နေပြီ။`,
      }
    }

    case 'clear-cache': {
      await cacheRepo.clearAll()
      return {
        ok: true,
        titleEn: 'Cache cleared. The next translation rebuilds fresh responses.',
        titleMy: 'ကက်ရှ် ဖျက်ပြီးပါပြီ။ နောက်ဘာသာပြန်မှုတွင် အဖြေအသစ် တည်ဆောက်ပါမည်။',
      }
    }

    case 'retry': {
      if (options.syncContext) {
        return {
          ok: true,
          titleEn: 'Starting a sync now.',
          titleMy: 'စင့် စတင်နေပြီ။',
          effect: { type: 'sync-now' },
        }
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return {
          ok: false,
          titleEn: 'You are still offline — reconnect, then retry.',
          titleMy: 'ကျန်သေးသည် — အင်တာနက် ပြန်ချိတ်ပြီးမှ ပြန်ကြိုးစားပါ။',
        }
      }
      return {
        ok: true,
        titleEn: 'Reloading the app — local work is saved automatically.',
        titleMy: 'အက်ပ် ပြန်ဖွင့်နေသည် — အလုပ်အားလုံး အလိုအလျောက် သိမ်းထားသည်။',
        effect: { type: 'reload' },
      }
    }

    case 'open-providers':
      return navigate(
        '/settings?tab=providers',
        'Opening AI Providers.',
        'AI Providers သို့ ဖွင့်နေသည်။',
      )

    case 'open-data':
      return navigate(
        '/settings?tab=data',
        'Opening data & sync settings.',
        'ဒေတာနှင့် စင့်ဆက်တင် ဖွင့်နေသည်။',
      )

    case 'open-logs':
      return navigate('/logs', 'Opening logs.', 'မှတ်တမ်း ဖွင့်နေသည်။')

    default:
      return {
        ok: false,
        titleEn: `Unknown action "${id}" — nothing was changed.`,
        titleMy: `မသိသော လုပ်ဆောင်ချက် "${id}" — ဘာမှ မပြောင်းပါ။`,
      }
  }
}

/** Ids this executor understands (used by the dialog to guard rendering). */
export const EXECUTABLE_ACTIONS: readonly string[] = [
  'rotate-key',
  'reduce-batch',
  'clear-cache',
  'retry',
  'open-providers',
  'open-data',
  'open-logs',
]
