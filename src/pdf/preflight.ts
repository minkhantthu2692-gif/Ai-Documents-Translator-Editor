/**
 * Pre-flight checks.
 *
 * A pure, data-only evaluation that answers "can I start, and if not, why?".
 * Every check is PASS / WARN / FAIL / PENDING, carries the reason code that
 * produced it (so the Status Panel can render the bilingual message and its fix
 * actions) and a technical detail for the event log.
 *
 * FAIL is the only status that disables Start.
 */

import type { FixAction, ReasonCode } from '@/core/reasonCodes'
import { MAX_FILE_BYTES, MAX_PAGE_COUNT, WARN_FILE_BYTES, WARN_PAGE_COUNT } from './fileValidation'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'pending'

export type PreflightCheckId =
  | 'file'
  | 'size'
  | 'pages'
  | 'integrity'
  | 'encryption'
  | 'textLayer'
  | 'fonts'
  | 'apiKey'
  | 'provider'
  | 'languages'
  | 'quota'

export interface PreflightCheck {
  id: PreflightCheckId
  status: CheckStatus
  /** i18n key of the check label (both locale files must define it). */
  labelKey: string
  reasonCode: ReasonCode | null
  detailMy: string
  detailEn: string
  fix: FixAction | null
}

/** Per-file state gathered by the analysis worker + validation layer. */
export interface PreflightFileState {
  fileName: string
  sizeBytes: number
  pageCount: number
  /** Name/magic/size validation passed. */
  valid: boolean
  invalidReason: ReasonCode | null
  corrupted: boolean
  encrypted: boolean
  /** A password was typed for this file. */
  passwordProvided: boolean
  /** The password opened the document. */
  passwordAccepted: boolean
  textPageCount: number
  scannedPageCount: number
  /** tesseract.js language data is loaded (or already cached) for OCR. */
  ocrAvailable: boolean
  ocrEnabled: boolean
  ocrDonePageCount: number
}

export interface QuotaEstimate {
  tokensIn: number
  tokensOut: number
  requests: number
  seconds: number
}

export interface PreflightInput {
  files: PreflightFileState[]
  sourceLang: string | null
  targetLang: string | null
  /** `stub` = the AI layer is not wired yet (Phase 2). */
  apiKeyStatus: 'stub' | 'none' | 'valid' | 'invalid' | 'cooling' | 'quota'
  provider: string | null
  model: string | null
  /**
   * False while the provider/API-key layer is still a placeholder (Phase 2);
   * the corresponding checks then report PENDING instead of failing Start.
   */
  aiReady: boolean
  freeTier: { maxRequests: number; maxTokens: number }
  estimate: QuotaEstimate
}

const BYTES = 1024 * 1024

/** Burmese digits keep the log readable for Myanmar users. */
function myNumber(value: number): string {
  return String(Math.round(value)).replace(/\d/g, (digit) => '၀၁၂၃၄၅၆၇၈၉'[Number(digit)])
}

