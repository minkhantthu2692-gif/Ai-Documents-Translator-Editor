/**
 * API-key and provider transfer (Settings → AI Providers).
 *
 * The full database backup deliberately *cannot* move keys between machines:
 * `apiKeyRepo` seals every secret with AES-GCM under a key bound to this
 * device (or to the vault passphrase), so a restored cipher is undecryptable
 * anywhere else — `restoreBackup` even pushes an `apiKeys.device-bound`
 * warning when it sees one.
 *
 * This module is the escape hatch. It exports the secrets in the clear so the
 * importing machine can re-seal them under *its* key, which is the only way to
 * carry a key somewhere else without typing it again. That trade-off is
 * deliberate, and it is why the file is labelled as holding usable
 * credentials wherever the UI offers it.
 *
 * Rules this module keeps to:
 *  - a secret is never written to the event log, an error message or a toast;
 *  - `parseKeyBundle` validates the whole untrusted file before a single write;
 *  - import re-seals locally and never copies a sealed cipher across.
 */

import { PROVIDERS, isBundledModel } from '@/config/models.config'
import { vaultPassphrase } from '@/core/vault'
import { registerImportedModels, type ModelSpec, type ProviderId } from '@/config/models.config'
import { apiKeyRepo, type ApiKeySummary } from './repo-apiKeys'
import { SETTING_KEYS, settingsRepo } from './repo-settings'

export const KEY_BUNDLE_FORMAT = 'aidt-keys'
export const KEY_BUNDLE_SCHEMA_VERSION = 1

/** Per-provider settings that travel with the keys. */
export interface BundledProvider {
  model?: string
  baseUrl?: string
}

export interface BundledKey {
  provider: string
  label: string
  /** Plaintext. The whole point of the file — see the module doc. */
  secret: string
  models: string[]
  enabled: boolean
}

/** A persisted imported-model spec, as stored under `ai.importedModels`. */
export interface BundledImportedModel extends ModelSpec {
  importedAt?: number
}

export interface KeyBundle {
  format: typeof KEY_BUNDLE_FORMAT
  schemaVersion: number
  exportedAt: number
  appVersion: string
  /** Always true: this file carries usable secrets, not sealed blobs. */
  secrets: true
  keys: BundledKey[]
  providers: Record<string, BundledProvider>
  importedModels: BundledImportedModel[]
  activeProvider: string | null
  activeModel: string | null
}

export interface KeyBundleImportReport {
  keysAdded: number
  keysSkipped: number
  providersUpdated: number
  modelsImported: number
  activeProvider: string | null
}

export class KeyBundleError extends Error {
  readonly reasonCode = 'KEY_BUNDLE_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'KeyBundleError'
  }
}

function appVersion(): string {
  return import.meta.env?.VITE_APP_VERSION ?? '0.1.0'
}

/* ------------------------------------------------------------------ */
/* Pure building / parsing                                             */
/* ------------------------------------------------------------------ */

export function buildKeyBundle(input: {
  keys: BundledKey[]
  providers: Record<string, BundledProvider>
  importedModels?: BundledImportedModel[]
  activeProvider?: string | null
  activeModel?: string | null
  exportedAt?: number
}): KeyBundle {
  return {
    format: KEY_BUNDLE_FORMAT,
    schemaVersion: KEY_BUNDLE_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? Date.now(),
    appVersion: appVersion(),
    secrets: true,
    keys: input.keys,
    providers: input.providers,
    importedModels: input.importedModels ?? [],
    activeProvider: input.activeProvider ?? null,
    activeModel: input.activeModel ?? null,
  }
}

export function serializeKeyBundle(bundle: KeyBundle): string {
  return JSON.stringify(bundle, null, 2)
}

/**
 * Validates untrusted JSON before any write happens.
 *
 * Every failure message names the *position* of the offending entry and never
 * echoes its contents: the file holds secrets, so an error shown in a toast
 * must not be a place one can leak out of.
 */
