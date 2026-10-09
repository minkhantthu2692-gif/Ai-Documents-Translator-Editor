# Changelog

Notable changes to **AI Documents Translator & Editor**, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Dates are only added when a release is actually
cut — everything under `Unreleased` is work in progress on `main`.

## [Unreleased]

Phase 5 — cloud sync and the troubleshooting assistant.

### Added

- **Google Apps Script cloud sync** (`apps-script/Code.gs`, `apps-script/appsscript.json`):
  a stateless web-app backend over a Google Sheet with tabs **Projects**, **Pages**,
  **Blocks**, **Glossary**, **Settings**, **UsageStats**, **ApiKeys** and **SyncLog**;
  shared-secret token
  (`UNAUTHORIZED` on mismatch), `LockService` to serialise writers, chunked writes, tombstoned
  deletes and the actions `ping`, `pushChanges`, `pullChanges`, `listProjects`, `getProject`,
  `upsertBlocks`, `deleteProject`, `backup`, `wipe`.
- **Sync engine** (`src/sync/`): outbox-based delta push, paged pull, last-write-wins merge
  mirroring the server rule (updatedAt → version → deviceId), a local `syncConflicts` log,
  per-entity selective sync, conflict policy (`newest` / `local` / `remote`), auto-sync on an
  interval, offline fail-fast with retry on reconnect, **Sync Now**, test connection, wipe
  cloud and delete local — all in Settings → Data.
- **Settings-side sync controls**: a dedicated **Provider settings** switch (on by default) so
  `ai.*` provider configuration travels independently of theme/language/cache prefs; a separate,
  off-by-default **API keys** switch; a **Download Code.gs** / manifest pair and an in-Settings
  setup guide (Settings → Data), so the backend can be stood up without finding the repository.
- `ping` now reports the entities a deployment can store. Because `Code.gs` validates a whole
  batch before writing anything, an unknown entity would fail *every* push — key rows are held
  in the outbox (with backoff) until the server says it accepts them, so a deployment that
  predates the `ApiKeys` tab cannot take the rest of the sync down with it.
- **Troubleshooting Assistant** (`src/assistant/`): proxy mode through `proxy/` (Node/Express
  `server.js` and `cloudflare-worker.js`) plus an offline rule-based fallback, automatic secret
  redaction (`src/assistant/redact.ts`) and one-click safe actions (`rotate-key`,
  `reduce-batch`, `clear-cache`, `retry`, `open-providers`, `open-data`, `open-logs`).
- **`.env.example`** documenting `VITE_APPS_SCRIPT_URL`, `VITE_APPS_SCRIPT_TOKEN`,
  `VITE_ASSISTANT_PROXY_URL` and `VITE_BASE`.
- **Tooling**: `tools/launcher.html` bilingual start page, `tools/open-app.bat|.sh` one-click
  dev launcher, `tools/push-to-github.bat|.sh` guided commit/push.
- **GitHub Pages deployment**: `.github/workflows/deploy.yml` (type check → tests → build →
  `404.html` SPA fallback → deploy) with a configurable repository variable `VITE_BASE`.
- Schema **v7**: `syncConflicts` (LWW conflict log) and `syncMeta` (pull cursor, push cursors,
  per-device version vector); the token setting is stored sealed and never synced.
