/**
 * Offline rule-based assistant.
 *
 * Used when no proxy is configured, when the proxy is unreachable/rate
 * limited, or when the user simply has no network. Answers are assembled from
 * three sources, in priority order for a non-empty question:
 *
 *   1. keyword rules matched against the question (English + Burmese),
 *   2. the known error code (sync/HTTP) from the structured context,
 *   3. the app's reason-code catalogue (plain-language message + fix steps),
 *   4. a generic fallback that still offers safe actions.
 *
 * Every rule is bilingual and only ever offers *safe* actions — nothing here
 * can touch API keys, delete data or hit the network.
 */

import { REASON_CODES, type ReasonCode } from '@/core/reasonCodes'
import type {
  AssistantAction,
  AssistantAnswer,
  AssistantContext,
  AssistantLang,
  SafeActionId,
} from './types'

interface RuleAction {
  id: SafeActionId
  kind: AssistantAction['kind']
  label: { en: string; my: string }
}

interface Rule {
  id: string
  keywords: string[]
  title: { en: string; my: string }
  explanation: { en: string; my: string }
  steps: { en: string; my: string }[]
  actions: RuleAction[]
}

const act = (
  id: SafeActionId,
  kind: AssistantAction['kind'],
  en: string,
  my: string,
): RuleAction => ({
  id,
  kind,
  label: { en, my },
})

/* -------------------------------------------------------------------------- */
/* Keyword rules                                                              */
/* -------------------------------------------------------------------------- */

