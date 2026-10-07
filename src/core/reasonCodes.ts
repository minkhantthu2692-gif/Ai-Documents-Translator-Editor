/**
 * Reason-code catalogue.
 *
 * Every failure or notable state transition in the app resolves to one of these
 * codes. Each code carries a Burmese message, an English message, a severity and
 * a list of concrete fix actions that the UI can render as buttons/links.
 */

export type ReasonCode =
  | 'PDF_ENCRYPTED'
  | 'PDF_CORRUPTED'
  | 'NO_TEXT_LAYER'
  | 'NO_API_KEY'
  | 'INVALID_KEY'
  | 'ALL_KEYS_COOLING_DOWN'
  | 'QUOTA_EXHAUSTED'
  | 'NETWORK_OFFLINE'
  | 'MODEL_UNAVAILABLE'
  | 'BAD_JSON_RESPONSE'
  | 'OCR_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'EXPORT_FONT_MISSING'
  | 'SYNC_FAILED'
  | 'BACKUP_INVALID'
  | 'INVALID_STATE_TRANSITION'

export type Severity = 'info' | 'success' | 'warning' | 'error' | 'critical'

export type FixActionKind = 'retry' | 'config' | 'navigation' | 'data' | 'external' | 'dismiss'

export interface FixAction {
  id: string
  kind: FixActionKind
  labelMy: string
  labelEn: string
}

export interface ReasonCodeDefinition {
  code: ReasonCode
  severity: Severity
  messageMy: string
  messageEn: string
  /** Technical detail used for the log inspector; not shown as primary copy. */
  technicalHint: string
  fixActions: FixAction[]
}

const act = (id: string, kind: FixActionKind, labelEn: string, labelMy: string): FixAction => ({
  id,
  kind,
  labelEn,
  labelMy,
})

