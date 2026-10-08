import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig, type Plugin } from 'vitest/config'

/** pdf.js data files we forward at runtime: CMaps and base-14 font programs. */
const PDFJS_DATA_DIRS = ['cmaps', 'standard_fonts'] as const

function pdfjsSource(): string {
  return path.join(fileURLToPath(new URL('./', import.meta.url)), 'node_modules', 'pdfjs-dist')
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.mjs') || file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.bcmap')) return 'application/octet-stream'
  if (file.endsWith('.pfb')) return 'application/octet-stream'
  return 'application/octet-stream'
}

/**
 * Serves `pdfjs-dist`'s data files under `<base>pdfjs-assets/`:
 * a middleware in dev, a copy into `dist/` on build. They are fetched lazily by
 * pdf.js (never bundled), which is what lets us decode CJK/Cyrillic encodings
 * and render the standard fonts correctly.
 *
 * @param base Deploy base path (`/` by default, `/REPO/` on GitHub Pages).
 */
function pdfjsAssets(base: string): Plugin {
  const prefix = '/pdfjs-assets/'
  let root = process.cwd()
  let outDir = path.join(root, 'dist')

  return {
    name: 'pdfjs-assets',
    configResolved(config) {
      root = config.root
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let url = (request.url ?? '').split('?')[0]
        // With a non-root base the browser asks for `/REPO/pdfjs-assets/…`.
        if (base !== '/' && url.startsWith(base)) {
          url = `/${url.slice(base.length)}`
        }
        if (!url.startsWith(prefix)) return next()
        const relative = decodeURIComponent(url.slice(prefix.length)).replace(/\\/g, '/')
        if (!relative || relative.split('/').includes('..')) return next()

        const source = pdfjsSource()
        const file = path.join(source, relative)
        if (!file.startsWith(source + path.sep)) return next()

        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next()

        response.setHeader('Content-Type', contentTypeFor(file))
        fs.createReadStream(file).pipe(response)
      })
    },
    writeBundle() {
      const source = pdfjsSource()
      for (const dir of PDFJS_DATA_DIRS) {
        const from = path.join(source, dir)
        if (!fs.existsSync(from)) continue
        fs.cpSync(from, path.join(outDir, 'pdfjs-assets', dir), { recursive: true })
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  // Configurable base path: `VITE_BASE=/Ai-Documents-Translator-Editor/` for a
  // GitHub Pages project site (deploy.yml sets it), `/` everywhere else.
  const env = loadEnv(mode, process.cwd(), '')
  const rawBase = (env.VITE_BASE ?? '').trim() || '/'
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`

  return {
    base,
    plugins: [react(), pdfjsAssets(base)],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // The analysis worker is ESM (it imports pdf.js); keep its output format
    // aligned so `import()` of pdf.js's message handler works inside it.
    worker: {
      format: 'es',
    },
    server: {
      port: 5173,
      strictPort: false,
    },
    preview: {
      port: 4173,
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom', 'react-i18next', 'i18next'],
            db: ['dexie', 'dexie-react-hooks'],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: false,
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
    },
  }
})