function fmtBytes(bytes: number): string {
  if (bytes >= BYTES) return `${(bytes / BYTES).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function check(
  id: PreflightCheckId,
  status: CheckStatus,
  detailMy: string,
  detailEn: string,
  reasonCode: ReasonCode | null = null,
  fix: FixAction | null = null,
): PreflightCheck {
  return { id, status, labelKey: `preflight.${id}`, reasonCode, detailMy, detailEn, fix }
}

/** Script families whose glyphs our bundled fonts actually cover. */
const COVERED_TARGETS = new Set(['my', 'en', 'fr', 'de', 'es', 'it', 'pt', 'id', 'vi', 'nl'])
const BUNDLED_FONT_TARGETS: Record<string, string> = {
  my: 'Noto Sans Myanmar / Padauk',
  en: 'Noto Sans / Roboto / Inter',
  fr: 'Noto Sans / Roboto / Inter',
  de: 'Noto Sans / Roboto / Inter',
  es: 'Noto Sans / Roboto / Inter',
  it: 'Noto Sans / Roboto / Inter',
  pt: 'Noto Sans / Roboto / Inter',
  id: 'Noto Sans / Roboto / Inter',
  vi: 'Noto Sans / Roboto / Inter',
  nl: 'Noto Sans / Roboto / Inter',
}

/**
 * Blocks-per-request heuristic used for the token/request/time estimate.
 * Matches the batching the translation job will use in Phase 3.
 */
export const BATCH_BLOCKS = 15
export const AVG_REQUEST_SECONDS = 2.5

export function estimateTranslationWork(characterCount: number, blockCount: number): QuotaEstimate {
  const chars = Math.max(0, characterCount)
  const tokensIn = Math.max(1, Math.ceil(chars / 3.5))
  const tokensOut = Math.max(1, Math.ceil(tokensIn * 1.25))
  const requests = Math.max(1, Math.ceil(blockCount / BATCH_BLOCKS))
  const seconds = Math.round((requests * AVG_REQUEST_SECONDS + chars / 400) * 10) / 10
  return { tokensIn, tokensOut, requests, seconds }
}

function fileCheck(files: PreflightFileState[]): PreflightCheck {
  if (files.length === 0) {
    return check(
      'file',
      'fail',
      'စတင်ရန် PDF ဖိုင် မရွေးရသေးပါ။',
      'No PDF file selected yet.',
      'FILE_NOT_PDF',
      {
        id: 'choose_file',
        kind: 'data',
        labelEn: 'Choose a PDF file',
        labelMy: 'PDF ဖိုင် ရွေးရန်',
      },
    )
  }
  const invalid = files.find((file) => !file.valid)
  if (invalid) {
    return check(
      'file',
      'fail',
      `${invalid.fileName} ကို မဖတ်နိုင်ပါ (PDF မဟုတ်ပါ)။`,
      `${invalid.fileName} is not a readable PDF.`,
      invalid.invalidReason ?? 'FILE_NOT_PDF',
      {
        id: 'choose_file',
        kind: 'data',
        labelEn: 'Choose a PDF file',
        labelMy: 'PDF ဖိုင် ရွေးရန်',
      },
    )
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  return check(
    'file',
    'pass',
    `PDF ဖိုင် ${myNumber(files.length)} ခု (${fmtBytes(total)}) အဆင်သင့်`,
    `${files.length} PDF file${files.length > 1 ? 's' : ''} ready (${fmtBytes(total)})`,
  )
}

function sizeCheck(files: PreflightFileState[]): PreflightCheck {
  if (files.length === 0) return check('size', 'pending', 'စောင့်ဆိုင်းနေသည်', 'Waiting for a file')
  const largest = Math.max(...files.map((file) => file.sizeBytes))
  if (largest > MAX_FILE_BYTES) {
    return check(
      'size',
      'fail',
      `အကြီးဆုံးဖိုင် ${fmtBytes(largest)} — ကန့်သတ်ချက် ${Math.round(MAX_FILE_BYTES / BYTES)} MB`,
      `Largest file is ${fmtBytes(largest)} — limit is ${Math.round(MAX_FILE_BYTES / BYTES)} MB`,
      'FILE_TOO_LARGE',
      {
        id: 'split_pdf',
        kind: 'data',
        labelEn: 'Split or compress the PDF',
        labelMy: 'PDF ခွဲရန်/ကျုံ့ရန်',
      },
    )
  }
  if (largest > WARN_FILE_BYTES) {
    return check(
      'size',
      'warn',
      `ဖိုင်အရွယ် ${fmtBytes(largest)} — ကြီးသဖြင့် နှေးနိုင်သည်`,
      `File size ${fmtBytes(largest)} — large files analyse slowly`,
    )
  }
  return check(
    'size',
    'pass',
    `အရွယ်အစား ${fmtBytes(largest)} (သင့်တော်သည်)`,
    `Size ${fmtBytes(largest)} (within limits)`,
  )
}

function pagesCheck(files: PreflightFileState[]): PreflightCheck {
  if (files.length === 0)
    return check('pages', 'pending', 'စောင့်ဆိုင်းနေသည်', 'Waiting for a file')
  const unknown = files.find((file) => !Number.isFinite(file.pageCount) || file.pageCount <= 0)
  if (unknown) {
    return check(
      'pages',
      'fail',
      `${unknown.fileName} ၏ စာမျက်နှာအရေအတွက် မသိရပါ`,
      `Could not read the page count of ${unknown.fileName}`,
      'PDF_CORRUPTED',
      {
        id: 're_export_pdf',
        kind: 'data',
        labelEn: 'Re-export the PDF',
        labelMy: 'PDF ကို ပြန်ထုတ်ရန်',
      },
    )
  }
  const total = files.reduce((sum, file) => sum + file.pageCount, 0)
  const largest = Math.max(...files.map((file) => file.pageCount))
  if (largest > MAX_PAGE_COUNT) {
    return check(
      'pages',
      'fail',
      `အများဆုံး စာမျက်နှာ ${myNumber(MAX_PAGE_COUNT)} — ရှိသည် ${myNumber(largest)}`,
      `Limit is ${MAX_PAGE_COUNT} pages — this file has ${largest}`,
      'TOO_MANY_PAGES',
      { id: 'split_pdf', kind: 'data', labelEn: 'Split the document', labelMy: 'စာတမ်း ခွဲရန်' },
    )
  }
  if (largest > WARN_PAGE_COUNT) {
    return check(
      'pages',
      'warn',
      `စာမျက်နှာ ${myNumber(total)} ခု — ခန့်မှန်းချေအားဖြင့် ကြာမြင့်နိုင်သည်`,
      `${total} pages in total — analysis may take a while`,
    )
  }
  return check('pages', 'pass', `စာမျက်နှာ ${myNumber(total)} ခု`, `${total} pages`)
}

function integrityCheck(files: PreflightFileState[]): PreflightCheck {
  const broken = files.find((file) => file.corrupted)
  if (broken) {
    return check(
      'integrity',
      'fail',
      `${broken.fileName} ပျက်စီးနေသည် သို့မဟုတ် မဖတ်နိုင်ပါ`,
      `${broken.fileName} is corrupted or unreadable`,
      'PDF_CORRUPTED',
      {
        id: 'open_file_again',
        kind: 'retry',
        labelEn: 'Try another file',
        labelMy: 'တစ်ခြားဖိုင် စမ်းရန်',
      },
    )
  }
  if (files.length === 0)
    return check('integrity', 'pending', 'စောင့်ဆိုင်းနေသည်', 'Waiting for a file')
  return check(
    'integrity',
    'pass',
    'PDF ဖွဲ့စည်းပုံ မမှန်မကန်မှု မတွေ့ပါ',
    'No structural problems found',
  )
}

function encryptionCheck(files: PreflightFileState[]): PreflightCheck {
  const locked = files.find((file) => file.encrypted)
  if (!locked) {
    if (files.length === 0)
      return check('encryption', 'pending', 'စောင့်ဆိုင်းနေသည်', 'Waiting for a file')
    return check('encryption', 'pass', 'စကားဝှက်မလိုပါ', 'No password required')
  }
  if (locked.passwordAccepted) {
    return check('encryption', 'pass', 'စကားဝှက် မှန်ကန်ပါသည်', 'Password accepted')
  }
  if (locked.passwordProvided) {
    return check(
      'encryption',
      'fail',
      `${locked.fileName} ၏ စကားဝှက် မမှန်ပါ`,
      `The password for ${locked.fileName} is incorrect`,
      'PDF_ENCRYPTED',
      {
        id: 'enter_password',
        kind: 'config',
        labelEn: 'Enter PDF password',
        labelMy: 'PDF စကားဝှက် ထည့်ရန်',
      },
    )
  }
  return check(
    'encryption',
    'fail',
    `${locked.fileName} သည် စကားဝှက်ဖြင့် ကာကွယ်ထားသည်`,
    `${locked.fileName} is protected by a password`,
    'PDF_ENCRYPTED',
    {
      id: 'enter_password',
      kind: 'config',
      labelEn: 'Enter PDF password',
      labelMy: 'PDF စကားဝှက် ထည့်ရန်',
    },
  )
}

function textLayerCheck(files: PreflightFileState[]): PreflightCheck {
  if (files.length === 0)
    return check('textLayer', 'pending', 'စောင့်ဆိုင်းနေသည်', 'Waiting for a file')
  const pages = files.reduce((sum, file) => sum + file.pageCount, 0)
  const withText = files.reduce((sum, file) => sum + file.textPageCount, 0)
  const scanned = files.reduce((sum, file) => sum + file.scannedPageCount, 0)
  const ocrDone = files.reduce((sum, file) => sum + file.ocrDonePageCount, 0)
  const anyOcrAvailable = files.some((file) => file.ocrAvailable)
  const anyOcrEnabled = files.some((file) => file.ocrEnabled)

  if (pages === 0) return check('textLayer', 'pending', 'စောင့်ဆိုင်းနေသည်', 'Waiting for analysis')
  if (withText === 0) {
    if (ocrDone >= scanned && scanned > 0) {
      return check(
        'textLayer',
        'pass',
        `OCR ပြီးဆုံးပြီ (စာမျက်နှာ ${myNumber(ocrDone)} ခု)`,
        `OCR complete (${ocrDone} pages)`,
      )
    }
    if (!anyOcrAvailable) {
      return check(
        'textLayer',
        'fail',
        `စာမျက်နှာအားလုံးတွင် စာသားအလွှာမရှိ — OCR ဒေတာ မရနိုင်ပါ`,
        `No page has a text layer and OCR data is unavailable`,
        'NO_TEXT_LAYER',
        {
          id: 'download_language',
          kind: 'data',
          labelEn: 'Download OCR language',
          labelMy: 'OCR ဒေတာ ဆွဲရန်',
        },
      )
    }
    return check(
      'textLayer',
      'warn',
      `စာမျက်နှာ ${myNumber(pages)} ခုလုံး စက်ရေးထားသောဖြစ်၍ OCR လိုအပ်သည်`,
      `All ${pages} pages are scans — OCR is required`,
      'NO_TEXT_LAYER',
      { id: 'run_ocr', kind: 'retry', labelEn: 'Run OCR', labelMy: 'OCR စတင်ရန်' },
    )
  }
  if (scanned > 0) {
    return check(
      'textLayer',
      'warn',
      `စာမျက်နှာ ${myNumber(withText)}/${myNumber(pages)} တွင် စာသားရှိ — OCR ဖြင့် ${myNumber(scanned)} ခု ဖတ်ရန်လိုသည်`,
      `${withText}/${pages} pages have text — ${scanned} need OCR`,
      'NO_TEXT_LAYER',
      { id: 'run_ocr', kind: 'retry', labelEn: 'Run OCR', labelMy: 'OCR စတင်ရန်' },
    )
  }
  if (anyOcrEnabled && ocrDone < pages) {
    return check('textLayer', 'warn', 'OCR လုပ်ဆောင်နေသည်', 'OCR is running')
  }
  return check(
    'textLayer',
    'pass',
    `စာသားအလွှာ ရှိသည် (${myNumber(withText)}/${myNumber(pages)} စာမျက်နှာ)`,
    `Text layer present (${withText}/${pages} pages)`,
  )
}

function fontsCheck(targetLang: string | null): PreflightCheck {
  if (!targetLang) {
    return check('fonts', 'pending', 'ပန်းတို့ဘာသာစကား မရွေးရသေးပါ', 'Target language not chosen')
  }
  const bundled = BUNDLED_FONT_TARGETS[targetLang]
  if (bundled || COVERED_TARGETS.has(targetLang)) {
    return check(
      'fonts',
      'pass',
      `ဖောင့်အဆင်သင့် (${bundled ?? 'Noto Sans'})`,
      `Fonts ready (${bundled ?? 'Noto Sans'})`,
    )
  }
  return check(
    'fonts',
    'warn',
    `ဤဘာသာစကားအတွက် ဘန်ဒယ်ဖောင့် မရှိပါ — ထုတ်ရာတွင် အစားထိုးနိုင်သည်`,
    `No bundled font covers this language — export may substitute a font`,
    'EXPORT_FONT_MISSING',
    {
      id: 'open_font_settings',
      kind: 'navigation',
      labelEn: 'Review font mapping',
      labelMy: 'ဖောင့် သတ်မှတ်ချက် ကြည့်ရန်',
    },
  )
}

function languagesCheck(sourceLang: string | null, targetLang: string | null): PreflightCheck {
  if (!sourceLang || !targetLang) {
    return check(
      'languages',
      'fail',
      'ဘာသာစကားနှစ်ခုလုံး ရွေးထားရန် လိုအပ်သည်',
      'Both languages must be selected',
      'LANGUAGES_MISSING',
      {
        id: 'pick_languages',
        kind: 'config',
        labelEn: 'Pick both languages',
        labelMy: 'ဘာသာစကားနှစ်ခု ရွေးရန်',
      },
    )
  }
  if (sourceLang === targetLang) {
    return check(
      'languages',
      'fail',
      'မူရင်းနှင့် ပန်းတို့ တူညီနေသည်',
      'Source and target language are identical',
      'LANGUAGES_MISSING',
      {
        id: 'pick_languages',
        kind: 'config',
        labelEn: 'Pick both languages',
        labelMy: 'ဘာသာစကားနှစ်ခု ရွေးရန်',
      },
    )
  }
  return check(
    'languages',
    'pass',
    `${sourceLang} → ${targetLang}`,
    `${sourceLang} → ${targetLang}`,
  )
}

function apiKeyCheck(input: PreflightInput): PreflightCheck {
  if (!input.aiReady) {
    return check(
      'apiKey',
      'pending',
      'AI သော့ စစ်ဆေးမှု Phase 3 တွင် လာမည်',
      'API key validation arrives with Phase 3',
    )
  }
  switch (input.apiKeyStatus) {
    case 'none':
      return check('apiKey', 'fail', 'AI သော့ မထည့်ရသေးပါ', 'No API key configured', 'NO_API_KEY', {
        id: 'add_key',
        kind: 'navigation',
        labelEn: 'Add API key',
        labelMy: 'API သော့ ထည့်ရန်',
      })
    case 'invalid':
      return check('apiKey', 'fail', 'AI သော့ မမှန်ပါ', 'The API key was rejected', 'INVALID_KEY', {
        id: 'replace_key',
        kind: 'config',
        labelEn: 'Replace the key',
        labelMy: 'သော့ အသစ်လဲရန်',
      })
    case 'cooling':
      return check(
        'apiKey',
        'warn',
        'သော့အားလုံး အအေးခံနေသည်',
        'All keys are cooling down',
        'ALL_KEYS_COOLING_DOWN',
        { id: 'wait_retry', kind: 'retry', labelEn: 'Retry later', labelMy: 'နောက်မှ ပြန်စမ်းရန်' },
      )
    case 'quota':
      return check(
        'apiKey',
        'fail',
        'AI အသုံးပြုခွင့် ပြည့်သွားပြီ',
        'The AI quota is exhausted',
        'QUOTA_EXHAUSTED',
        {
          id: 'wait_retry',
          kind: 'retry',
          labelEn: 'Retry after reset',
          labelMy: 'ပြန်လည်သတ်မှတ်ပြီး စမ်းရန်',
        },
      )
    case 'valid':
      return check('apiKey', 'pass', 'AI သော့ အသုံးပြုနိုင်သည်', 'API key is usable')
    case 'stub':
      return check('apiKey', 'pending', 'AI အဆင့် မဆောင်ရွက်ရသေးပါ', 'AI layer not wired yet')
  }
}

function providerCheck(input: PreflightInput): PreflightCheck {
  if (!input.aiReady) {
    return check(
      'provider',
      'pending',
      'ပေးပို့သူ ရွေးချယ်မှု Phase 3 တွင် လာမည်',
      'Provider selection arrives with Phase 3',
    )
  }
  if (!input.provider || !input.model) {
    return check(
      'provider',
      'fail',
      'ပေးပို့သူ/မော်ဒယ် မရွေးရသေးပါ',
      'Provider or model not selected',
      'PROVIDER_NOT_CONFIGURED',
      {
        id: 'choose_provider',
        kind: 'config',
        labelEn: 'Choose provider and model',
        labelMy: 'ပေးပို့သူ/မော်ဒယ် ရွေးရန်',
      },
    )
  }
  return check(
    'provider',
    'pass',
    `${input.provider} · ${input.model}`,
    `${input.provider} · ${input.model}`,
  )
}

function quotaCheck(input: PreflightInput): PreflightCheck {
  const { maxRequests, maxTokens } = input.freeTier
  if (maxRequests <= 0 || maxTokens <= 0) {
    return check(
      'quota',
      'pending',
      'အခမဲ့အသုံးပြုခွင့် ကန့်သတ်ချက် မသတ်မှတ်ရသေးပါ',
      'Free-tier limits not set',
    )
  }
  const { tokensIn, tokensOut, requests, seconds } = input.estimate
  const totalTokens = tokensIn + tokensOut
  const detailMy = `ခန့်မှန်းချေ: တောင်းဆိုမှု ${myNumber(requests)} ခု၊ တိုကင် ${myNumber(totalTokens)} (စက္ကန့် ${myNumber(seconds)})`
  const detailEn = `Estimate: ${requests} requests, ${totalTokens} tokens (~${seconds}s)`

  if (requests > maxRequests || totalTokens > maxTokens) {
    return check(
      'quota',
      'fail',
      `${detailMy} — အခမဲ့ကန့်သတ်ချက် ${myNumber(maxRequests)} တောင်းဆိုမှု/${myNumber(maxTokens)} တိုကင်ထက် ကျော်သည်`,
      `${detailEn} — over the free limit of ${maxRequests} requests / ${maxTokens} tokens`,
      'QUOTA_EXHAUSTED',
      {
        id: 'reduce_scope',
        kind: 'config',
        labelEn: 'Translate in smaller batches',
        labelMy: 'အစုလိုက်အစိတ်အပိုင်း ဘာသာပြန်ရန်',
      },
    )
  }
  const highWater = Math.max(requests / maxRequests, totalTokens / maxTokens)
  if (highWater >= 0.8) {
    return check(
      'quota',
      'warn',
      `${detailMy} — ကန့်သတ်ချက်၏ ၈၀% ကျော်သည်`,
      `${detailEn} — uses over 80% of the free limit`,
      'QUOTA_EXHAUSTED',
      {
        id: 'reduce_scope',
        kind: 'config',
        labelEn: 'Translate in smaller batches',
        labelMy: 'အစုလိုက်အစိတ်အပိုင်း ဘာသာပြန်ရန်',
      },
    )
  }
  return check('quota', 'pass', detailMy, detailEn)
}

/** Runs every check and returns them in panel order. */
export function runPreflight(input: PreflightInput): PreflightCheck[] {
  return [
    fileCheck(input.files),
    sizeCheck(input.files),
    pagesCheck(input.files),
    integrityCheck(input.files),
    encryptionCheck(input.files),
    textLayerCheck(input.files),
    fontsCheck(input.targetLang),
    languagesCheck(input.sourceLang, input.targetLang),
    apiKeyCheck(input),
    providerCheck(input),
    quotaCheck(input),
  ]
}

/** Checks that disable Start. */
export function blockingChecks(checks: PreflightCheck[]): PreflightCheck[] {
  return checks.filter((item) => item.status === 'fail')
}

export function isReadyToStart(checks: PreflightCheck[]): boolean {
  return blockingChecks(checks).length === 0
}

/** First blocking check (the Status Panel shows this one up front). */
export function primaryBlocker(checks: PreflightCheck[]): PreflightCheck | null {
  return blockingChecks(checks)[0] ?? null
}

export function countByStatus(checks: PreflightCheck[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, pending: 0 }
  for (const item of checks) counts[item.status] += 1
  return counts
}
