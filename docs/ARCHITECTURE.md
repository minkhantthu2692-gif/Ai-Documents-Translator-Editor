# Architecture

How **AI Documents Translator & Editor** is put together: the layers, what each one owns,
and how a click in the UI travels down to storage — locally, and optionally to the cloud.

## Layered overview

```text
┌────────────────────────────────────────────────────────────────────────────┐
│  UI layer                                                                 │
│  src/pages (routes) · src/components (layout/ui/workspace/charts)         │
│  src/stores (Zustand: ui, translate, toast, assistant)                    │
│  react-router · react-i18next (en / my) · theme + responsive layout       │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ hooks, actions, events
┌──────────────────────────────▼─────────────────────────────────────────────┐
│  Domain services                                                          │
│  src/translate  (batching, engine, executor, queue, key pool)             │
│  src/pdf        (pre-flight, extraction, layout, render cache)            │
│  src/export     (DOCX/EPUB/PDF/HTML/text/JSON/CSV builders)               │
│  src/providers  (Gemini · OpenAI-compatible adapters, rate limits)        │
│  src/assistant  (proxy client, offline rules, redaction, safe actions)    │
│  src/core       (job FSM, event log, reason codes, crypto, device id)     │
│  Heavy work runs in Web Workers: src/workers/analysis|translation|export  │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ repositories (src/db)
┌──────────────────────────────▼─────────────────────────────────────────────┐
│  Persistence — Dexie / IndexedDB, database `aidt`, schema v7              │
│  projects · pages · blocks · glossary · translationMemory · translations  │
│  jobs · events · outbox · settings · apiKeys · usageStats · revisions …   │
│  ALWAYS the source of truth — every read and write starts here            │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ optional: Settings → Data → Cloud sync
┌──────────────────────────────▼─────────────────────────────────────────────┐
│  Cloud sync — src/sync                                                    │
│  collect → outbox → chunked push → paged pull → LWW merge + conflict log  │
│  apps-script/Code.gs (web app, shared-secret token, LockService)          │
│        └──► Google Sheet tabs: Projects · Pages · Blocks · Glossary       │
│             Settings · UsageStats · SyncLog                               │
└────────────────────────────────────────────────────────────────────────────┘
```

Two rules hold the diagram together:

1. **IndexedDB is the source of truth.** The Google Sheet is only a relay so two browsers can
   converge; nothing ever reads the cloud first.
2. **Secrets never cross the bottom edge.** API keys are sealed before they reach storage and
   are filtered out of every sync payload (see [SECURITY.md](SECURITY.md)).

## Key modules

| Directory / file | Responsibility |
| --- | --- |
| `src/pages` | Route-level screens: Dashboard, Projects, NewProject, Workspace, Translate, Settings, Logs, Knowledge |
| `src/components` | App shell/sidebar, design-system primitives, workspace panels, charts |
| `src/stores` | Zustand stores: `uiStore` (theme/language), `translateStore`, `toastStore`, `assistantStore` |
| `src/editor` | Block editing: commands, undo/redo history, keyboard map, find/replace, font autofit, HTML sanitisation |
| `src/pdf` | Pre-flight validation, pdf.js extraction, line grouping, page classification, structure extraction, render cache |
| `src/translate` | Batch construction, batch engine, rotation executor, key pool, adaptive concurrency, job queue, prompts, terminology |
| `src/providers` | Provider registry (`gemini.ts`, `openaiCompat.ts`), model discovery, rate-limit parsing, HTTP transport |
| `src/export` | One builder per format plus `runExport` orchestration in the export worker; backup/restore lives in `src/db/backup.ts` |
| `src/sync` | Wire protocol, HTTP client, sync engine, LWW merge, Zustand store, `SyncBootstrap` auto-sync timer |
| `src/assistant` | Proxy-first client, `redact.ts` secret scrubbing, offline rule engine, one-click safe actions, dialog |
| `src/db` | Dexie schema (v7) and repositories for every table; backup export/import |
| `src/core` | Crypto sealing (AES-GCM/PBKDF2), key vault, job FSM, event logger, reason codes, device id, Zawgyi helpers |
| `src/i18n` | `en.json` / `my.json` locales plus the coverage and parity tests |
| `src/workers` | `analysis.worker` (pdf.js), `translation.worker`, `export.worker` — keep the main thread free |
| `src/ocr`, `src/knowledge` | OCR client (tesseract.js) and glossary CSV import/validation |
| `apps-script/` | `Code.gs` + `appsscript.json`: the stateless Google Sheets sync backend |
| `proxy/` | Troubleshooting Assistant proxy: Node/Express `server.js` and `cloudflare-worker.js` |
| `public/sw.js` | Hand-written service worker (offline shell) |
| `scripts/`, `tools/`, `docs/` | Smoke test + fixtures, launcher/push helpers, documentation |

