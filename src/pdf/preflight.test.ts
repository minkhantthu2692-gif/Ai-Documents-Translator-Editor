import { describe, expect, it } from 'vitest'
import {
  blockingChecks,
  countByStatus,
  estimateTranslationWork,
  isReadyToStart,
  primaryBlocker,
  runPreflight,
  type PreflightFileState,
  type PreflightInput,
} from './preflight'

function file(overrides: Partial<PreflightFileState> = {}): PreflightFileState {
  return {
    fileName: 'report.pdf',
    sizeBytes: 2 * 1024 * 1024,
    pageCount: 20,
    valid: true,
    invalidReason: null,
    corrupted: false,
    encrypted: false,
    passwordProvided: false,
    passwordAccepted: false,
    textPageCount: 20,
    scannedPageCount: 0,
    ocrAvailable: true,
    ocrEnabled: false,
    ocrDonePageCount: 0,
    ...overrides,
  }
}

function input(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    files: [file()],
    sourceLang: 'en',
    targetLang: 'my',
    apiKeyStatus: 'stub',
    provider: null,
    model: null,
    aiReady: false,
    freeTier: { maxRequests: 500, maxTokens: 200_000 },
    estimate: { tokensIn: 1000, tokensOut: 1250, requests: 5, seconds: 20 },
    ...overrides,
  }
}

const byId = (checks: ReturnType<typeof runPreflight>, id: string) =>
  checks.find((item) => item.id === id)!

