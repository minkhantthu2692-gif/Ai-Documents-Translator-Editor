# AI Documents Translator & Editor

**Offline-first AI document translator and editor** — translate PDF documents while keeping
their layout, fonts and images, edit the result block by block, and export it in many formats.
Everything runs in your browser with an English + မြန်မာ (Myanmar) interface; cloud sync and
the AI troubleshooting assistant are strictly optional.

- **Local-first** — documents live in IndexedDB on your device, not on a server.
- **BYOK** — bring your own Gemini, OpenRouter, Groq or OpenAI-compatible key.
- **Installable PWA** — offline application shell, works without a connection.

Repository: <https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor>

## Features

**Document model & editor** (Phase 1)

- Projects → pages → blocks document model with an IndexedDB (Dexie) schema and migrations.
- Block editor with undo/redo history, find & replace, split view, inspector and revisions.
- Bilingual UI (English + Myanmar), light / dark / system theme, fully responsive layout.

**PDF import & analysis** (Phase 2)

- PDF pick with pre-flight checks: password-protected, too large, no text layer, corrupt.
- pdf.js parsing and layout extraction in a Web Worker; page thumbnails and rendering cache.
- OCR (tesseract.js) for scanned/image pages, with offline language packs after one download.
- Document metadata and page classification (text vs. scanned).

**Translation engine** (Phase 3)

- Providers: Google Gemini, OpenRouter, Groq and any OpenAI-compatible endpoint.
- Key pool with rotation, per-key cooldowns, rate-limit buckets and model fallback chains.
- Batching of 15–25 lines or ~1500 tokens per request, with a retry ladder that splits a
  failing batch, then falls back to line-by-line, and never drops or reorders a line.
- Adaptive concurrency (AIMD) so free-tier keys are not hammered; offline/429 auto-parking.
- Glossary/terminology enforcement, translation memory, confidence scores and quality flags.
- Job queue with pause / resume / cancel, and automatic resume after a page refresh.

**Export & data** (Phase 4)

- Export to DOCX, EPUB, PDF (print), raster PDF, bilingual PDF, HTML, Markdown, TXT, JSON,
  CSV/TSV and zipped per-page images — most of it in a Web Worker with progress reporting.
- JSON backup / restore of every table (API keys travel sealed and only open on their device).
- Logs page with machine-readable reason codes, suggested fixes and JSON export.
- Writing assistant toggle, usage charts, and Settings tabs for General, Cache, Data,
  Providers, Assistant and About.

**Cloud sync & troubleshooting assistant** (Phase 5 — current)

- Optional Google Sheets sync through `apps-script/Code.gs`: shared-secret token, LockService,
  chunked push/pull, tombstoned deletes, per-entity toggles, auto-sync, Sync Now, test
  connection, wipe cloud and delete local.
- Sync engine in `src/sync/`: outbox → delta push → paged pull → last-write-wins merge with a
  local conflict log; offline runs fail fast and retry when the connection returns.
- Troubleshooting Assistant in `src/assistant/`: proxy mode (your own `proxy/` server) or a
  fully offline rule-based fallback, with automatic secret redaction and one-click safe actions.
- `.env.example`, launcher scripts under `tools/`, and a GitHub Pages deploy workflow.

## Quick start

**Prerequisites:** Node.js ≥ 18 (20 recommended), npm, and a modern browser.

```bash
git clone https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor.git
cd Ai-Documents-Translator-Editor
npm install
npm run dev
```

Open <http://localhost:5173>. Optional: `cp .env.example .env` if you plan to enable cloud
sync or the assistant proxy (the app runs fully without it).

**One-click alternatives**

| Option | What it does |
| --- | --- |
| `tools/open-app.bat` (Windows) / `tools/open-app.sh` (macOS/Linux) | Checks Node ≥ 18, installs dependencies when missing, copies `.env.example` → `.env` once, starts Vite and opens <http://localhost:5173> |
| `tools/launcher.html` | Double-clickable bilingual start page with a setup checklist, copy buttons for each command, an environment check and an **Open app** button |
| `tools/push-to-github.bat` / `tools/push-to-github.sh` | Guided commit + push to `main`; verifies `.gitignore` covers `.env`, `node_modules` and `dist`, and never stores credentials |

