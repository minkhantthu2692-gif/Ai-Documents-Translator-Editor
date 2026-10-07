import { describe, expect, it } from 'vitest'
import {
  REASON_CODES,
  REASON_CODE_LIST,
  resolveReason,
  severityOf,
  type ReasonCode,
  type Severity,
} from './reasonCodes'

const REQUIRED_CODES: ReasonCode[] = [
  'PDF_ENCRYPTED',
  'PDF_CORRUPTED',
  'NO_TEXT_LAYER',
  'NO_API_KEY',
  'INVALID_KEY',
  'ALL_KEYS_COOLING_DOWN',
  'QUOTA_EXHAUSTED',
  'NETWORK_OFFLINE',
  'MODEL_UNAVAILABLE',
  'BAD_JSON_RESPONSE',
  'OCR_FAILED',
  'STORAGE_QUOTA_EXCEEDED',
  'EXPORT_FONT_MISSING',
  'SYNC_FAILED',
]

const SEVERITIES: Severity[] = ['info', 'success', 'warning', 'error', 'critical']

describe('reason code catalogue', () => {
  it('contains every required code', () => {
    for (const code of REQUIRED_CODES) {
      expect(REASON_CODES[code], code).toBeDefined()
      expect(REASON_CODE_LIST).toContain(code)
    }
  })

  it('provides bilingual messages and a severity for each code', () => {
    for (const code of REASON_CODE_LIST) {
      const definition = REASON_CODES[code]
      expect(definition.code).toBe(code)
      expect(definition.messageEn.length, code).toBeGreaterThan(3)
      expect(definition.messageMy.length, code).toBeGreaterThan(3)
      expect(SEVERITIES).toContain(definition.severity)
      expect(definition.technicalHint.length, code).toBeGreaterThan(3)
    }
  })

  it('gives every code at least one labelled fix action', () => {
    for (const code of REASON_CODE_LIST) {
      const definition = REASON_CODES[code]
      expect(definition.fixActions.length, code).toBeGreaterThan(0)
      for (const action of definition.fixActions) {
        expect(action.id.length, code).toBeGreaterThan(0)
        expect(action.labelEn.length, code).toBeGreaterThan(0)
        expect(action.labelMy.length, code).toBeGreaterThan(0)
        expect(['retry', 'config', 'navigation', 'data', 'external', 'dismiss']).toContain(
          action.kind,
        )
      }
    }
  })

  it('uses the error severity for key and file failures', () => {
    expect(severityOf('NO_API_KEY')).toBe('error')
    expect(severityOf('PDF_CORRUPTED')).toBe('error')
    expect(severityOf('STORAGE_QUOTA_EXCEEDED')).toBe('critical')
    expect(severityOf('NO_TEXT_LAYER')).toBe('warning')
  })

  it('resolves a code to both languages without throwing', () => {
    const resolved = resolveReason('NETWORK_OFFLINE')
    expect(resolved.messageEn).toContain('offline')
    expect(resolved.messageMy.length).toBeGreaterThan(0)
    expect(resolved.fixActions.length).toBeGreaterThan(0)
  })
})