describe('runPreflight', () => {
  it('passes a healthy file in Phase 2 (AI checks stay pending)', () => {
    const checks = runPreflight(input())
    expect(isReadyToStart(checks)).toBe(true)
    expect(blockingChecks(checks)).toEqual([])
    expect(byId(checks, 'file').status).toBe('pass')
    expect(byId(checks, 'textLayer').status).toBe('pass')
    expect(byId(checks, 'fonts').status).toBe('pass')
    expect(byId(checks, 'apiKey').status).toBe('pending')
    expect(byId(checks, 'provider').status).toBe('pending')
  })

  it('blocks Start when no file is chosen and offers a fix', () => {
    const checks = runPreflight(input({ files: [] }))
    expect(isReadyToStart(checks)).toBe(false)
    const blocker = primaryBlocker(checks)!
    expect(blocker.id).toBe('file')
    expect(blocker.reasonCode).toBe('FILE_NOT_PDF')
    expect(blocker.fix?.kind).toBe('data')
    expect(blocker.labelKey).toBe('preflight.file')
  })

  it('fails on an invalid file with its own reason code', () => {
    const checks = runPreflight(
      input({ files: [file({ valid: false, invalidReason: 'FILE_NOT_PDF' })] }),
    )
    expect(byId(checks, 'file').status).toBe('fail')
    expect(byId(checks, 'file').reasonCode).toBe('FILE_NOT_PDF')
    expect(isReadyToStart(checks)).toBe(false)
  })

  it('fails when the file is too large or has too many pages', () => {
    const tooBig = runPreflight(input({ files: [file({ sizeBytes: 200 * 1024 * 1024 })] }))
    expect(byId(tooBig, 'size')).toMatchObject({ status: 'fail', reasonCode: 'FILE_TOO_LARGE' })

    const tooLong = runPreflight(input({ files: [file({ pageCount: 1500 })] }))
    expect(byId(tooLong, 'pages')).toMatchObject({ status: 'fail', reasonCode: 'TOO_MANY_PAGES' })

    const longish = runPreflight(input({ files: [file({ pageCount: 700 })] }))
    expect(byId(longish, 'pages').status).toBe('warn')
    expect(isReadyToStart(longish)).toBe(true)
  })

  it('fails on corruption and on an unaccepted password', () => {
    const corrupted = runPreflight(input({ files: [file({ corrupted: true })] }))
    expect(byId(corrupted, 'integrity')).toMatchObject({
      status: 'fail',
      reasonCode: 'PDF_CORRUPTED',
    })

    const locked = runPreflight(input({ files: [file({ encrypted: true })] }))
    expect(byId(locked, 'encryption')).toMatchObject({
      status: 'fail',
      reasonCode: 'PDF_ENCRYPTED',
    })
    expect(byId(locked, 'encryption').fix?.id).toBe('enter_password')
    expect(isReadyToStart(locked)).toBe(false)

    const wrongPassword = runPreflight(
      input({ files: [file({ encrypted: true, passwordProvided: true })] }),
    )
    expect(byId(wrongPassword, 'encryption').status).toBe('fail')

    const unlocked = runPreflight(
      input({ files: [file({ encrypted: true, passwordProvided: true, passwordAccepted: true })] }),
    )
    expect(byId(unlocked, 'encryption').status).toBe('pass')
    expect(isReadyToStart(unlocked)).toBe(true)
  })

  it('offers OCR for scanned pages but only fails when OCR data is missing', () => {
    const scanned = runPreflight(
      input({
        files: [file({ pageCount: 30, textPageCount: 0, scannedPageCount: 30 })],
      }),
    )
    expect(byId(scanned, 'textLayer')).toMatchObject({
      status: 'warn',
      reasonCode: 'NO_TEXT_LAYER',
    })
    expect(byId(scanned, 'textLayer').fix?.id).toBe('run_ocr')
    expect(isReadyToStart(scanned)).toBe(true)

    const noOcr = runPreflight(
      input({
        files: [
          file({ pageCount: 30, textPageCount: 0, scannedPageCount: 30, ocrAvailable: false }),
        ],
      }),
    )
    expect(byId(noOcr, 'textLayer').status).toBe('fail')
    expect(isReadyToStart(noOcr)).toBe(false)

    const partiallyOcr = runPreflight(
      input({
        files: [file({ pageCount: 30, textPageCount: 10, scannedPageCount: 20, ocrEnabled: true })],
      }),
    )
    expect(byId(partiallyOcr, 'textLayer').status).toBe('warn')

    const ocrDone = runPreflight(
      input({
        files: [
          file({ pageCount: 30, textPageCount: 0, scannedPageCount: 30, ocrDonePageCount: 30 }),
        ],
      }),
    )
    expect(byId(ocrDone, 'textLayer').status).toBe('pass')
  })

  it('validates the language pair', () => {
    expect(byId(runPreflight(input({ targetLang: null })), 'languages')).toMatchObject({
      status: 'fail',
      reasonCode: 'LANGUAGES_MISSING',
    })
    expect(
      byId(runPreflight(input({ sourceLang: 'my', targetLang: 'my' })), 'languages'),
    ).toMatchObject({ status: 'fail', reasonCode: 'LANGUAGES_MISSING' })
    expect(byId(runPreflight(input({ targetLang: 'zh' })), 'fonts').status).toBe('warn')
    expect(byId(runPreflight(input({ targetLang: 'my' })), 'fonts').status).toBe('pass')
  })

  it('enforces API key and provider checks once the AI layer is live', () => {
    const noKey = runPreflight(input({ aiReady: true, apiKeyStatus: 'none' }))
    expect(byId(noKey, 'apiKey')).toMatchObject({ status: 'fail', reasonCode: 'NO_API_KEY' })
    expect(byId(noKey, 'provider')).toMatchObject({
      status: 'fail',
      reasonCode: 'PROVIDER_NOT_CONFIGURED',
    })
    expect(isReadyToStart(noKey)).toBe(false)

    const ready = runPreflight(
      input({ aiReady: true, apiKeyStatus: 'valid', provider: 'openai', model: 'gpt-4o-mini' }),
    )
    expect(byId(ready, 'apiKey').status).toBe('pass')
    expect(byId(ready, 'provider').status).toBe('pass')
    expect(isReadyToStart(ready)).toBe(true)
  })

  it('compares the estimate against the free-tier quota', () => {
    const over = runPreflight(
      input({ estimate: { tokensIn: 150_000, tokensOut: 150_000, requests: 100, seconds: 900 } }),
    )
    expect(byId(over, 'quota')).toMatchObject({ status: 'fail', reasonCode: 'QUOTA_EXHAUSTED' })
    expect(isReadyToStart(over)).toBe(false)

    const high = runPreflight(
      input({ estimate: { tokensIn: 100_000, tokensOut: 80_000, requests: 450, seconds: 400 } }),
    )
    expect(byId(high, 'quota').status).toBe('warn')

    const low = runPreflight(input())
    expect(byId(low, 'quota').status).toBe('pass')
    expect(byId(low, 'quota').detailEn).toContain('requests')
  })

  it('summarises statuses for the status panel', () => {
    const checks = runPreflight(input({ files: [] }))
    const counts = countByStatus(checks)
    expect(counts.fail).toBeGreaterThan(0)
    expect(counts.pass).toBeGreaterThan(0)
    expect(counts.fail + counts.warn + counts.pass + counts.pending).toBe(checks.length)
  })
})

describe('estimateTranslationWork', () => {
  it('scales with characters and blocks', () => {
    const small = estimateTranslationWork(350, 10)
    const large = estimateTranslationWork(3500, 100)
    expect(small.tokensIn).toBe(100)
    expect(large.tokensIn).toBe(1000)
    expect(large.requests).toBeGreaterThan(small.requests)
    expect(large.seconds).toBeGreaterThan(small.seconds)
    expect(small.tokensOut).toBeGreaterThan(small.tokensIn)
  })

  it('never returns zero requests for a non-empty document', () => {
    expect(estimateTranslationWork(0, 0).requests).toBe(1)
    expect(estimateTranslationWork(1, 1).tokensIn).toBeGreaterThan(0)
  })
})