## Scripts and quality gate

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server at <http://localhost:5173> |
| `npm run build` | `tsc --noEmit` then `vite build` → `dist/` |
| `npm run preview` | Serve the production build locally (port 4173) |
| `npm test` / `npx vitest run` | Unit tests (Vitest + Testing Library + fake-indexeddb) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` / `npm run lint:fix` | ESLint over the whole repo |
| `npx prettier --check .` | Prettier formatting check (`.md` files are ignored) |
| `npm run typecheck` | `tsc --noEmit` only |
| `npm run smoke` | Headless-Chrome CDP smoke test against a **running** dev server |

**Full gate — run before every commit / PR:**

```bash
npx tsc --noEmit
npx eslint .
npx prettier --check .
npx vitest run
npm run build
npm run dev &        # in a second terminal, on :5173
npm run smoke
```

`npm run smoke` needs Chrome installed, `fixtures/` present (build them with
`node scripts/make-fixtures.mjs`) and the dev server already running.

## Environment variables

Copy `.env.example` to `.env` (git-ignored) and edit. All values are optional.

| Variable | Required for | Purpose |
| --- | --- | --- |
| `VITE_APPS_SCRIPT_URL` | Cloud sync | Apps Script web-app endpoint ending in `/exec`. Empty = everything stays in this browser |
| `VITE_APPS_SCRIPT_TOKEN` | Cloud sync | Shared secret you set as the `TOKEN` Script Property; mismatches are rejected with `UNAUTHORIZED` |
| `VITE_ASSISTANT_PROXY_URL` | Assistant proxy mode | Base URL of the `proxy/` server (e.g. `http://127.0.0.1:8787`). Empty = built-in offline assistant |
| `VITE_PDF_SIDECAR_URL` | Local OCR, plus a fallback text reader | Base URL of `sidecar/server.py`. Unset = `http://localhost:8790` (auto-detected when running). Empty = sidecar off, browser OCR and browser text extraction only |
| `VITE_BASE` | Sub-path hosting | Base path the app is served from, e.g. `/REPO_NAME/` for a GitHub Pages project site |

> Values are baked in **at build time** — restart `npm run dev` or rebuild after editing `.env`.
> Never put a provider API key or the assistant key in a `VITE_` variable: anything prefixed
> `VITE_` is bundled into the public JavaScript.

## Cloud sync (optional)

Each device keeps its own IndexedDB copy as the **source of truth**. A Google Sheet acts as a
shared relay: **Settings → Data → Cloud sync** pushes local changes and pulls remote ones
(`ping`, `pushChanges`, `pullChanges`, `listProjects`, `getProject`, `upsertBlocks`,
`deleteProject`, `backup`, `wipe`), merging with last-write-wins and recording every overwrite
in a local conflict log. API keys and secret-looking settings are never uploaded.

Step-by-step setup (create the Sheet, paste `apps-script/Code.gs` and `appsscript.json`, set
the `TOKEN` Script Property, deploy as a web app):

**→ [docs/GOOGLE_APPS_SCRIPT_SETUP.md](docs/GOOGLE_APPS_SCRIPT_SETUP.md)**
(မြန်မာ: [docs/GOOGLE_APPS_SCRIPT_SETUP.my.md](docs/GOOGLE_APPS_SCRIPT_SETUP.my.md))

## Troubleshooting assistant (optional)

Explains errors in plain language and proposes fix steps from the same structured context the
Logs page carries, in two modes:

| Mode | When | How |
| --- | --- | --- |
| Proxy | `VITE_ASSISTANT_PROXY_URL` points at `proxy/` | Browser sends `{question, context, lang}` to `POST /assistant`; your proxy calls OpenRouter with a key that lives **only** server-side |
| Offline rules | No proxy URL, or no network | Built-in rule engine maps reason codes to explanations — no request at all |

One-click safe actions (rotate-key, reduce-batch, clear-cache, retry, open-providers,
open-data, open-logs) run entirely on your device.