## Persistence

- **Dexie over IndexedDB**, database `aidt`, current schema version **7**. Each version adds
  tables or backfills (analysis fields, key-pool fields, revisions, `syncConflicts` +
  `syncMeta`) and Dexie runs upgrades only for databases that are actually older.
- **Repositories** (`src/db/repo-*.ts`) are the only place that touches tables; UI and services
  call repo methods, which also stamp `updatedAt`, `version` and `deviceId` on every write —
  the metadata the sync layer later relies on.
- **Backup** exports most tables as an `aidt-backup` JSON file. `sourceFiles` (PDF bytes) is
  excluded because JSON cannot carry blobs; `syncConflicts` and `syncMeta` are device-local
  bookkeeping (pull cursors, version vectors) and deliberately never travel.
- **Cache tables** (`cache`, render caches, OCR data) are disposable: Settings → Cache can
  clear them without touching documents.

## Sync data flow

```text
  local edit ──► repo write ──► outbox row (entity, id, op, payload)
                                     │
   collect: rows with updatedAt > pushCursor
                                     │
                                     ▼
              pushChanges  (≤ 200 changes / ≤ 3 MB per call, chunked)
              deletes travel as tombstones, project deletes via deleteProject
                                     │  partial? resume from nextCursor
                                     ▼
                    Google Sheet tabs (Apps Script web app)
                                     │
   pull: pullChanges(since = pullCursor), paged — projects first, then children
                                     │
                                     ▼
              mergeRemote() — last-write-wins + conflict policy
              winner: newer updatedAt → higher version → greater deviceId
              losing copy written to the local `syncConflicts` log
                                     │
                                     ▼
                          IndexedDB (source of truth)
```

Details that matter:

- **Wire protocol.** One `POST text/plain` body `{token, action, deviceId, …}` to the Apps
  Script `/exec` URL; every response is HTTP 200 JSON (`{ok, …}` or `{ok:false, code,
  message}`). Text/plain avoids a CORS preflight. Server error codes: `UNAUTHORIZED`,
  `BAD_REQUEST`, `UNKNOWN_ACTION`, `LOCK_TIMEOUT`, `SECRET_NOT_ALLOWED`, `NOT_FOUND`,
  `INTERNAL`. Client-only codes add `NOT_CONFIGURED`, `NETWORK`, `TIMEOUT`, `BAD_RESPONSE`.
- **Actions.** `ping`, `pushChanges`, `pullChanges`, `listProjects`, `getProject`,
  `upsertBlocks`, `deleteProject`, `backup`, `wipe` — the same names in `Code.gs` and
  `src/sync/client.ts`.
- **Outbox.** A local row is created for every change; one row per entity/id (later edits
  replace earlier payloads). Future-dated rows (a remote clock ahead of ours) are never echoed
  back. Offline runs fail with `NETWORK` and leave the outbox untouched; an `online` listener
  resets per-row backoff so the next attempt is immediate.
