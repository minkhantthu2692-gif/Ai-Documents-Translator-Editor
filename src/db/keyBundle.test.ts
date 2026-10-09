/**
 * Key / provider transfer.
 *
 * The security-critical part is `parseKeyBundle`: it reads an untrusted file
 * that holds *usable credentials*, so it must validate everything before a
 * single write, and no error it raises may echo a secret back into a toast.
 */

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase, setDb } from './db'
import {
  KEY_BUNDLE_FORMAT,
  KEY_BUNDLE_SCHEMA_VERSION,
  KeyBundleError,
  buildKeyBundle,
  createKeyBundle,
  dedupeKeys,
  importKeyBundle,
  importKeyBundleFromText,
  parseKeyBundle,
  serializeKeyBundle,
} from './keyBundle'
import { apiKeyRepo } from './repo-apiKeys'
import { settingsRepo } from './repo-settings'
import type { BundledKey } from './keyBundle'

const SECRET = 'sk-live-abcdef1234567890'

function key(overrides: Partial<BundledKey> = {}): BundledKey {
  return {
    provider: 'gemini',
    label: 'Main',
    secret: SECRET,
    models: ['gemini-2.5-flash'],
    enabled: true,
    ...overrides,
  }
}

function validJson(): string {
  return serializeKeyBundle(
    buildKeyBundle({
      keys: [key()],
      providers: { gemini: { model: 'gemini-2.5-flash', baseUrl: 'https://example.test' } },
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
    }),
  )
}

describe('parseKeyBundle', () => {
  it('round-trips a bundle this app wrote', () => {
    const bundle = parseKeyBundle(validJson())
    expect(bundle.format).toBe(KEY_BUNDLE_FORMAT)
    expect(bundle.schemaVersion).toBe(KEY_BUNDLE_SCHEMA_VERSION)
    expect(bundle.secrets).toBe(true)
    expect(bundle.keys).toEqual([key()])
    expect(bundle.providers.gemini).toEqual({
      model: 'gemini-2.5-flash',
      baseUrl: 'https://example.test',
    })
    expect(bundle.activeProvider).toBe('gemini')
  })

  it('rejects anything that is not this file format', () => {
    expect(() => parseKeyBundle('not json at all')).toThrow(KeyBundleError)
    expect(() => parseKeyBundle('[]')).toThrow(KeyBundleError)
    expect(() => parseKeyBundle(JSON.stringify({ format: 'aidt-backup', keys: [] }))).toThrow(
      /Unexpected format/,
    )
    expect(() => parseKeyBundle(JSON.stringify({}))).toThrow(/Unexpected format/)
  })

  it('rejects a schema it does not understand', () => {
    expect(() =>
      parseKeyBundle(JSON.stringify({ format: KEY_BUNDLE_FORMAT, schemaVersion: 2, keys: [] })),
    ).toThrow(/newer than supported/)
    expect(() => parseKeyBundle(JSON.stringify({ format: KEY_BUNDLE_FORMAT }))).toThrow(
      /no schema version/,
    )
  })

  it('rejects a file with no keys array', () => {
    expect(() =>
      parseKeyBundle(JSON.stringify({ format: KEY_BUNDLE_FORMAT, schemaVersion: 1 })),
    ).toThrow(/no keys array/)
  })

  it('rejects an entry that is missing a provider or a usable secret', () => {
    const base = { format: KEY_BUNDLE_FORMAT, schemaVersion: 1 }
    expect(() => parseKeyBundle(JSON.stringify({ ...base, keys: [{ secret: SECRET }] }))).toThrow(
      /Key #1 has no provider/,
    )
    expect(() =>
      parseKeyBundle(JSON.stringify({ ...base, keys: [{ provider: 'groq', secret: 'short' }] })),
    ).toThrow(/Key #1 has a secret that is missing or too short/)
    expect(() => parseKeyBundle(JSON.stringify({ ...base, keys: [null] }))).toThrow(
      /Key #1 is not an object/,
    )
  })

  it('never echoes a secret back in an error message', () => {
    // The file is untrusted and full of credentials: a toast is the last place
    // one of them should be able to end up.
    const hostile = JSON.stringify({
      format: KEY_BUNDLE_FORMAT,
      schemaVersion: 1,
      keys: [{ provider: 'groq', secret: SECRET }],
    })
    try {
      parseKeyBundle(hostile)
      throw new Error('expected a throw')
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SECRET)
      expect(String((error as Error).message)).not.toContain('abcdef')
    }
  })

  it('truncates the echoed format rather than reprinting attacker input', () => {
    const long = 'x'.repeat(200)
    try {
      parseKeyBundle(JSON.stringify({ format: long, schemaVersion: 1, keys: [] }))
      throw new Error('expected a throw')
    } catch (error) {
      expect(String((error as Error).message).length).toBeLessThan(80)
    }
  })

  it('fills in the safe defaults an older or hand-edited file may omit', () => {
    const bundle = parseKeyBundle(
      JSON.stringify({
        format: KEY_BUNDLE_FORMAT,
        schemaVersion: 1,
        keys: [{ provider: '  groq  ', secret: '  ' + SECRET + '  ' }],
      }),
    )
    expect(bundle.keys[0]).toEqual({
      provider: 'groq',
      label: 'groq',
      secret: SECRET,
      models: [],
      enabled: true,
    })
    expect(bundle.providers).toEqual({})
    expect(bundle.importedModels).toEqual([])
  })

  it('drops malformed provider blocks and imported models instead of failing', () => {
    const bundle = parseKeyBundle(
      JSON.stringify({
        format: KEY_BUNDLE_FORMAT,
        schemaVersion: 1,
        keys: [key()],
        providers: { gemini: { model: 'm' }, broken: 'nope', other: { baseUrl: 'https://b' } },
        importedModels: [{ provider: 'groq', id: 'x', label: 'X' }, { provider: 'groq' }, 'nope'],
      }),
    )
    expect(Object.keys(bundle.providers).sort()).toEqual(['gemini', 'other'])
    expect(bundle.importedModels).toHaveLength(1)
  })
})