const KEYWORD_RULES: Rule[] = [
  {
    id: 'rate-limit',
    keywords: [
      '429',
      'rate limit',
      'rate-limit',
      'too many requests',
      'quota',
      'quota exhausted',
      'ကန့်သတ်ချက်',
      'quota ပြည့်',
    ],
    title: {
      en: 'The AI provider is rate limiting you',
      my: 'AI ပေးပို့သူက အသုံးပြုမှု ကန့်သတ်ထားသည်',
    },
    explanation: {
      en: 'The provider rejected the request because too many calls were made in a short window. The key itself is usually fine — the app rotates keys and retries after a cooldown, but you can lower the batch size so each run makes fewer, smaller calls.',
      my: 'အချိန်အတိုအတွင်း တောင်းဆိုမှု အများကြီးသွားသောကြောင့် ပေးပို့သူက ငြင်းဆိုခြင်းဖြစ်သည်။ သော့ကိုယ်တိုင် ပုံမှန်ဖြစ်ပြီး အပြင်းအထန် အသုံးမပြုမီ အအေးခံချိန်ပြီးမှ ပြန်ကြိုးစားပါမည်။ လုပ်ဆောင်ချက်အစု လျှော့ချထားပါက တောင်းဆိုမှု နည်းနည်းသာ သွားပါမည်။',
    },
    steps: [
      {
        en: 'Wait a couple of minutes for the cooldown to expire, then retry the job.',
        my: 'အအေးခံချိန်ကုန်ရန် ၂ မိနစ်ခန့် စောင့်ပြီး ပြန်ကြိုးစားပါ။',
      },
      {
        en: 'Lower the translation batch size so each run sends fewer requests.',
        my: 'ဘာသာပြန် လုပ်ဆောင်ချက်အစု လျှော့ချပါ — တောင်းဆိုမှု နည်းသွားပါမည်။',
      },
      {
        en: 'Add a second key in Settings → AI Providers to spread the load.',
        my: 'ဝန်ဖြန့်ရန် ဒုတိယသော့ တစ်ခု ထည့်ပါ (Settings → AI Providers)။',
      },
    ],
    actions: [
      act('reduce-batch', 'config', 'Reduce batch size', 'လုပ်ဆောင်ချက်အစု လျှော့ရန်'),
      act('retry', 'retry', 'Retry now', 'ယခု ပြန်ကြိုးစားရန်'),
      act('open-providers', 'navigation', 'Open AI Providers', 'AI Providers ဖွင့်ရန်'),
    ],
  },
  {
    id: 'missing-key',
    keywords: [
      'no api key',
      'api key',
      'add key',
      'missing key',
      'invalid key',
      'key expired',
      'သော့',
      'api key မရှိ',
      'သော့ မရှိ',
    ],
    title: {
      en: 'The AI provider key is missing or rejected',
      my: 'AI သော့ မရှိသည် သို့မဟုတ် ငြင်းဆိုခံရသည်',
    },
    explanation: {
      en: 'Translation needs a provider key. Either none has been added yet, or the provider rejected the key (revoked, wrong project, or expired). Keys are stored only on this device and are never sent anywhere except the provider itself.',
      my: 'ဘာသာပြန်ရန် ပေးပို့သူသော့ လိုအပ်သည်။ မထည့်ရသေးခြင်း၊ မှားခြင်း သို့မဟုတ် ပယ်ဖျက်ခြင်း ဖြစ်နိုင်သည်။ သော့များကို ဤစက်တွင်သာ သိမ်းထားပြီး ပေးပို့သူကို လွဲ၍ အခြားသူ မည်သူ့ထံမှ မပို့ပါ။',
    },
    steps: [
      {
        en: 'Open Settings → AI Providers and add or replace the key.',
        my: 'Settings → AI Providers သို့ သွား၍ သော့ ထည့်ပါ။',
      },
      {
        en: 'Press “Test” next to the key to confirm the provider accepts it.',
        my: 'သော့အနီးရှိ “Test” ကို နှိပ်၍ အတည်ပြုပါ။',
      },
      {
        en: 'Make sure a provider and model are selected for translation.',
        my: 'ဘာသာပြန်ရန် ပေးပို့သူနှင့် မော်ဒယ် ရွေးထားကြောင်း သေချာပါစေ။',
      },
    ],
    actions: [
      act('open-providers', 'navigation', 'Open AI Providers', 'AI Providers ဖွင့်ရန်'),
      act('retry', 'retry', 'Retry the job', 'အလုပ် ပြန်ကြိုးစားရန်'),
    ],
  },
  {
    id: 'offline',
    keywords: [
      'offline',
      'no internet',
      'network',
      'connection',
      'disconnected',
      'cannot connect',
      'အင်တာနက်',
      'မချိတ်',
      'အော့ဖ်လိုင်း',
      'ကွန်ရက်',
    ],
    title: { en: 'You are offline', my: 'အင်တာနက် မချိတ်ထားပါ' },
    explanation: {
      en: 'The browser reports no network. Translation and sync pause automatically and everything you edit is kept in local storage — jobs resume and pending changes upload as soon as the connection returns.',
      my: 'ကွန်ရက် မရှိဟု ဘရောက်ဇာက သတိပေးသည်။ ဘာသာပြန်ခြင်းနှင့် စင့်ကို ယာယီရပ်ထားပြီး ပြင်ဆင်မှုအားလုံး ဒေတာဘန်းတွင် သိမ်းထားသည်။ ချိတ်ဆက်မှု ပြန်ရသည်နှင့်အမျှ အလုပ်များနှင့် စင့် ပြန်လည်စတပါမည်။',
    },
    steps: [
      {
        en: 'Check Wi-Fi/mobile data, then toggle airplane mode to force a reconnect.',
        my: 'Wi-Fi/မိုဘိုင်းဒေတာ စစ်ပြီး လေကြောင်းစနစ် ဖွင့်-ပိတ် လုပ်၍ ပြန်ချိတ်ကြည့်ပါ။',
      },
      {
        en: 'Press Sync Now in Settings → Data after reconnecting to upload queued edits.',
        my: 'ပြန်ချိတ်ပြီးနောက် Settings → Data မှ Sync Now နှိပ်၍ စောင့်ဆိုင်းနေသော ပြင်ဆင်မှုများ တင်ပါ။',
      },
    ],
    actions: [
      act('retry', 'retry', 'Try again', 'ပြန်ကြိုးစားရန်'),
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
    ],
  },
  {
    id: 'sync-error',
    keywords: [
      'sync',
      'cloud',
      'google sheet',
      'spreadsheet',
      'apps script',
      'upload',
      'စင့်',
      'ကလောဒ်',
      'google sheet',
    ],
    title: { en: 'Cloud sync problem', my: 'Cloud စင့် ပြဿနာ' },
    explanation: {
      en: 'Sync could not finish. Common causes: the Apps Script URL or token changed, the deployed web app needs re-authorizing, or another session is writing to the sheet right now. Your data is safe locally — sync only relays changes between devices.',
      my: 'စင့် မပြီးနိုင်ပါ။ အဖြစ်များသော အကြောင်းရင်း — Apps Script URL/token ပြောင်းသွားခြင်း၊ Web App ပြန်ခွင့်ပြုရန် လိုခြင်း၊ အခြားစက်တစ်ခုက တစ်ပြိုင်နက် ရေးနေခြင်း။ ဒေတာကို ဤစက်တွင် ဘေးကင်းစွာ သိမ်းထားသည်။',
    },
    steps: [
      {
        en: 'Open Settings → Data and press “Test connection” to check URL + token.',
        my: 'Settings → Data သို့သွား၍ “Test connection” နှိပ်ပါ။',
      },
      {
        en: 'If the token was rotated, paste the new one and save.',
        my: 'token ပြောင်းထားပါက အသစ်ကို ထည့်၍ သိမ်းပါ။',
      },
      {
        en: 'Press Sync Now — queued edits upload in order once the server responds.',
        my: 'Sync Now နှိပ်ပါ — ဆောင်ရွက်ဆဲ ပြင်ဆင်မှုများ အစဉ်လိုက် တင်သွားပါမည်။',
      },
    ],
    actions: [
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
      act('retry', 'retry', 'Sync now', 'စင့်လုပ်ရန်'),
      act('clear-cache', 'data', 'Clear cache', 'ကက်ရှ် ဖျက်ရန်'),
    ],
  },
  {
    id: 'cache',
    keywords: ['cache', 'clear cache', 'stale data', 'loaded wrong', 'ကက်ရှ်', 'cache ဖျက်'],
    title: { en: 'Cached data may be stale', my: 'ကက်ရှ်ဒေတာ ဟောင်းနေနိုင်သည်' },
    explanation: {
      en: 'The translation cache stores previous AI responses to save quota. If an answer looks wrong or outdated, clearing it forces fresh requests. Clearing the cache never deletes projects, pages or glossary entries.',
      my: 'ဘာသာပြန်ကက်ရှ်သည် အရင် AI အဖြေများကို သိမ်းထားပြီး quota သက်သာစေသည်။ အဖြေ မှား/ဟောင်းနေပါက ဖျက်ပြီး အသစ်တောင်းပါ။ ကက်ရှ်ဖျက်ခြင်းက စီမံကိန်း/စာမျက်နှာ/ဝေါဟာရ မဖျက်ပါ။',
    },
    steps: [
      {
        en: 'Press “Clear cache” here (or Settings → Cache → Clear all).',
        my: 'ဤနေရာမှ “Clear cache” နှိပ်ပါ (သို့ Settings → Cache)။',
      },
      {
        en: 'Re-run the translation and compare the new result.',
        my: 'ဘာသာပြန်မှု ပြန်လုပ်၍ ရလဒ်အသစ် နှိုင်းယှဉ်ကြည့်ပါ။',
      },
    ],
    actions: [
      act('clear-cache', 'data', 'Clear cache', 'ကက်ရှ် ဖျက်ရန်'),
      act('retry', 'retry', 'Retry the job', 'အလုပ် ပြန်ကြိုးစားရန်'),
    ],
  },
  {
    id: 'export',
    keywords: [
      'export',
      'download',
      'docx',
      'epub',
      'pdf export',
      'formatting',
      'ထုတ်ရန်',
      'download လုပ်',
      'ဖိုင်ထုတ်',
    ],
    title: { en: 'Export trouble', my: 'ထုတ်ယူရာတွင် ပြဿနာ' },
    explanation: {
      en: 'Exports are built locally in the browser. A missing font or a very large document can change layout slightly (styled runs reset on re-parse; PDF export goes through the print dialog). The text itself is never truncated.',
      my: 'ထုတ်ယူမှုကို ဘရောက်ဇာတွင် တည်ဆောက်သည်။ ဖောင့်မရှိပါက ပုံစံ ပြောင်းနိုင်သည် (စာသား မပျက်ပါ)။ PDF ထုတ်ယူမှုသည် ပုံနှိပ်စက်အဆင့်မှတစ်ဆင့် ဖြစ်သည်။',
    },
    steps: [
      {
        en: 'Re-run the export after the document finished translating.',
        my: 'ဘာသာပြန်ပြီးမှ ထုတ်ယူမှု ပြန်လုပ်ပါ။',
      },
      {
        en: 'Try DOCX first — it preserves runs and lists best; use PDF via Print → Save as PDF.',
        my: 'DOCX ကို ဦးစွာစမ်းပါ — PDF အတွက် Print → Save as PDF သုံးပါ။',
      },
      {
        en: 'If a font warning appears, pick a fallback font to keep the layout stable.',
        my: 'ဖောင့်သတိပေးချက် ပေါ်ပါက fallback ဖောင့် ရွေးပါ။',
      },
    ],
    actions: [
      act('retry', 'retry', 'Re-run export', 'ထုတ်ယူမှု ပြန်လုပ်ရန်'),
      act('open-logs', 'navigation', 'Open logs', 'မှတ်တမ်း ဖွင့်ရန်'),
    ],
  },
  {
    id: 'backup',
    keywords: [
      'backup',
      'restore',
      'import',
      'invalid backup',
      'မိတ္တူ',
      'ပြန်ဖွင့်',
      'backup ဖိုင်',
    ],
    title: { en: 'Backup file problem', my: 'မိတ္တူဖိုင် ပြဿနာ' },
    explanation: {
      en: 'The import validates the file’s format, schema version and checksum before touching any data — an invalid or truncated file is rejected without changing anything. Backups made by a newer app version may also be refused.',
      my: 'တင်သွင်းမှုသည် ဖိုင်ပုံစံ၊ schema ဗားရှင်းနှင့် checksum ကို အရင်စစ်သည် — မမှန်ကန်ပါက ဒေတာ မပြောင်းဘဲ ငြင်းဆိုသည်။ ဗားရှင်းအသစ်ဖြင့် ပြုလုပ်ထားသော မိတ္တူကိုလည်း ငြင်းနိုင်သည်။',
    },
    steps: [
      {
        en: 'Re-download or re-create the backup from the exporting device.',
        my: 'မိတ္တူဖိုင်ကို ပြန်ဒေါင်း သို့မဟုတ် ပြန်ဖန်တီးပါ။',
      },
      {
        en: 'Check the app version — both devices should run the same version.',
        my: 'အက်ပ်ဗားရှင်း တူကြောင်း စစ်ပါ။',
      },
      {
        en: 'Inspect the Logs page for the exact validation error.',
        my: 'Logs တွင် အသေးစိတ် အမှားကို ကြည့်ပါ။',
      },
    ],
    actions: [
      act('open-data', 'navigation', 'Open data settings', 'ဒေတာဆက်တင် ဖွင့်ရန်'),
      act('open-logs', 'navigation', 'Open logs', 'မှတ်တမ်း ဖွင့်ရန်'),
    ],
  },
  {
    id: 'conflict',
    keywords: [
      'conflict',
      'overwrote',
      'overwritten',
      'two devices',
      'which version',
      'ပဋိပက္ခ',
      'လွှမ်းမိုး',
      'စက်နှစ်ခု',
    ],
    title: { en: 'Two devices changed the same record', my: 'စက်နှစ်ခုက အတူတူ ပြောင်းထားသည်' },
    explanation: {
      en: 'Sync resolves this with last-write-wins: the copy with the newer timestamp survives and the loser is stored in the conflict log so nothing is lost silently. You can inspect the log and restore the losing version with one click.',
      my: 'စင့်က နောက်ဆုံးပြောင်းသူ အနိုင်ရစနစ်ဖြင့် ဖြေရှင်းသည် — အချိန်အသစ်ဆုံး ကျန်ရစ်ပြီး ရှုံးသူကို conflict log တွင် သိမ်းထားသည်။ Log တွင် ကြည့်၍ တစ်ချက်နှိပ်ပြန်ထားနိုင်သည်။',
    },
    steps: [
      {
        en: 'Open Settings → Data → Sync conflicts to see what changed.',
        my: 'Settings → Data → Sync conflicts တွင် ပြောင်းလဲမှု ကြည့်ပါ။',
      },
      {
        en: 'Press Restore on the losing side if you want that version back.',
        my: 'လိုချင်ပါက ရှုံးသူဘက် Restore နှိပ်ပါ။',
      },
      {
        en: 'Let Sync Now finish so both devices converge.',
        my: 'စက်နှစ်ခု တူညီစေရန် Sync Now ပြီးအောင်လုပ်ပါ။',
      },
    ],
    actions: [
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
      act('retry', 'retry', 'Sync now', 'စင့်လုပ်ရန်'),
    ],
  },
  {
    id: 'slow-batch',
    keywords: [
      'slow',
      'stuck',
      'hang',
      'taking forever',
      'too long',
      'batch',
      'လေးနှေး',
      'ရပ်နေ',
      'batch',
    ],
    title: { en: 'The job feels slow or stuck', my: 'အလုပ် နှေးနေ သို့မဟုတ် ရပ်နေသည်' },
    explanation: {
      en: 'Long documents translate in batches; a big batch can look stalled while one long request is in flight, and rate limits pause the queue automatically. Reducing the batch size trades a little extra overhead for steadier progress.',
      my: 'စာအုပ်ကြီးများကို အစုလိုက် ဘာသာပြန်သည် — အစုကြီးလျှင် တစ်ကြိမ်လုံး ပြန်မလာမီ ရပ်နေသည့်အလား ထင်ရပြီး rate limit ကြောင့် အလိုအလျောက် ရပ်တန့်သည်။ အစုလျှော့ထားပါက တိုးတက်မှု ပိုတည်ငြိမ်သည်။',
    },
    steps: [
      {
        en: 'Watch the Jobs tab — the current phase and progress update live.',
        my: 'Jobs တွင် အဆင့်နှင့် တိုးတက်မှု စောင့်ကြည့်ပါ။',
      },
      { en: 'Reduce the batch size, then resume the job.', my: 'အစု လျှော့ပြီး အလုပ်ဆက်လုပ်ပါ။' },
      {
        en: 'If it never finishes, cancel and retry — completed lines are kept.',
        my: 'မပြီးပါက ရပ်၍ ပြန်ကြိုးစားပါ — ပြီးပြီးသား စာကြောင်းများ မပျက်ပါ။',
      },
    ],
    actions: [
      act('reduce-batch', 'config', 'Reduce batch size', 'အစု လျှော့ရန်'),
      act('retry', 'retry', 'Retry now', 'ပြန်ကြိုးစားရန်'),
    ],
  },
  {
    id: 'model',
    keywords: ['model', 'model unavailable', 'gpt', 'claude', 'llama', 'gemini', 'မော်ဒယ်'],
    title: { en: 'The selected model is unavailable', my: 'ရွေးထားသော မော်ဒယ် မရနိုင်ပါ' },
    explanation: {
      en: 'The provider may have retired the model id, or your account cannot access it. Another model from the same provider usually works without changing anything else.',
      my: 'ပေးပို့သူက မော်ဒယ်အမည် ရပ်ထားခြင်း သို့မဟုတ် သင့်အကောင့်က ဝင်ခွင့်မရခြင်း ဖြစ်နိုင်သည်။ ထိုပေးပို့သူ၏ အခြားမော်ဒယ်တစ်ခု ပြောင်းရွေးကြည့်ပါ။',
    },
    steps: [
      {
        en: 'Open Settings → AI Providers and pick another model from the list.',
        my: 'Settings → AI Providers တွင် အခြားမော်ဒယ် ရွေးပါ။',
      },
      { en: 'Press Test to confirm the new model answers.', my: 'Test နှိပ်၍ အဖြေရှိ မရှိ စစ်ပါ။' },
      {
        en: 'Retry the job — already-translated lines are not re-sent.',
        my: 'ပြန်ကြိုးစားပါ — ပြီးပြီးသားစာ မပြန်ပို့ပါ။',
      },
    ],
    actions: [
      act('open-providers', 'navigation', 'Open AI Providers', 'AI Providers ဖွင့်ရန်'),
      act('retry', 'retry', 'Retry the job', 'အလုပ် ပြန်ကြိုးစားရန်'),
    ],
  },
  {
    id: 'storage-full',
    keywords: [
      'storage full',
      'storage quota',
      'not enough space',
      'disk full',
      'လုံလောက်',
      'သိမ်းဆည်းနေရာ',
      'ပြည့်သွား',
    ],
    title: { en: 'Local storage is full', my: 'ဒေတာသိမ်းဆည်းနေရာ ပြည့်သွားသည်' },
    explanation: {
      en: 'IndexedDB (where projects, translations and caches live) hit the browser quota. Old caches, finished jobs and archived projects are the usual consumers; deleting them frees space without losing active documents.',
      my: 'စီမံကိန်း/ဘာသာပြန်/ကက်ရှ် သိမ်းထားသော IndexedDB က ဘရောက်ဇာ ခွင့်ပြုချက် ပြည့်သွားသည်။ ဟောင်းကက်ရှ်၊ ပြီးပြီးသားအလုပ်နှင့် မိတ္တူဟောင်းများ ဖျက်၍ နေရာလွတ်နိုင်သည်။',
    },
    steps: [
      { en: 'Clear the cache in Settings → Cache.', my: 'Settings → Cache မှ ကက်ရှ် ဖျက်ပါ။' },
      {
        en: 'Delete finished jobs or archive old projects you no longer need.',
        my: 'ပြီးပြီးသားအလုပ်နှင့် မလိုတော့သော စီမံကိန်းဟောင်း ဖျက်/သိမ်းပါ။',
      },
      {
        en: 'Export an archive of old projects before deleting them.',
        my: 'မဖျက်မီ ဟောင်းစီမံကိန်း မိတ္တူ အရင်ထုတ်ပါ။',
      },
    ],
    actions: [
      act('clear-cache', 'data', 'Clear cache', 'ကက်ရှ် ဖျက်ရန်'),
      act('open-data', 'navigation', 'Open data settings', 'ဒေတာဆက်တင် ဖွင့်ရန်'),
    ],
  },
]

