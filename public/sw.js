/* Service worker: offline application shell for AI Documents Translator & Editor.
 *
 * Strategy
 *  - Navigations: network-first with cached shell fallback (works offline after first visit).
 *  - Same-origin static assets: stale-while-revalidate so a new deploy is picked up quietly.
 *  - Cross-origin requests (fonts, OCR assets, provider APIs) are never cached here; those
 *    are handled by the application layer with its own Dexie-backed cache.
 *
 * CACHE_VERSION must be bumped when the shell markup changes so old clients refresh.
 */
const CACHE_VERSION = 'v1'
const SHELL_CACHE = `aidt-shell-${CACHE_VERSION}`
const RUNTIME_CACHE = `aidt-runtime-${CACHE_VERSION}`

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-maskable.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch((error) => {
        // A single missing asset must not break installation of the shell.
        console.warn('[sw] shell precache incomplete', error)
      }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
  if (event.data && event.data.type === 'GET_CACHE_VERSION') {
    event.ports && event.ports[0] && event.ports[0].postMessage({ version: CACHE_VERSION })
  }
})

async function networkFirstNavigation(request) {
  try {
    const fresh = await fetch(request)
    const cache = await caches.open(RUNTIME_CACHE)
    cache.put(request, fresh.clone())
    return fresh
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return cached
    const shell = (await caches.match('/index.html')) || (await caches.match('/'))
    if (shell) return shell
    throw error
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => undefined)
  if (cached) {
    await network
    return cached
  }
  const fresh = await network
  if (fresh) return fresh
  throw new Error('offline and not cached')
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.svg')
  ) {
    event.respondWith(staleWhileRevalidate(request))
  }
})