- **Conflict handling.** Last-write-wins by default, overridable by the conflict policy in
  Settings → Data (`newest` / `local` / `remote`). A conflict row is written only when real
  content differs *and* either the merge destroys unsynced local work or the policy forced a
  non-LWW winner — routine catch-up is not a conflict.
- **Cadence.** Manual **Sync Now**, a test-connection probe (`ping`), and optional auto-sync
  on an interval while the app is open; per-entity toggles decide what is allowed to travel.

## Translation pipeline

```text
  plan      pages → lines (line grouping) → batches
            15–25 lines or ~1500 source tokens, whichever comes first
            batch ids are derived (`project#epoch#page#index`), never random
              │
  queue     job FSM: queued → running → paused ⇄ running → done / failed / cancelled
            survives a page refresh (jobs + progress live in IndexedDB)
              │
  worker    src/workers/translation.worker.ts runs the engine off the main thread
              │
  engine    prompts → executor → strict validation → repair ladder → review pass
            → post-processing → confidence + flags
              │
  executor  leases a key from the pool, sends one call, handles the outcome:
            429 → rotate to the next key and re-run the same call
            401/403 → mark the key invalid, try the next one
            all keys cooling → park until `availableAt()` (countdown in the UI)
            404 → walk the model fallback chain, else MODEL_UNAVAILABLE
              │
  providers gemini.ts | openaiCompat.ts (OpenRouter, Groq, OpenAI-compatible)
            rate-limit buckets (RPM/TPM/RPD) from live headers beat estimates
              │
  ladder     malformed/failed response → split the batch in half → line-by-line
             → keep the original text for that line, flag it, score the page down
             The ladder never drops or reorders a line: every input id has exactly
             one output.
```

Around the engine sit: **adaptive concurrency** (AIMD semaphore, floor 1 / ceiling 3 / start
2, cut when the sliding-window error rate exceeds 0.3), **glossary + terminology** enforcement
in post-processing, **placeholder restoration** (`{{n}}` tokens must survive), and a
**translation memory** for repeats.

## Offline & PWA story

- **Service worker** (`public/sw.js`, hand-written): navigations are network-first with a
  cached application-shell fallback (so a reload works offline after the first visit);
  same-origin static assets use stale-while-revalidate so a new deploy is picked up quietly;
  cross-origin requests (fonts, OCR assets, provider APIs) are **never** cached by the worker
  — those are handled by the app's own Dexie-backed caches. All shell URLs resolve against the
  worker's own location, so the same file works at `/` and at `/REPO_NAME/`.
- **Registration** happens only in production builds; the dev server actively unregisters
  workers so stale caches never mask a change. Bump `CACHE_VERSION` in `sw.js` when the shell
  markup changes.
- **IndexedDB is the offline contract.** Parsing, editing, glossary work, exports, logs and
  settings all run against local tables. Network-dependent steps (translation calls, OCR
  language pack download, cloud sync) pause on `NETWORK_OFFLINE` and resume automatically.
- **Installable** via `manifest.webmanifest` with bundled icons; fonts are shipped locally
  (Noto Sans Myanmar, Padauk, …) so Myanmar text renders without a network round trip.
- **Base path** comes from `Vite`'s `base` (driven by `VITE_BASE`), and the router uses
  `basename={import.meta.env.BASE_URL}` — that is what makes sub-path hosting (GitHub Pages)
  and the service worker scope line up. A Vite plugin also serves/copies pdf.js `cmaps` and
  standard fonts under `pdfjs-assets/`.

## Related documents

- [SECURITY.md](SECURITY.md) — how keys, tokens and redaction are handled.
- [DEPLOYMENT.md](DEPLOYMENT.md) — where each layer runs in production.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — the reason codes emitted by these layers.
- [GOOGLE_APPS_SCRIPT_SETUP.md](GOOGLE_APPS_SCRIPT_SETUP.md) — the sync backend click-by-click.