/* -------------------------------------------------------------------------- */
/* Sync / HTTP error codes                                                    */
/* -------------------------------------------------------------------------- */

const SYNC_CODE_RULES: Record<string, Rule> = {
  UNAUTHORIZED: {
    id: 'sync-unauthorized',
    keywords: [],
    title: { en: 'The sync token was rejected', my: 'စင့် token ငြင်းဆိုခံရသည်' },
    explanation: {
      en: 'The spreadsheet refused the request because the shared token does not match the one stored in Script Properties. This happens after rotating the token or when the deployment URL points at a different script.',
      my: 'ဝေမျှထားသော token နှင့် Script Properties ထဲမှ token မတူသောကြောင့် Spreadsheet က ငြင်းဆိုသည်။ token ပြောင်းပြီး သို့မဟုတ် URL မှားသွားလျှင် ဖြစ်တတ်သည်။',
    },
    steps: [
      {
        en: 'Copy the token you set in Script Properties (Apps Script editor → Project Settings).',
        my: 'Script Properties ထဲတွင် သတ်မှတ်ထားသော tokenကို ကူးပါ။',
      },
      {
        en: 'Paste it in Settings → Data → Access token and save.',
        my: 'Settings → Data → Access token တွင် ပွတ်၍ သိမ်းပါ။',
      },
      {
        en: 'Press Test connection, then Sync Now.',
        my: 'Test connection ပြီး၍ Sync Now နှိပ်ပါ။',
      },
    ],
    actions: [
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
      act('retry', 'retry', 'Test and sync', 'စမ်း၍ စင့်ရန်'),
    ],
  },
  NOT_CONFIGURED: {
    id: 'sync-not-configured',
    keywords: [],
    title: { en: 'Cloud sync is not set up', my: 'Cloud စင့် မပြင်ရသေးပါ' },
    explanation: {
      en: 'No Apps Script URL and/or access token is stored, so sync has nothing to talk to. Local editing, export and backups keep working without it.',
      my: 'Apps Script URL နှင့်/သို့ token မသိမ်းထားသောကြောင့် စင့်လုပ်၍ မရပါ။ ဒေတာသိမ်းခြင်း၊ ထုတ်ယူခြင်းနှင့် မိတ္တူများကို ဆက်လုပ်နိုင်သည်။',
    },
    steps: [
      {
        en: 'Deploy the Apps Script web app and copy its /exec URL.',
        my: 'Apps Script Web App တင်၍ /exec URL ကူးပါ။',
      },
      {
        en: 'Paste the URL and shared token in Settings → Data.',
        my: 'URL နှင့် ဝေမျှ token ကို Settings → Data တွင် ထည့်ပါ။',
      },
      {
        en: 'Enable cloud sync and press Test connection.',
        my: 'Cloud စင့် ဖွင့်၍ Test connection နှိပ်ပါ။',
      },
    ],
    actions: [act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်')],
  },
  NETWORK: {
    id: 'sync-network',
    keywords: [],
    title: { en: 'Cannot reach the sync backend', my: 'စင့်ဆာဗာသို့ မရောက်ပါ' },
    explanation: {
      en: 'The request to Apps Script failed — usually no network, a blocked domain, or the deployment URL is wrong. Queued changes stay in the outbox and upload automatically after reconnecting.',
      my: 'Apps Script သို့ တောင်းဆိုမှု မအောင်မြင်ပါ — ကွန်ရက်မရှိခြင်း သို့ မှားသော URL ဖြစ်နိုင်သည်။ စောင့်ဆိုင်းပြင်ဆင်မှုများ outbox တွင် ကျန်ပြီး ချိတ်ပြီးလျှင် အလိုအလျောက် တင်သွားမည်။',
    },
    steps: [
      { en: 'Check the internet connection and retry.', my: 'အင်တာနက် စစ်ပြီး ပြန်ကြိုးစားပါ။' },
      {
        en: 'Confirm script.google.com is not blocked by a proxy or firewall.',
        my: 'script.google.com ပိတ်မခံထားရ စစ်ပါ။',
      },
      {
        en: 'Press Sync Now again — pending rows retry automatically.',
        my: 'Sync Now ပြန်နှိပ်ပါ — ကျန်ရှိသည်များ အလိုအလျောက်ပြန်ကြိုးစားမည်။',
      },
    ],
    actions: [
      act('retry', 'retry', 'Try sync again', 'စင့်ပြန်ကြိုးစားရန်'),
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
    ],
  },
  TIMEOUT: {
    id: 'sync-timeout',
    keywords: [],
    title: { en: 'The sync request timed out', my: 'စင့် တောင်းဆိုမှု အချိန်ကုန်သွားသည်' },
    explanation: {
      en: 'Apps Script did not answer in time — a cold start or a long-running write can take up to half a minute. Nothing was lost; the run simply resumes on the next attempt.',
      my: 'Apps Script အချိန်မီ မပြန်ပါ — ပထမဆုံးအကြိမ် စတင်ခြင်း သို့ ရှည်သောရေးသားမှုက ကြာတတ်သည်။ ဒေတာ မဆုံးရှုံးဘဲ နောက်တစ်ကြိမ် ဆက်လုပ်ပါမည်။',
    },
    steps: [
      {
        en: 'Wait 30 seconds and press Sync Now again.',
        my: '၃၀ စက္ကန့် စောင့်ပြီး Sync Now ပြန်နှိပ်ပါ။',
      },
      {
        en: 'If it repeats, split large pushes by turning settings sync off temporarily.',
        my: 'မကြာခဏဖြစ်ပါက settings sync ယာယီပိတ်၍ တွန်းပို့ ခွဲလုပ်ပါ။',
      },
    ],
    actions: [
      act('retry', 'retry', 'Retry sync', 'စင့်ပြန်ကြိုးစားရန်'),
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
    ],
  },
  LOCK_TIMEOUT: {
    id: 'sync-lock',
    keywords: [],
    title: { en: 'Another session is syncing right now', my: 'အခြား session တစ်ခု စင့်လုပ်နေသည်' },
    explanation: {
      en: 'Apps Script locks the spreadsheet while writing so two browsers cannot interleave. The lock is released within 30 seconds even if the other session disappears.',
      my: 'ရေးနေစဉ် Spreadsheet ကို လော့ခ်ထားပြီး စက်နှစ်ခု တစ်ပြိုင်နက် မရေးစေပါ။ အခြား session ပျောက်သွားလည်း ၃၀ စက္ကန့်အတွင်း လော့ခ်ဖြေသည်။',
    },
    steps: [
      {
        en: 'Wait about 30 seconds, then press Sync Now again.',
        my: '၃၀ စက္ကန့်ခန့် စောင့်ပြီး Sync Now ပြန်နှိပ်ပါ။',
      },
      {
        en: 'Close the sync tab on the other device if it is no longer needed.',
        my: 'မလိုတော့ပါက အခြားစက်ရှိ tab ကို ပိတ်ပါ။',
      },
    ],
    actions: [act('retry', 'retry', 'Retry sync', 'စင့်ပြန်ကြိုးစားရန်')],
  },
  SECRET_NOT_ALLOWED: {
    id: 'sync-secret',
    keywords: [],
    title: {
      en: 'A secret-looking setting was blocked',
      my: 'လျှို့ဝှက်ပုံစံ setting ကို ပိတ်ခံရသည်',
    },
    explanation: {
      en: 'The server refuses to store any setting whose name looks like a key, token or password — this is what keeps credentials out of the spreadsheet. Remove or rename that setting and sync again.',
      my: 'သော့/token/စကားဝှက်နာမည်နှင့် တူသော setting ကို ဆာဗာက မသိမ်းပါ — spreadsheet ထဲ လျှို့ဝှက်ချက်မရောက်စေရန်။ ထို setting ကို ဖယ်/ပြန်နာမည်ပြောင်းပြီး ပြန်စမ်းပါ။',
    },
    steps: [
      {
        en: 'Open Settings → Data and check which value was pushed last.',
        my: 'Settings → Data တွင် နောက်ဆုံးတင်သော value ကို စစ်ပါ။',
      },
      {
        en: 'Rename or remove settings with “key/token/secret/password” in the name.',
        my: 'နာမည်ထဲ “key/token/secret/password” ပါသော setting ကို ပြောင်း/ဖယ်ပါ။',
      },
      {
        en: 'Retry sync — the app already filters known secret settings automatically.',
        my: 'ပြန်စမ်းပါ — app က secret setting များကို အလိုအလျောက် စစ်ထုတ်ပြီးဖြစ်သည်။',
      },
    ],
    actions: [
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
      act('retry', 'retry', 'Retry sync', 'စင့်ပြန်ကြိုးစားရန်'),
    ],
  },
  BAD_RESPONSE: {
    id: 'sync-bad-response',
    keywords: [],
    title: {
      en: 'The sync backend answered unexpectedly',
      my: 'စင့်ဆာဗာမှ မမျှော်လင့်သော အဖြေ ပြန်သည်',
    },
    explanation: {
      en: 'The response was not valid JSON — often an Apps Script error page, a wrong URL (the /exec endpoint), or an interstitial from the network.',
      my: 'အဖြေက JSON မဟုတ်ပါ — Apps Script အမှားစာမျက်နှာ၊ URL မှားခြင်း (/exec endpoint) သို့ ကွန်ရက်၏ ကြားခံစာမျက်နှာ ဖြစ်တတ်သည်။',
    },
    steps: [
      {
        en: 'Confirm the URL ends with /exec (Deploy → Web app → Web app URL).',
        my: 'URL က /exec ဖြင့် ပြီးကြောင်း စစ်ပါ။',
      },
      {
        en: 'Re-deploy as “Execute as me / Anyone” and copy the new URL.',
        my: '“Execute as me / Anyone” ဖြင့် ပြန်တင်၍ URL အသစ် ကူးပါ။',
      },
      {
        en: 'Press Test connection to verify the endpoint.',
        my: 'Test connection ဖြင့် endpoint စစ်ပါ။',
      },
    ],
    actions: [
      act('open-data', 'navigation', 'Open sync settings', 'စင့်ဆက်တင် ဖွင့်ရန်'),
      act('retry', 'retry', 'Test connection', 'ချိတ်ဆက်မှုစမ်းရန်'),
    ],
  },
  INTERNAL: {
    id: 'sync-internal',
    keywords: [],
    title: {
      en: 'The spreadsheet reported an internal error',
      my: 'Spreadsheet တွင် အတွင်းပိုင်းအမှား ဖြစ်သည်',
    },
    explanation: {
      en: 'The script hit an unexpected failure while reading or writing a sheet — often a renamed sheet tab, a locked cell, or a transient quota hiccup. Sheets are recreated by the health check if they are missing.',
      my: 'စာရင်းအလွတ် ရေး/ဖတ်စဉ် မမျှော်လင့်သော အမှား ဖြစ်သည် — tab ပြောင်းခြင်း၊ cell lock သို့ quota ပြဿနာ ဖြစ်တတ်သည်။ ပျောက်ပါက health check က ပြန်ဖန်တီးပေးသည်။',
    },
    steps: [
      {
        en: 'Open the spreadsheet and check the tab names match the defaults.',
        my: 'Spreadsheet ဖွင့်၍ tab အမည်များ စစ်ပါ။',
      },
      {
        en: 'Re-run Test connection — it recreates missing sheets automatically.',
        my: 'Test connection ပြန်လုပ်ပါ — ပျောက်သော sheet အလိုအလျောက်ပြန်ဖန်တီးသည်။',
      },
      {
        en: 'Retry the sync; partial pushes resume where they stopped.',
        my: 'ပြန်စမ်းပါ — တစ်ဝက်တင်ထားသည် ဆက်တင်ပါမည်။',
      },
    ],
    actions: [
      act('retry', 'retry', 'Retry sync', 'စင့်ပြန်ကြိုးစားရန်'),
      act('open-logs', 'navigation', 'Open logs', 'မှတ်တမ်း ဖွင့်ရန်'),
    ],
  },
}

/* -------------------------------------------------------------------------- */
/* Reason-code explanations                                                   */
/* -------------------------------------------------------------------------- */

type Localized = { en: string; my: string }

const REASON_EXTRAS: Partial<Record<ReasonCode, { explanation: Localized; steps: Localized[] }>> = {
  NO_API_KEY: {
    explanation: {
      en: 'No provider key has been added yet, so translation cannot start. Add one in Settings → AI Providers — it is encrypted and stored only on this device.',
      my: 'ပေးပို့သူသော့ မထည့်ရသေးသောကြောင့် ဘာသာပြန်၍ မရပါ။ Settings → AI Providers တွင် ထည့်ပါ — ဒီစက်တွင်သာ သိမ်းသည်။',
    },
    steps: [
      { en: 'Open Settings → AI Providers.', my: 'Settings → AI Providers ဖွင့်ပါ။' },
      {
        en: 'Add a key for the provider you want and press Test.',
        my: 'လိုချင်သော ပေးပို့သူအတွက် သော့ထည့်၍ Test နှိပ်ပါ။',
      },
      {
        en: 'Select the provider and model, then retry the job.',
        my: 'ပေးပို့သူနှင့် မော်ဒယ် ရွေးပြီး ပြန်ကြိုးစားပါ။',
      },
    ],
  },
  QUOTA_EXHAUSTED: {
    explanation: {
      en: 'The provider counted your requests against its limit. The pool cools keys down automatically; you can also reduce the batch size so usage spreads out over time.',
      my: 'ပေးပို့သူ၏ အသုံးပြုမှု ကန့်သတ်ချက် ပြည့်သွားသည်။ စနစ်က သော့များကို အအေးခံစေပြီး အစုလျှော့၍လည်း သုံးစွဲမှု ဖြန့်နိုင်သည်။',
    },
    steps: [
      {
        en: 'Wait for the cooldown or add a second key to spread the load.',
        my: 'အအေးခံချိန် စောင့်ပါ သို့ ဒုတိယသော့ ထည့်ပါ။',
      },
      {
        en: 'Reduce the batch size in Settings → AI Providers.',
        my: 'Settings → AI Providers တွင် အစု လျှော့ပါ။',
      },
      {
        en: 'Retry once the window resets (usually one minute or one day).',
        my: 'ကာလပြန်ဖွင့်ပြီးမှ (မိနစ်/ရက်) ပြန်ကြိုးစားပါ။',
      },
    ],
  },
  NETWORK_OFFLINE: {
    explanation: {
      en: 'The device is offline. Work is paused, not lost — everything is written to local storage and resumes when the connection returns.',
      my: 'စက် အော့ဖ်လိုင်းဖြစ်နေသည်။ အလုပ်ရပ်သော်လည်း ဆုံးရှုံးမည် မဟုတ်ပါ — ဒေတာဘန်းတွင် သိမ်းထားပြီး ချိတ်ပြီးလျှင် ဆက်လုပ်မည်။',
    },
    steps: [
      { en: 'Restore the internet connection.', my: 'အင်တာနက် ပြန်ချိတ်ပါ။' },
      {
        en: 'The queue resumes automatically; no manual restart is needed.',
        my: 'စာရင်းက အလိုအလျောက် ဆက်သွားမည်။',
      },
    ],
  },
  SYNC_FAILED: {
    explanation: {
      en: 'A sync cycle failed. The reason is usually in the status line next to the Sync Now button or in the Logs page; local data is unaffected and retries are automatic.',
      my: 'စင့်တစ်ခု မအောင်မြင်ပါ။ အကြောင်းရင်းကို Sync Now ဘေး status သို့ Logs တွင် ကြည့်နိုင်သည် — ဒေတာ မထိခိုက်ဘဲ အလိုအလျောက် ပြန်ကြိုးစားသည်။',
    },
    steps: [
      {
        en: 'Press Test connection in Settings → Data.',
        my: 'Settings → Data တွင် Test connection နှိပ်ပါ။',
      },
      {
        en: 'Check the sync status line for the error code.',
        my: 'sync status တွင် အမှားကုဒ် ကြည့်ပါ။',
      },
      {
        en: 'Press Sync Now once the connection is healthy.',
        my: 'ချိတ်ဆက်ရန်ကောင်းပြီး Sync Now နှိပ်ပါ။',
      },
    ],
  },
  INVALID_KEY: {
    explanation: {
      en: 'The provider rejected this key. It may have been revoked, pasted with extra spaces, or belong to a different provider than the one selected.',
      my: 'ပေးပို့သူက ဤသော့ကို ငြင်းဆိုသည် — ပယ်ဖျက်ထားခြင်း၊ ပွတ်ရာတွင် နေရာလွတ်ပါခြင်း သို့ မတူသော ပေးပို့သားသော့ ဖြစ်နိုင်သည်။',
    },
    steps: [
      {
        en: 'Re-copy the key from the provider dashboard without extra spaces.',
        my: 'ပေးပို့သူ dashboard မှ နေရာလွတ်မပါဘဲ ပြန်ကူးပါ။',
      },
      {
        en: 'Paste it into Settings → AI Providers and press Test.',
        my: 'Settings → AI Providers တွင် ပွတ်၍ Test နှိပ်ပါ။',
      },
      {
        en: 'Rotate the key on the provider side if it was exposed somewhere.',
        my: 'နေရာတစ်ခုတွင် ပေါ်သွားပါက ပေးပို့သူဘက်တွင် ပြောင်းပါ။',
      },
    ],
  },
  STORAGE_QUOTA_EXCEEDED: {
    explanation: {
      en: 'The browser storage quota is full. Caches and finished jobs are safe to delete; export or back up projects before removing them.',
      my: 'ဘရောက်ဇာ သိမ်းဆည်းနေရာ ပြည့်သွားသည်။ ကက်ရှ်နှင့် ပြီးပြီးသားအလုပ် ဖျက်နိုင်သည် — မဖျက်မီ မိတ္တူအရင်ထုတ်ပါ။',
    },
    steps: [
      { en: 'Clear the cache (Settings → Cache).', my: 'ကက်ရှ် ဖျက်ပါ (Settings → Cache)။' },
      { en: 'Delete finished jobs from the Jobs tab.', my: 'Jobs တွင် ပြီးပြီးသားအလုပ် ဖျက်ပါ။' },
      {
        en: 'Archive or export old projects, then delete them.',
        my: 'ဟောင်းစီမံကိန်း မိတ္တူထုတ်၍ ဖျက်ပါ။',
      },
    ],
  },
  MODEL_UNAVAILABLE: {
    explanation: {
      en: 'The model id selected is not available on the provider right now (retired, region-locked, or no access for this key).',
      my: 'ရွေးထားသော မော်ဒယ်ကို ပေးပို့သူတွင် လက်ရှိ မရနိုင်ပါ (ရပ်ထားခြင်း/ဝင်ခွင့်မရ)။',
    },
    steps: [
      {
        en: 'Pick another model in Settings → AI Providers.',
        my: 'Settings → AI Providers တွင် အခြားမော်ဒယ် ရွေးပါ။',
      },
      { en: 'Press Test, then retry the job.', my: 'Test နှိပ်ပြီး ပြန်ကြိုးစားပါ။' },
    ],
  },
  BAD_JSON_RESPONSE: {
    explanation: {
      en: 'The model replied with text the app could not parse as structured JSON (often truncated output or an apology message instead of data).',
      my: 'မော်ဒယ်ပြန်သော စာသားကို app က JSON အဖြေအဖြစ် မဖတ်နိုင်ပါ (များသောအားဖြင့် ဖြတ်တောက်သွားခြင်း)။',
    },
    steps: [
      {
        en: 'Retry — a fresh request usually parses correctly.',
        my: 'ပြန်ကြိုးစားပါ — အသစ်တောင်းလျှင် များသောအားဖြင့် ဖတ်နိုင်သည်။',
      },
      { en: 'Reduce the batch size so responses stay short.', my: 'အဖြေတိုစေရန် အစု လျှော့ပါ။' },
      {
        en: 'Switch to a model that is known to follow JSON instructions.',
        my: 'JSON လိုက်နာသော မော်ဒယ် ပြောင်းပါ။',
      },
    ],
  },
}

const FALLBACK_STEPS: Localized[] = [
  {
    en: 'Open the Logs page — every failure there carries a reason code and fix buttons.',
    my: 'Logs စာမျက်နှာ ဖွင့်ပါ — အမှားတိုင်းတွင် reason code နှင့် ဖြေရှင်းခလုတ် ပါသည်။',
  },
  {
    en: 'Retry the last action once; if it fails again, read the newest log entry.',
    my: 'နောက်ဆုံးလုပ်ခဲ့သည်ကို တစ်ချက် ပြန်ကြိုးစားပါ၊ ထပ်မအောင်ပါက နောက်ဆုံး log ကို ဖတ်ပါ။',
  },
]

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

const FALLBACK_TITLE: Localized = {
  en: 'Here is how to approach this',
  my: 'ဤနည်းလမ်းဖြင့် ကြိုးစားကြည့်ပါ',
}

const FALLBACK_EXPLANATION: Localized = {
  en: 'I could not match this to a known error, so here is the general playbook: reproduce the problem, check the Logs page for a reason code, then apply the suggested fix. If you reconnect the assistant proxy, answers can be generated by the AI model instead.',
  my: 'ဤအမှားကို အသိအမှတ်ပြု၍ မရသေးသောကြောင့် ယေဘုယျနည်းလမ်း ပေးပါသည် — ပြန်ဖန်တီးကြည့်ပါ၊ Logs တွင် reason code စစ်ပါ၊ ပြီးလျှင် အကြံပြုချက်အတိုင်း လုပ်ပါ။ Assistant proxy ပြန်ချိတ်ပါက AI မှ ဖြေကြားပေးပါမည်။',
}

function pick<T>(lang: AssistantLang, value: { en: T; my: T }): T {
  return lang === 'my' ? value.my : value.en
}

function toAnswer(rule: Rule, lang: AssistantLang): AssistantAnswer {
  return {
    title: pick(lang, rule.title),
    explanation: pick(lang, rule.explanation),
    steps: rule.steps.map((step) => pick(lang, step)),
    actions: rule.actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      label: pick(lang, action.label),
    })),
  }
}

