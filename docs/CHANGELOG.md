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
- **Clickable links** in PDF extraction (phase (c) of `docs/PDF_TYPES_SUPPORT.md`): every
  external `/Link` annotation becomes a `LinkRef[]` on the block it sits over
  (`src/pdf/links.ts`), anchored on the words the rectangle actually covered. HTML and EPUB emit
  `<a href rel="noopener noreferrer" target="_blank">`, Markdown `[text](url)` with the label's
  brackets escaped, DOCX an `ExternalHyperlink` run that keeps the surrounding font, size,
  weight, italics and direction, and JSON carries the pairs for a round trip. Destinations are
  allow-listed before anything else sees them — `javascript:`, `data:` and `file:` are dropped,
  a scheme-less `www.…` is promoted to `https://`, and a URL over 2048 characters is refused.
  Internal `/Dest` links (TOC, cross-references) are deliberately not rendered: a page index is
  not a URL.
- **Layout auto-adjust when a translation grows** (phase (d) of
  `docs/PDF_TYPES_SUPPORT.md`): `src/editor/layout.ts` re-measures a block the moment a
  translation lands — on the bulk queue, on inline re-apply and on accept-suggestion, but never
  while a person is typing — and takes the largest size in `[6pt, originalFontSize]` whose
  wrapped text still fits the original bbox. A size the reader pinned by hand is left alone, and
  a block that will not fit even at the floor keeps the document's own size and is flagged
  rather than shrunk into illegibility. A Layout card in Settings → General turns it off.
- **Reflow of what auto-fit could not shrink**: `src/export/reflow.ts` pushes the blocks under a
  block that outgrew its box down by exactly the growth, within their own column, chaining
  through a stack and stopping at the page edge (`@page` is fixed, so nothing is printed half off
  the next sheet). Growth in column one leaves column two untouched, a full-width band that grew
  moves both columns under it, and an overlap the source PDF already had is left for the reader.
  HTML now emits `min-height` where it emitted `height`, so a box is a floor the translation may
  grow into rather than a ceiling it paints over. Formats with no geometry — DOCX, EPUB,
  Markdown — and the raster export are unchanged. The editor canvas runs the same pass through
  `reflowForPage`, so a page cannot look broken on screen and clean in the file it prints to. A browser that
  will not give the export a canvas to measure with now says so: reflow falls back to an estimated character
  width, and the export raises an `EXPORT_LAYOUT_ESTIMATED` warning (EN + MY) instead of placing blocks
  silently. The other silent case is gone too: a block the bottom edge stopped — the page box is fixed, so the
  push runs out of room — is counted and reported as `EXPORT_LAYOUT_CLIPPED` (EN + MY) rather than left
  to overlap in quiet.
- **Code blocks** in PDF extraction (phase (c) of `docs/PDF_TYPES_SUPPORT.md`, types 13 and 24):
  `src/pdf/codeBlocks.ts` calls a run of lines code when two independent readings agree — a
  monospaced face *and* statement punctuation, a monospaced face *and* nesting (which is what
  catches YAML and JSON, whose lines carry no punctuation to score), or punctuation alone across
  several lines with a brace somewhere. The block is given `kind: 'code'` and stamped
  `skipRule: 'code'`, so the translator never rewrites a program even when no single line would
  have tripped the per-line rule on its own. Indentation is the one thing extraction throws away
  — `groupItemsIntoLines` collapses whitespace because prose does not care where a word began —
  so it is measured back off the bounding boxes: in a monospaced face `bbox.w` over the character
  count is the exact advance width, and `links.ts` already makes the same trade in the other
  direction. `canMerge` used to refuse two lines whose left edges differed by more than half a
  character, less than a single indent step, which shredded every nested snippet into one block
  per nesting level; it now widens that tolerance when both lines are monospaced, and a `;` no
  longer reads as the end of a sentence. Every exporter renders the result as code: fenced in
  Markdown (with the fence widened past any backtick run inside), `<pre>` and a monospace stack in
  EPUB, `Courier New` with real `<w:br/>` breaks in DOCX, and monospace with `white-space:
  pre-wrap` in the HTML and print paths. The editor canvas draws the same face, so the page cannot
  look wrong on screen and right in the file.

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
- **A synced document can no longer write a formula into your Sheet.** Sheets parses a cell on
  the way in, so a block whose text opened with `=IMPORTDATA(...)` would have become a live
  formula that phones home from the reader's own spreadsheet — and an equation page, a hyphen
  bullet, a phone number or a date all trip the same parse as ordinary content. Every
  request-derived value now goes through `writePlain_`, which formats the destination range as
  Plain Text before `setValues`, so the parse never happens. Unlike the usual apostrophe-prefix
  mitigation nothing is added to or stripped from the value, so a hyphen bullet survives the
  round trip exactly. `src/sync/appsScript.test.ts` reads `Code.gs` and fails if a data write
  ever bypasses the helper again.

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