- **→ [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — every reason code and fix
  ([မြန်မာ](docs/TROUBLESHOOTING.my.md))
- **→ [docs/API_KEYS_GUIDE.md](docs/API_KEYS_GUIDE.md)** — where to get keys, how they are
  stored ([မြန်မာ](docs/API_KEYS_GUIDE.my.md))
- **→ [proxy/README.md](proxy/README.md)** — proxy contract, limits and deployment

## Data & privacy

- Your documents, glossary, logs and settings stay in **your browser's IndexedDB**. Nothing is
  uploaded unless you explicitly turn on cloud sync.
- **No telemetry, no analytics, no error reporting.** The app makes no network requests on its
  own; requests happen only when *you* start a translation, enable sync, download OCR data or
  ask the assistant.
- Provider API keys are sealed with WebCrypto (AES-GCM + PBKDF2) before they touch storage and
  are never included in backups in plaintext. They are not synced either — unless you switch on
  the separate, off-by-default **API keys** sync, which writes their readable values to your own
  Google Sheet on purpose (see **[docs/SECURITY.md](docs/SECURITY.md)**).
- `.env`, `.env.*` and `.env.example` handling, redaction rules and the disclosure policy are
  described in **[docs/SECURITY.md](docs/SECURITY.md)**.

## Project structure

```text
.
├── src/                 React app
│   ├── pages/           Dashboard, projects, workspace, translate, settings, logs, knowledge
│   ├── components/      layout / ui / workspace / charts components
│   ├── editor/          block editor, history, sanitize, font + autofit logic
│   ├── translate/       batching, engine, executor, key pool, queue, terminology
│   ├── pdf/             pre-flight, pdf.js extraction, layout, render cache
│   ├── export/          DOCX / EPUB / PDF / HTML / text / JSON / CSV exporters
│   ├── providers/       Gemini, OpenAI-compatible (OpenRouter, Groq) adapters
│   ├── sync/            outbox, protocol, engine, LWW merge, SyncBootstrap
│   ├── assistant/       redaction, offline rules, safe actions, dialog client
│   ├── db/              Dexie schema (v7) + repositories + backup
│   ├── i18n/            en.json / my.json + coverage tests
│   └── workers/         analysis, translation and export Web Workers
├── apps-script/         Code.gs + appsscript.json — Google Sheets sync backend
├── proxy/               Troubleshooting Assistant proxy (Node/Express + Cloudflare Worker)
├── public/              hand-written service worker (sw.js), manifest, icons
├── scripts/             smoke test and fixture builders
├── tools/               launcher.html, open-app.*, push-to-github.*
├── docs/                documentation (this folder, plus bilingual guides)
└── .github/workflows/   deploy.yml — GitHub Pages
```

## Documentation

| Document | Language | Contents |
| --- | --- | --- |
| [README.my.md](README.my.md) | မြန်မာ | This README in Myanmar |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | English | Layers, sync data flow, translation pipeline, offline/PWA |
| [docs/SECURITY.md](docs/SECURITY.md) | English | Threat model, key storage, redaction, disclosure |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | English | Local build, GitHub Pages, self-hosting, proxy deploy |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | English | Setup, the full gate, style, tests, i18n, testids |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | English | Keep-a-Changelog release notes |
| [docs/LICENSE](docs/LICENSE) | English | MIT license text |
| [docs/GOOGLE_APPS_SCRIPT_SETUP.md](docs/GOOGLE_APPS_SCRIPT_SETUP.md) | English · မြန်မာ | Click-by-click cloud sync setup |
| [docs/API_KEYS_GUIDE.md](docs/API_KEYS_GUIDE.md) | English · မြန်မာ | Getting and storing provider keys |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | English · မြန်မာ | Reason codes, sync errors, assistant |
| [proxy/README.md](proxy/README.md) | English | Assistant proxy contract and deployment |

Bilingual convention: a `.my.md` sibling is the Myanmar version of the same document.

## Contributing

Issues and pull requests are welcome. Read **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**
first — in particular the full gate (`tsc` · `eslint` · `prettier` · `vitest` · `build` ·
`smoke`), the rule that every new UI string needs both `en.json` and `my.json`, and the
`data-testid` contract used by the smoke test.

## License

MIT — see [docs/LICENSE](docs/LICENSE).
Copyright (c) 2026 minkhantthu2692-gif.

## Changelog

See [docs/CHANGELOG.md](docs/CHANGELOG.md).