function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').trim()
}

function matchKeywordRule(question: string): Rule | null {
  const q = normalizeQuestion(question)
  if (!q) return null
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => q.includes(keyword))) return rule
  }
  return null
}

function answerForReasonCode(code: ReasonCode, lang: AssistantLang): AssistantAnswer {
  const definition = REASON_CODES[code]
  const extra = REASON_EXTRAS[code]
  const explanation = extra?.explanation ?? {
    en: `${definition.messageEn} (${definition.technicalHint})`,
    my: `${definition.messageMy} (${definition.technicalHint})`,
  }
  const steps = extra?.steps ?? FALLBACK_STEPS
  const actions: AssistantAction[] = definition.fixActions.slice(0, 3).map((fix) => ({
    id: mapFixActionId(fix.id),
    kind: fix.kind === 'external' ? 'external' : fix.kind === 'dismiss' ? 'navigation' : fix.kind,
    label: lang === 'my' ? fix.labelMy : fix.labelEn,
  }))
  if (actions.length === 0) {
    actions.push({
      id: 'open-logs',
      kind: 'navigation',
      label: pick(lang, { en: 'Open logs', my: 'မှတ်တမ်း ဖွင့်ရန်' }),
    })
  }
  return {
    title: lang === 'my' ? definition.messageMy : definition.messageEn,
    explanation: pick(lang, explanation),
    steps: steps.map((step) => pick(lang, step)),
    actions,
  }
}