describe('dedupeKeys', () => {
  const summary = (provider: string, lastFour: string) =>
    ({ provider, lastFour, label: 'x' }) as never

  it('skips a key this machine already has, matched on provider + last four', () => {
    const { add, skipped } = dedupeKeys([summary('gemini', '7890')], [key()])
    expect(add).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('keeps a different key for the same provider', () => {
    const { add, skipped } = dedupeKeys([summary('gemini', '1111')], [key()])
    expect(add).toHaveLength(1)
    expect(skipped).toBe(0)
  })

  it('collapses duplicates inside the file itself', () => {
    const { add, skipped } = dedupeKeys(
      [],
      [key({ label: 'one' }), key({ label: 'two' }), key({ provider: 'groq', label: 'three' })],
    )
    expect(add.map((entry) => entry.label)).toEqual(['one', 'three'])
    expect(skipped).toBe(1)
  })
})

describe('export → import round trip', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-keys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    await db.apiKeys.clear()
    await db.settings.clear()
  })

  it('carries a key to another machine by re-sealing it locally', async () => {
    await apiKeyRepo.create({ provider: 'groq', label: 'Team', secret: SECRET })
    await settingsRepo.set('ai.model.groq', 'llama-3.3-70b', 'ai')
    await settingsRepo.set('ai.baseUrl.groq', 'https://gw.example.test', 'ai')
    await settingsRepo.set('ai.provider', 'groq', 'ai')

    const { bundle, undecryptable } = await createKeyBundle()
    expect(undecryptable).toBe(0)
    expect(bundle.keys).toHaveLength(1)
    expect(bundle.keys[0].secret).toBe(SECRET)
    expect(bundle.providers.groq).toEqual({
      model: 'llama-3.3-70b',
      baseUrl: 'https://gw.example.test',
    })

    // A fresh database stands in for the other browser profile: the sealed
    // cipher above would be worthless here, the plaintext is re-sealed instead.
    const fresh = new AppDatabase(`aidt-keys-b-${Date.now()}`)
    setDb(fresh)
    await fresh.open()
    await fresh.apiKeys.clear()
    await fresh.settings.clear()

    const report = await importKeyBundle(parseKeyBundle(serializeKeyBundle(bundle)))
    expect(report.keysAdded).toBe(1)
    expect(report.keysSkipped).toBe(0)
    expect(report.providersUpdated).toBe(1)
    expect(report.activeProvider).toBe('groq')

    const restored = await apiKeyRepo.list()
    expect(restored).toHaveLength(1)
    expect(restored[0].provider).toBe('groq')
    expect(restored[0].lastFour).toBe('7890')
    // The proof it actually works: the new machine can open the secret again.
    await expect(apiKeyRepo.reveal(restored[0].id)).resolves.toBe(SECRET)
    await expect(settingsRepo.get('ai.baseUrl.groq', '')).resolves.toBe('https://gw.example.test')
    await expect(settingsRepo.get('ai.provider', '')).resolves.toBe('groq')
  })

  it('adds nothing when the same file is imported twice', async () => {
    await apiKeyRepo.create({ provider: 'gemini', label: 'Main', secret: SECRET })
    const { bundle } = await createKeyBundle()

    const first = await importKeyBundle(bundle)
    expect(first.keysAdded).toBe(0)
    expect(first.keysSkipped).toBe(1)

    const second = await importKeyBundle(bundle)
    expect(second.keysAdded).toBe(0)
    expect(second.keysSkipped).toBe(1)
    expect(await apiKeyRepo.list()).toHaveLength(1)
  })
})

describe('importKeyBundleFromText (paste path)', () => {
  beforeEach(async () => {
    const db = new AppDatabase(`aidt-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    await db.apiKeys.clear()
    await db.settings.clear()
  })

  it('imports a bundle pasted as text exactly like one read from a file', async () => {
    await apiKeyRepo.create({ provider: 'gemini', label: 'Main', secret: SECRET })
    const { bundle } = await createKeyBundle()

    const report = await importKeyBundleFromText(serializeKeyBundle(bundle))
    expect(report.keysAdded).toBe(0)
    expect(report.keysSkipped).toBe(1)
    expect(await apiKeyRepo.list()).toHaveLength(1)
  })

  it('writes nothing when the pasted text fails validation', async () => {
    // The paste box is a direct line into the database, so a rejected bundle
    // must not leave even a half-applied provider setting behind.
    await expect(importKeyBundleFromText('{ not json')).rejects.toThrow(KeyBundleError)
    await expect(
      importKeyBundleFromText(JSON.stringify({ format: 'aidt-backup', schemaVersion: 1 })),
    ).rejects.toThrow(KeyBundleError)

    expect(await apiKeyRepo.list()).toHaveLength(0)
    await expect(settingsRepo.get('ai.model.groq', '')).resolves.toBe('')
  })
})
