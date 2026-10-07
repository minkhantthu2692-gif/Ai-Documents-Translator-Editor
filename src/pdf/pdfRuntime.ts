/**
 * Runtime shims needed by pdf.js.
 *
 * The *modern* pdf.js build assumes two stage-3 proposals that newer
 * browsers/Node ship but older runtimes lack:
 *
 *   - `Uint8Array.prototype.toHex`       (document fingerprints)
 *   - `Map.prototype.getOrInsert[Computed]` (per-document memoisation)
 *
 * pdf.js's own legacy build patches both with core-js. Because we bundle the
 * modern build (and because Vitest runs it under Node), the same shims live
 * here. Each is installed once, before any document is opened, and only when
 * genuinely missing.
 */
let ensured = false

/** `Uint8Array.prototype.toHex` is not in TypeScript's lib yet. */
type Uint8ArrayWithToHex = Uint8Array & { toHex?: () => string }

/** `Map.prototype.getOrInsert*` are not in TypeScript's lib yet. */
type MapWithUpsert<K, V> = Map<K, V> & {
  getOrInsert?: (key: K, value: V) => V
  getOrInsertComputed?: (key: K, callback: (key: K) => V) => V
}

function defineOn<T extends object>(target: T, key: string, descriptor: PropertyDescriptor): void {
  try {
    Object.defineProperty(target, key, { enumerable: false, configurable: true, ...descriptor })
  } catch {
    // Frozen built-ins: pdf.js would fail loudly anyway if the shim matters.
  }
}

export function ensurePdfRuntimeSupport(): void {
  if (ensured) return
  ensured = true

  const bytes = Uint8Array.prototype as Uint8ArrayWithToHex
  if (typeof bytes.toHex !== 'function') {
    defineOn(bytes, 'toHex', {
      writable: true,
      value: function toHex(this: Uint8Array): string {
        let out = ''
        for (let index = 0; index < this.length; index += 1) {
          out += this[index].toString(16).padStart(2, '0')
        }
        return out
      },
    })
  }

  const map = Map.prototype as MapWithUpsert<unknown, unknown>
  if (typeof map.getOrInsert !== 'function') {
    defineOn(map, 'getOrInsert', {
      writable: true,
      value: function getOrInsert(
        this: MapWithUpsert<unknown, unknown>,
        key: unknown,
        value: unknown,
      ): unknown {
        if (this.has(key)) return this.get(key)
        this.set(key, value)
        return value
      },
    })
  }
  if (typeof map.getOrInsertComputed !== 'function') {
    defineOn(map, 'getOrInsertComputed', {
      writable: true,
      value: function getOrInsertComputed(
        this: MapWithUpsert<unknown, unknown>,
        key: unknown,
        callback: (key: unknown) => unknown,
      ): unknown {
        if (this.has(key)) return this.get(key)
        const value = callback(key)
        this.set(key, value)
        return value
      },
    })
  }
}