export const REASON_CODES: Record<ReasonCode, ReasonCodeDefinition> = {
  PDF_ENCRYPTED: {
    code: 'PDF_ENCRYPTED',
    severity: 'error',
    messageMy: 'ဤ PDF သည် စကားဝှက်ဖြင့် ကာကွယ်ထားသည်။',
    messageEn: 'This PDF is protected by a password.',
    technicalHint: 'pdf.js PasswordException / isEncrypted flag',
    fixActions: [
      act('open_file_again', 'retry', 'Open another file', 'တစ်ခြားဖိုင် ပြန်ဖွင့်ရန်'),
      act('enter_password', 'config', 'Enter PDF password', 'PDF စကားဝှက် ထည့်ရန်'),
    ],
  },
  PDF_CORRUPTED: {
    code: 'PDF_CORRUPTED',
    severity: 'error',
    messageMy: 'PDF ဖိုင် ပျက်စီးနေသည် သို့မဟုတ် မဖတ်နိုင်ပါ။',
    messageEn: 'The PDF file is corrupted or unreadable.',
    technicalHint: 'pdf.js InvalidPDFException',
    fixActions: [
      act('re_export_pdf', 'data', 'Re-export the PDF', 'PDF ကို ပြန်ထုတ်ရန်'),
      act('open_file_again', 'retry', 'Try another file', 'တစ်ခြားဖိုင် စမ်းကြည့်ရန်'),
    ],
  },
  NO_TEXT_LAYER: {
    code: 'NO_TEXT_LAYER',
    severity: 'warning',
    messageMy: 'ဤစာမျက်နှာတွင် စာသားအလွှာ မရှိပါ — OCR လိုအပ်ပါသည်။',
    messageEn: 'This page has no text layer — OCR is required.',
    technicalHint: 'getTextContent() returned 0 items',
    fixActions: [
      act('run_ocr', 'retry', 'Run OCR', 'OCR စတင်ရန်'),
      act('skip_page', 'dismiss', 'Skip this page', 'ဤစာမျက်နှာ ကျော်ရန်'),
    ],
  },
  NO_API_KEY: {
    code: 'NO_API_KEY',
    severity: 'error',
    messageMy: 'ဘာသာပြန်ရန် AI သော့ မထည့်ရသေးပါ။',
    messageEn: 'No AI API key has been added yet.',
    technicalHint: 'apiKeys table returned no active key for provider',
    fixActions: [
      act('add_key', 'navigation', 'Add API key', 'API သော့ ထည့်ရန်'),
      act('open_settings', 'navigation', 'Open Settings', 'ဆက်တင်များ ဖွင့်ရန်'),
    ],
  },
  INVALID_KEY: {
    code: 'INVALID_KEY',
    severity: 'error',
    messageMy: 'AI သော့ မမှန်ကန်ပါ သို့မဟုတ် ပယ်ဖျက်ခံရသည်။',
    messageEn: 'The AI key is invalid or was rejected by the provider.',
    technicalHint: 'HTTP 401 / 403 from provider endpoint',
    fixActions: [
      act('replace_key', 'config', 'Replace the key', 'သော့ အသစ်လဲရန်'),
      act('check_key', 'external', 'Check key on provider site', 'ပေးပို့သူ၌ သော့ စစ်ရန်'),
    ],
  },
  ALL_KEYS_COOLING_DOWN: {
    code: 'ALL_KEYS_COOLING_DOWN',
    severity: 'warning',
    messageMy: 'သော့အားလုံး အအေးခံနေသည် — ခဏစောင့်ပြီး ပြန်စမ်းပါ။',
    messageEn: 'All keys are cooling down — wait a moment and retry.',
    technicalHint: 'every candidate key has cooldownUntil > now',
    fixActions: [
      act('wait_retry', 'retry', 'Retry later', 'နောက်မှ ပြန်စမ်းရန်'),
      act('add_key', 'config', 'Add another key', 'တစ်ခြားသော့ ထည့်ရန်'),
    ],
  },
  QUOTA_EXHAUSTED: {
    code: 'QUOTA_EXHAUSTED',
    severity: 'warning',
    messageMy: 'AI အသုံးပြုခွင့် လိုင်းပြည့်သွားပါပြီ။',
    messageEn: 'The AI quota or rate limit has been exhausted.',
    technicalHint: 'HTTP 429 / quota_exceeded response',
    fixActions: [
      act('wait_retry', 'retry', 'Retry after reset', 'ပြန်လည်သတ်မှတ်ပြီး စမ်းရန်'),
      act('switch_provider', 'config', 'Switch provider', 'ပေးပို့သူ ပြောင်းရန်'),
    ],
  },
  NETWORK_OFFLINE: {
    code: 'NETWORK_OFFLINE',
    severity: 'warning',
    messageMy: 'အင်တာနက် မချိတ်ထားပါ — အလုပ်ကို ရပ်ထားသည်။',
    messageEn: 'You are offline — the job is paused.',
    technicalHint: 'navigator.onLine === false',
    fixActions: [
      act('retry_when_online', 'retry', 'Retry when online', 'အွန်လိုင်းရောက်ရင် ပြန်စမ်းရန်'),
      act('open_docs', 'navigation', 'Continue offline work', 'အော့ဖ်လိုင်း ဆက်လုပ်ရန်'),
    ],
  },
  MODEL_UNAVAILABLE: {
    code: 'MODEL_UNAVAILABLE',
    severity: 'error',
    messageMy: 'ရွေးချယ်ထားသော မော်ဒယ် မရနိုင်ပါ။',
    messageEn: 'The selected model is unavailable.',
    technicalHint: 'HTTP 404 / model_not_found',
    fixActions: [
      act('choose_model', 'config', 'Choose another model', 'တစ်ခြားမော်ဒယ် ရွေးရန်'),
      act('retry', 'retry', 'Retry', 'ပြန်စမ်းရန်'),
    ],
  },
  BAD_JSON_RESPONSE: {
    code: 'BAD_JSON_RESPONSE',
    severity: 'error',
    messageMy: 'AI မှ မှန်ကန်သော အဖြေ မပြန်ပါ။',
    messageEn: 'The AI returned a malformed response.',
    technicalHint: 'JSON.parse failed / schema validation failed',
    fixActions: [
      act('retry', 'retry', 'Retry request', 'တောင်းဆိုမှု ပြန်လုပ်ရန်'),
      act('reduce_context', 'config', 'Reduce context size', 'အကြောင်းအရာ လျှော့ရန်'),
    ],
  },
  OCR_FAILED: {
    code: 'OCR_FAILED',
    severity: 'error',
    messageMy: 'OCR စာမျက်နှာ ဖတ်၍မရပါ။',
    messageEn: 'OCR could not read this page.',
    technicalHint: 'tesseract.js worker error / empty recognition result',
    fixActions: [
      act('retry_ocr', 'retry', 'Run OCR again', 'OCR ပြန်လုပ်ရန်'),
      act('type_manually', 'data', 'Type text manually', 'စာသား လက်ဖြင့် ရိုက်ရန်'),
    ],
  },
  STORAGE_QUOTA_EXCEEDED: {
    code: 'STORAGE_QUOTA_EXCEEDED',
    severity: 'critical',
    messageMy: 'စက်၏ သိမ်းဆည်းနေရာ ပြည့်သွားပါပြီ။',
    messageEn: 'Local storage quota has been exceeded.',
    technicalHint: 'QuotaExceededError from IndexedDB transaction',
    fixActions: [
      act('clear_cache', 'data', 'Clear caches', 'ကက်ရှ် ဖျက်ရန်'),
      act('delete_old_projects', 'data', 'Delete old projects', 'ယခင်စီမံကိန်းများ ဖျက်ရန်'),
    ],
  },
  EXPORT_FONT_MISSING: {
    code: 'EXPORT_FONT_MISSING',
    severity: 'warning',
    messageMy: 'စာသားအတွက် လိုအပ်သော ဖောင့် မတွေ့ပါ — ပုံစံပြောင်းနိုင်သည်။',
    messageEn: 'A required export font is missing — layout may shift.',
    technicalHint: 'font family not present in bundled font registry',
    fixActions: [
      act('open_font_settings', 'navigation', 'Review font mapping', 'ဖောင့် သတ်မှတ်ချက် ကြည့်ရန်'),
      act('export_anyway', 'dismiss', 'Export anyway', 'သို့သော် ထုတ်ရန်'),
    ],
  },
  SYNC_FAILED: {
    code: 'SYNC_FAILED',
    severity: 'error',
    messageMy: 'Cloud သို့ တင်ရာတွင် အမှားဖြစ်ပွားသည်။',
    messageEn: 'Syncing to the cloud failed.',
    technicalHint: 'Apps Script endpoint returned non-2xx or timed out',
    fixActions: [
      act('retry_sync', 'retry', 'Retry sync', 'ပြန်လည် စင့်ရန်'),
      act('check_endpoint', 'config', 'Check sync settings', 'စင့်သတ်မှတ်ချက် စစ်ရန်'),
    ],
  },
  BACKUP_INVALID: {
    code: 'BACKUP_INVALID',
    severity: 'error',
    messageMy: 'ပေးထားသော မိတ္တူဖိုင် မမှန်ကန်ပါ။',
    messageEn: 'The provided backup file is not valid.',
    technicalHint: 'backup schema version or payload validation failed',
    fixActions: [
      act('choose_file', 'data', 'Choose another file', 'တစ်ခြားဖိုင် ရွေးရန်'),
      act('export_new', 'data', 'Export a fresh backup', 'မိတ္တူအသစ် ထုတ်ရန်'),
    ],
  },
  INVALID_STATE_TRANSITION: {
    code: 'INVALID_STATE_TRANSITION',
    severity: 'warning',
    messageMy: 'ဤအခြေအနေတွင် ပြောင်း၍မရပါ။',
    messageEn: 'That transition is not allowed from the current state.',
    technicalHint: 'transition guard rejected the event',
    fixActions: [act('dismiss', 'dismiss', 'Dismiss', 'ပိတ်ရန်')],
  },
}

export const REASON_CODE_LIST: ReasonCode[] = Object.keys(REASON_CODES) as ReasonCode[]

export function getReasonCode(code: ReasonCode): ReasonCodeDefinition {
  return REASON_CODES[code]
}

export function severityOf(code: ReasonCode): Severity {
  return REASON_CODES[code].severity
}

export interface LocalizedReason {
  messageMy: string
  messageEn: string
  severity: Severity
  fixActions: FixAction[]
  technicalHint: string
}

/** Resolves a code to both languages plus fix actions (never throws). */
export function resolveReason(code: ReasonCode): LocalizedReason {
  const def = REASON_CODES[code]
  return {
    messageMy: def.messageMy,
    messageEn: def.messageEn,
    severity: def.severity,
    fixActions: def.fixActions,
    technicalHint: def.technicalHint,
  }
}