export function parseKeyBundle(json: string): KeyBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new KeyBundleError(`Not valid JSON: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KeyBundleError('Key file is not a JSON object')
  }

  const candidate = parsed as Partial<KeyBundle>
  if (candidate.format !== KEY_BUNDLE_FORMAT) {
    // Truncated: this echoes attacker-controlled input back into a toast.
    throw new KeyBundleError(`Unexpected format: ${String(candidate.format).slice(0, 32)}`)
  }
  if (typeof candidate.schemaVersion !== 'number' || candidate.schemaVersion < 1) {
    throw new KeyBundleError('Key file has no schema version')
  }
  if (candidate.schemaVersion > KEY_BUNDLE_SCHEMA_VERSION) {
    throw new KeyBundleError(
      `Key file schema ${candidate.schemaVersion} is newer than supported ${KEY_BUNDLE_SCHEMA_VERSION}`,
    )
  }
  if (!Array.isArray(candidate.keys)) throw new KeyBundleError('Key file has no keys array')

  const keys: BundledKey[] = []
  candidate.keys.forEach((raw, index) => {
    const at = `Key #${index + 1}`
    if (!raw || typeof raw !== 'object') throw new KeyBundleError(`${at} is not an object`)
    const entry = raw as Partial<BundledKey>
    if (typeof entry.provider !== 'string' || entry.provider.trim() === '') {
      throw new KeyBundleError(`${at} has no provider`)
    }
    if (typeof entry.secret !== 'string' || entry.secret.trim().length < 8) {
      throw new KeyBundleError(`${at} has a secret that is missing or too short`)
    }
    const provider = entry.provider.trim()
    keys.push({
      provider,
      label:
        typeof entry.label === 'string' && entry.label.trim() !== ''
          ? entry.label.trim()
          : provider,
      secret: entry.secret.trim(),
      models: Array.isArray(entry.models)
        ? entry.models.filter((model): model is string => typeof model === 'string')
        : [],
      enabled: entry.enabled !== false,
    })
  })

  const providers: Record<string, BundledProvider> = {}
  const rawProviders = candidate.providers
  if (rawProviders && typeof rawProviders === 'object' && !Array.isArray(rawProviders)) {
    for (const [id, value] of Object.entries(rawProviders as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Partial<BundledProvider>
      providers[id] = {
        ...(typeof entry.model === 'string' && entry.model ? { model: entry.model } : {}),
        ...(typeof entry.baseUrl === 'string' && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      }
    }
  }

  const importedModels = Array.isArray(candidate.importedModels)
    ? candidate.importedModels.filter(
        (spec): spec is BundledImportedModel =>
          !!spec &&
          typeof spec === 'object' &&
          typeof (spec as { provider?: unknown }).provider === 'string' &&
          typeof (spec as { id?: unknown }).id === 'string',
      )
    : []

  return buildKeyBundle({
    keys,
    providers,
    importedModels,
    activeProvider: typeof candidate.activeProvider === 'string' ? candidate.activeProvider : null,
    activeModel: typeof candidate.activeModel === 'string' ? candidate.activeModel : null,
    exportedAt: typeof candidate.exportedAt === 'number' ? candidate.exportedAt : 0,
  })
}

/**
 * Re-importing the same file must not stack duplicates.
 *
 * Two entries are the same key when the provider and the last four characters
 * match — the identifier the whole app already shows (`summary.lastFour`), and
 * one that can be compared without ever holding the plaintext side by side.
 */
export function dedupeKeys(
  existing: ApiKeySummary[],
  incoming: BundledKey[],
): { add: BundledKey[]; skipped: number } {
  const seen = new Set(existing.map((row) => `${row.provider}|${row.lastFour}`))
  const add: BundledKey[] = []
  let skipped = 0
  for (const entry of incoming) {
    const id = `${entry.provider}|${entry.secret.slice(-4)}`
    if (seen.has(id)) {
      skipped += 1
      continue
    }
    seen.add(id)
    add.push(entry)
  }
  return { add, skipped }
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export interface KeyBundleExport {
  bundle: KeyBundle
  /** Keys present locally but sealed under a vault the user has not unlocked. */
  undecryptable: number
}

/** Decrypts every key this machine can open and packages the provider setup. */
export async function createKeyBundle(): Promise<KeyBundleExport> {
  const summaries = await apiKeyRepo.list()
  const keys: BundledKey[] = []
  let undecryptable = 0

  for (const summary of summaries) {
    try {
      keys.push({
        provider: summary.provider,
        label: summary.label,
        secret: await apiKeyRepo.reveal(summary.id),
        models: summary.models ?? [],
        enabled: summary.enabled,
      })
    } catch {
      // Sealed under a passphrase the user has not typed. Counted, never
      // fatal — and the label travels, never the cipher.
      undecryptable += 1
    }
  }

  const providers: Record<string, BundledProvider> = {}
  for (const provider of PROVIDERS) {
    const model = await settingsRepo.get<string>(`ai.model.${provider.id}`, '')
    const baseUrl = await settingsRepo.get<string>(`ai.baseUrl.${provider.id}`, '')
    providers[provider.id] = {
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    }
  }

  return {
    bundle: buildKeyBundle({
      keys,
      providers,
      importedModels: await settingsRepo.get<BundledImportedModel[]>('ai.importedModels', []),
      activeProvider: await settingsRepo.get<string>(SETTING_KEYS.provider, 'gemini'),
      activeModel: await settingsRepo.get<string>(SETTING_KEYS.model, ''),
    }),
    undecryptable,
  }
}

/**
 * Triggers a download. The object URL is revoked right after the click
 * hand-off so no blob holding plaintext keys stays alive in memory.
 */
export async function downloadKeyBundle(): Promise<KeyBundleExport & { file: string }> {
  const created = await createKeyBundle()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = `aidt-keys-${stamp}.json`
  const blob = new Blob([serializeKeyBundle(created.bundle)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { ...created, file }
}

/** Re-seals every incoming key under this machine's key and applies settings. */
export async function importKeyBundle(bundle: KeyBundle): Promise<KeyBundleImportReport> {
  const { add, skipped } = dedupeKeys(await apiKeyRepo.list(), bundle.keys)

  for (const entry of add) {
    await apiKeyRepo.create({
      provider: entry.provider,
      label: entry.label,
      secret: entry.secret,
      models: entry.models,
      enabled: entry.enabled,
      passphrase: vaultPassphrase(),
    })
  }

  let providersUpdated = 0
  for (const [id, value] of Object.entries(bundle.providers ?? {})) {
    if (value.model) {
      await settingsRepo.set(`ai.model.${id}`, value.model, 'ai')
      providersUpdated += 1
    }
    if (value.baseUrl) await settingsRepo.set(`ai.baseUrl.${id}`, value.baseUrl, 'ai')
  }

  // The bundled list always wins: imported ids must never shadow one whose
  // limits the app actually knows.
  let modelsImported = 0
  const current = await settingsRepo.get<BundledImportedModel[]>('ai.importedModels', [])
  const known = new Set(current.map((spec) => `${spec.provider}/${spec.id}`))
  const merged = [...current]
  for (const spec of bundle.importedModels ?? []) {
    const key = `${spec.provider}/${spec.id}`
    if (known.has(key) || isBundledModel(spec.provider as ProviderId, spec.id)) continue
    known.add(key)
    merged.push(spec)
    modelsImported += 1
  }
  if (modelsImported > 0) {
    await settingsRepo.set('ai.importedModels', merged, 'ai')
    registerImportedModels(merged)
  }

  if (bundle.activeProvider) {
    await settingsRepo.set(SETTING_KEYS.provider, bundle.activeProvider, 'ai')
    if (bundle.activeModel) await settingsRepo.set(SETTING_KEYS.model, bundle.activeModel, 'ai')
  }

  return {
    keysAdded: add.length,
    keysSkipped: skipped,
    providersUpdated,
    modelsImported,
    activeProvider: bundle.activeProvider ?? null,
  }
}

/**
 * The import path shared by the file picker and the paste box.
 *
 * Both feed an untrusted string through the same validator, so pasted text
 * gets no more trust than a downloaded file: parse everything, write nothing
 * until the whole bundle checks out.
 */
export async function importKeyBundleFromText(json: string): Promise<KeyBundleImportReport> {
  return importKeyBundle(parseKeyBundle(json))
}
