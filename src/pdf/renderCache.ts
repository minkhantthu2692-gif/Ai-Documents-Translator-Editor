/**
 * LRU cache of object URLs for rendered pages.
 *
 * Thumbnails and backgrounds come back from the worker as Blobs; turning one
 * into an `img` source needs an object URL, and those must be revoked or the
 * browser keeps every rasterised page alive forever. The cache therefore holds
 * *URLs only*: at most `MAX_ENTRIES` blobs at a time, evicted oldest-first on
 * access (get promotes to most-recently-used), which is what keeps memory flat
 * while scrolling a 300-page strip.
 */

const MAX_ENTRIES = 48

/** Insertion order doubles as LRU order (Map iteration is insertion order). */
const urls = new Map<string, string>()

function evict(): void {
  while (urls.size > MAX_ENTRIES) {
    const oldest = urls.keys().next()
    if (oldest.done) break
    const url = urls.get(oldest.value)
    if (url) URL.revokeObjectURL(url)
    urls.delete(oldest.value)
  }
}

export function renderCacheKey(
  fileId: string,
  pageIndex: number,
  mode: 'thumbnail' | 'background',
  scale: number,
): string {
  return `${fileId}#${pageIndex}#${mode}#${scale.toFixed(3)}`
}

/** Returns a live URL for `key`, promoting it to the front of the LRU. */
export function getCachedUrl(key: string): string | null {
  const url = urls.get(key)
  if (!url) return null
  urls.delete(key)
  urls.set(key, url)
  return url
}

/** Stores a blob under `key` and returns its URL (replacing any previous one). */
export function putCachedUrl(key: string, blob: Blob): string {
  const previous = urls.get(key)
  if (previous) {
    urls.delete(key)
    URL.revokeObjectURL(previous)
  }
  const url = URL.createObjectURL(blob)
  urls.set(key, url)
  evict()
  return url
}

/** Revokes everything (project deleted, worker reset, tests). */
export function clearRenderCache(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
}

/** Number of live entries — asserted by tests, handy in the event log. */
export function renderCacheSize(): number {
  return urls.size
}