/**
 * Catalogue fix-action ids are UI-neutral (`open_file_again`, …). Map them
 * onto the safe-action vocabulary the dialog can actually execute; anything
 * unmappable becomes `open-logs` (harmless navigation).
 */
function mapFixActionId(id: string): SafeActionId {
  if (id.includes('provider') || id.includes('key') || id.includes('model')) return 'open-providers'
  if (id.includes('settings') || id.includes('data')) return 'open-data'
  if (id.includes('sync') || id.includes('cloud')) return 'open-data'
  if (id.includes('cache')) return 'clear-cache'
  if (id.includes('retry') || id.includes('run') || id.includes('again')) return 'retry'
  return 'open-logs'
}

/**
 * The offline engine. Never throws — there is always a usable answer.
 *
 * @param question User text (may be empty when opened from a failure banner).
 * @param context  Redacted structured context; drives the code-based rules.
 * @param lang     'en' | 'my'.
 */
export function ruleAnswer(
  question: string,
  context: AssistantContext,
  lang: AssistantLang,
): AssistantAnswer {
  const trimmed = question.trim()

  if (trimmed) {
    const keywordRule = matchKeywordRule(trimmed)
    if (keywordRule) return toAnswer(keywordRule, lang)
  }

  if (context.errorCode && SYNC_CODE_RULES[context.errorCode]) {
    return toAnswer(SYNC_CODE_RULES[context.errorCode], lang)
  }
  if (context.reasonCode && REASON_CODES[context.reasonCode]) {
    return answerForReasonCode(context.reasonCode, lang)
  }

  // Last resort: the newest remembered failure may still carry a code.
  if (trimmed) {
    const lower = trimmed.toLowerCase()
    const syncCode = Object.keys(SYNC_CODE_RULES).find((code) => lower.includes(code.toLowerCase()))
    if (syncCode) return toAnswer(SYNC_CODE_RULES[syncCode], lang)
  }

  return {
    title: pick(lang, FALLBACK_TITLE),
    explanation: pick(lang, FALLBACK_EXPLANATION),
    steps: FALLBACK_STEPS.map((step) => pick(lang, step)),
    actions: [
      {
        id: 'open-logs',
        kind: 'navigation',
        label: pick(lang, { en: 'Open logs', my: 'မှတ်တမ်း ဖွင့်ရန်' }),
      },
      {
        id: 'retry',
        kind: 'retry',
        label: pick(lang, { en: 'Retry the last action', my: 'နောက်ဆုံးအလုပ် ပြန်ကြိုးစားရန်' }),
      },
      {
        id: 'clear-cache',
        kind: 'data',
        label: pick(lang, { en: 'Clear cache', my: 'ကက်ရှ် ဖျက်ရန်' }),
      },
    ],
  }
}

/** Rule ids exposed for tests / diagnostics. */
export const OFFLINE_RULE_IDS: string[] = [
  ...KEYWORD_RULES.map((rule) => rule.id),
  ...Object.keys(SYNC_CODE_RULES),
]