- Documentation: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`,
  `docs/CONTRIBUTING.md`, `docs/CHANGELOG.md`, `docs/LICENSE`, `README.md`, `README.my.md`.
- **Heading hierarchy** in PDF extraction (phase (c) of `docs/PDF_TYPES_SUPPORT.md`): the probe
  builds one document-wide ladder of heading font sizes (`src/pdf/headings.ts`) and every page
  levels its headings 1–6 against it, so a section keeps its depth even on pages where its
  chapter title is absent. HTML emits `h1`–`h6`, DOCX `HeadingLevel.HEADING_1–6`, EPUB chapter
  headings and Markdown ATX hashes — each offset past the structural headings that builder
  already prints and clamped at six, with `.block` neutralising the browser's default heading
  styles so the printed page is unchanged.

### Security

- Settings rows whose id or field looks like a credential (`key`, `token`, `secret`,
  `password`, `authorization`) are filtered out client-side and rejected server-side with
  `SECRET_NOT_ALLOWED`, on whatever toggles are set — `sync.tokens` and friends can never
  travel. The guard covers the `Settings` tab; a *boolean* value is never treated as a
  credential, so the `apiKeys: true` switch inside `sync.entities` is not caught by it.
- **Provider keys sync only if you ask for it.** A separate, off-by-default **API keys** switch
  writes each key's readable value to the `ApiKeys` tab of your own Sheet; the UI states that
  plainly before it is switched on. Only identifying fields travel (provider, label, models,
  enabled, last four, secret, createdAt) — counters, cooldowns and probe results stay local so
  one device cannot clobber another's. The sealed payload is opened while the request is built,
  so no readable secret reaches IndexedDB, the outbox or a log line; a delete tombstone carries
  no payload; and an incoming key is re-sealed locally before storage, with a remote `cipher`
  never trusted.
- The sync token is stored sealed, shown only as its last four characters, and is never
  written to logs.

## 0.1.0 — initial release

Phases 1–4: the local-first application, PDF import, the translation engine and export.

### Added

- **Phase 1 — document model and editor**
  - Projects → pages → blocks model on Dexie (IndexedDB) with versioned schema migrations.
  - Block editor with undo/redo history, find & replace, split view, block inspector,
    revisions and templates.
  - Bilingual UI (English + Myanmar) via react-i18next, light/dark/system theme, responsive
    layout from desktop down to a mobile bottom tab bar.
  - Settings (General, Cache, Data, Providers, Assistant, About) and a Logs page with
    machine-readable reason codes, suggested fixes and JSON export.
  - Event/state model: every state change emits
    `{timestamp, state, pageIndex, lineIndex, reasonCode, messageMy, messageEn,
    technicalDetail, fixActions[]}`.
- **Phase 2 — PDF import and analysis**
  - PDF pick with pre-flight validation (password-protected, corrupt, too large, too many
    pages, no text layer) and a password prompt with retry.
  - pdf.js parsing in a Web Worker: page rendering, layout extraction into blocks, line
    grouping, page classification, thumbnails and a render cache.
  - OCR (tesseract.js) for scanned pages with offline language packs, plus document metadata.
- **Phase 3 — translation engine**
  - BYOK providers: Google Gemini, OpenRouter, Groq and any OpenAI-compatible endpoint, with
    model discovery and a bundled fallback model list.
  - Sealed API-key storage (WebCrypto AES-GCM + PBKDF2) with device-bound or passphrase vault
    modes, a key pool with rotation, cooldowns and rate-limit buckets.
  - Batching of 15–25 lines or ~1500 tokens, a repair ladder that halves a failing batch then
    falls back to line-by-line without dropping or reordering lines, adaptive concurrency
    (AIMD), glossary/terminology enforcement, translation memory, confidence and quality flags.
  - Job queue with pause/resume/cancel and resume-after-refresh; usage statistics.
- **Phase 4 — export and data**
  - Exporters: DOCX, EPUB, PDF via print, raster PDF, bilingual PDF, HTML, Markdown, TXT,
    JSON, CSV/TSV and zipped per-page images, built in an export worker with progress.
  - JSON backup / restore for every table (API keys travel sealed; PDF bytes are excluded).
  - Usage charts, writing assistant toggle, knowledge/glossary UI with CSV import.

### Security

- API keys are sealed with WebCrypto before storage, opened only inside the translation
  worker, never synced and never exported in plaintext.
- HTML paths are gated through DOMPurify (`src/editor/sanitize.ts`) or `escapeHtml`; the app
  ships no `dangerouslySetInnerHTML`.
- No telemetry or analytics of any kind; all data stays in the browser unless the user turns
  on cloud sync.

