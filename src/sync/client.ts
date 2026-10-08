/**
 * HTTP client for the Apps Script sync backend.
 *
 * `POST text/plain` with a JSON body avoids the CORS preflight that
 * `application/json` would trigger; Apps Script answers every request with
 * HTTP 200 + a JSON envelope (`{ ok:true, ... }` or `{ ok:false, code,
 * message }`). Network failures / timeouts / non-JSON bodies are converted
 * into SyncError so callers only deal with codes.
 */

import {
  REQUEST_TIMEOUT_MS,
  SyncError,
  type DeleteProjectResponse,
  type PingResponse,
  type PullResponse,
  type PushResponse,
  type SyncErrorCode,
  type WireChange,
  type WipeResponse,
} from './protocol'

export interface SyncClientConfig {
  url: string
  token: string
  deviceId: string
  timeoutMs?: number
}

export class SyncClient {
  private readonly url: string
  private readonly token: string
  private readonly deviceId: string
  private readonly timeoutMs: number

  constructor(config: SyncClientConfig) {
    this.url = config.url.trim()
    this.token = config.token
    this.deviceId = config.deviceId
    this.timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  /** Low-level dispatch: action + payload → validated envelope. */
  async post<T extends object>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.url) throw new SyncError('NOT_CONFIGURED', 'Apps Script URL is not set.')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        // text/plain is a CORS-safelisted content type: no preflight round-trip.
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'application/json' },
        body: JSON.stringify({
          token: this.token,
          action,
          deviceId: this.deviceId,
          ...payload,
        }),
        signal: controller.signal,
        mode: 'cors',
        cache: 'no-store',
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new SyncError('TIMEOUT', `Sync request timed out after ${this.timeoutMs}ms.`)
      }
      throw new SyncError('NETWORK', `Cannot reach the sync backend: ${String(err)}`)
    } finally {
      clearTimeout(timer)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new SyncError(
        'BAD_RESPONSE',
        `Sync backend returned a non-JSON body (HTTP ${response.status}).`,
      )
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new SyncError('BAD_RESPONSE', 'Sync backend returned an unexpected payload.')
    }

    const envelope = body as Record<string, unknown>
    if (envelope.ok !== true) {
      const code = typeof envelope.code === 'string' ? envelope.code : 'INTERNAL'
      const message =
        typeof envelope.message === 'string' && envelope.message
          ? envelope.message
          : 'Sync backend error.'
      throw new SyncError(code as SyncErrorCode, message)
    }
    return envelope as unknown as T
  }

  ping(): Promise<PingResponse> {
    return this.post<PingResponse>('ping')
  }

  pushChanges(changes: WireChange[]): Promise<PushResponse> {
    return this.post<PushResponse>('pushChanges', { changes })
  }

  pullChanges(since: number, limit?: number): Promise<PullResponse> {
    return this.post<PullResponse>('pullChanges', limit ? { since, limit } : { since })
  }

  deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    return this.post<DeleteProjectResponse>('deleteProject', { projectId })
  }

  /** Wipes every data row in the spreadsheet (typed confirmation required). */
  wipe(): Promise<WipeResponse> {
    return this.post<WipeResponse>('wipe', { confirm: 'WIPE' })
  }

  /** Cloud backup snapshot (cursor-paged like pushChanges). */
  backup(cursor?: number | null, pageSize = 500): Promise<Record<string, unknown>> {
    return this.post<Record<string, unknown>>(
      'backup',
      cursor ? { cursor, pageSize } : { pageSize },
    )
  }
}
