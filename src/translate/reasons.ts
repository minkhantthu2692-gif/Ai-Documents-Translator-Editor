/**
 * Terminal-failure → reason-code mapping.
 *
 * Shared by the translation worker (which catches engine failures and posts
 * `failed`) and the live verify harness (which rejects with the same shape the
 * worker client builds), so the Status Panel sees one vocabulary everywhere.
 */

import type { ReasonCode } from '@/core/reasonCodes'
import { ProviderError } from '@/providers/types'

/** Maps a terminal failure onto the reason code the Status Panel explains. */
export function reasonFor(error: unknown): { reasonCode: ReasonCode; message: string } {
  if (error instanceof ProviderError) {
    const message = error.message
    switch (error.kind) {
      case 'unauthorized':
        return {
          reasonCode: /no api key/i.test(message) ? 'NO_API_KEY' : 'INVALID_KEY',
          message,
        }
      case 'forbidden':
        return { reasonCode: 'INVALID_KEY', message }
      case 'quota':
        return { reasonCode: 'QUOTA_EXHAUSTED', message }
      case 'rate_limit':
        return { reasonCode: 'ALL_KEYS_COOLING_DOWN', message }
      case 'server':
        return { reasonCode: 'ALL_KEYS_COOLING_DOWN', message }
      case 'network':
      case 'timeout':
        return { reasonCode: 'NETWORK_OFFLINE', message }
      case 'model_missing':
        return { reasonCode: 'MODEL_UNAVAILABLE', message }
      case 'bad_request':
      case 'unknown':
      default:
        return { reasonCode: 'BAD_JSON_RESPONSE', message }
    }
  }
  return {
    reasonCode: 'BAD_JSON_RESPONSE',
    message: error instanceof Error ? error.message : String(error),
  }
}
