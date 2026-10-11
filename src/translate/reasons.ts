/**
 * Terminal-failure → reason-code mapping.
 *
 * Shared by the translation worker (which catches engine failures and posts
 * `failed`) and the live verify harness (which rejects with the same shape the
 * worker client builds), so the Status Panel sees one vocabulary everywhere.
 */

import type { ReasonCode } from '@/core/reasonCodes'
import { ProviderError } from '@/providers/types'

/**
 * True only when the browser itself reports no network interface.
 *
 * This is the *only* condition under which we may tell the user they are
 * offline. A rejected `fetch` proves nothing of the kind — DNS, a captive
 * portal, an extension, a firewall or the provider being down all fail the
 * same way while the Wi-Fi icon is perfectly happy — so those report
 * `PROVIDER_UNREACHABLE` instead of accusing the device of being offline.
 */
export function deviceOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

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
        return { reasonCode: deviceOffline() ? 'NETWORK_OFFLINE' : 'PROVIDER_UNREACHABLE', message }
      case 'model_missing':
        return { reasonCode: 'MODEL_UNAVAILABLE', message }
      case 'bad_request':
      case 'unknown':
      default:
        return { reasonCode: 'BAD_JSON_RESPONSE', message }
    }
  }
  return {
    reasonCode: deviceOffline() ? 'NETWORK_OFFLINE' : 'PROVIDER_UNREACHABLE',
    message: error instanceof Error ? error.message : String(error),
  }
}
