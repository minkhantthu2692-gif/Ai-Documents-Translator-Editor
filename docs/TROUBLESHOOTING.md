# Troubleshooting

This guide covers everything the app tells you when something goes wrong: the **Logs** page,
every **reason code**, the **sync** error codes, the **troubleshooting assistant**, conflicts
between devices, and browser/environment requirements.

## How to read the Logs page

Open **Logs** in the sidebar. Every state change, warning and error the app produces appears
here as one row, newest first.

| Element | What it tells you |
| --- | --- |
| **Severity badge** | `Info` / `Success` / `Warning` / `Error` / `Critical`. Filter with the chips above the list (each chip shows its count) |
| **Timestamp** | When the event happened (device local time) |
| **Reason code chip** | The machine-readable code (for example `PDF_ENCRYPTED`) — look it up in the tables below |
| **State tag** | Which part of the pipeline emitted it (`SETTINGS`, `BACKUP`, `TRANSLATE`, FSM states, …) |
| **Message** | Plain-language text in your interface language (both Burmese and English are stored on every event) |
| **Technical detail** (expandable) | Raw detail for bug reports: HTTP status, exception text, file size, cursors. Page/line indices appear when the failure is tied to a specific location |
| **Suggested fixes** | The `fixActions` for that reason code, rendered as chips |
| **Search box** | Full-text search over the messages |
| **Export JSON** | Downloads the current filter result as `aidt-logs-<timestamp>.json` (`format: "aidt-logs"`) |
| **Clear logs** | Removes the local event timeline (asks for confirmation) |

Tip: filter to `Error` + `Critical`, note the reason codes, then use **Export JSON** when
reporting an issue — it contains exactly the structured event envelope
(`timestamp, state, reasonCode, messageMy, messageEn, technicalDetail, fixActions`).

## Reason codes

Every failure resolves to one of the codes below. Severity: **info** · **success** ·
**warning** · **error** · **critical**.

| Reason code | Severity | Plain-language cause | Step-by-step fix |
| --- | --- | --- | --- |
| `PDF_ENCRYPTED` | error | The PDF is protected by a password, so its contents cannot be parsed. | 1. Open another file, or 2. obtain the password and enter it in the PDF-password prompt when asked, then re-open the document |
| `PDF_CORRUPTED` | error | The file is damaged or not a readable PDF (the parser rejected it). | 1. Re-export the PDF from the original application (Word, scan tool, browser “Print → Save as PDF”), 2. if that fails, try another file to confirm the source is the problem |
| `NO_TEXT_LAYER` | warning | The page is an image (scanned or photographed) with no selectable text, so there is nothing to translate yet. | 1. Run OCR on the page (the app offers it for this page), or 2. skip the page if it contains no body text |
| `NO_API_KEY` | error | No AI API key has been added for any provider yet. | 1. Open Settings → AI Providers, 2. paste a key into the provider card → **Add key**, 3. **Test key**, then start the job again |
| `INVALID_KEY` | error | The provider rejected the key (HTTP 401/403): mistyped, revoked or expired. | 1. Open the provider’s website and check/rotate the key, 2. delete the old row in Settings → AI Providers and **Add key** with the fresh value, 3. paste the whole key with no stray spaces, 4. **Test key** before retrying |
| `ALL_KEYS_COOLING_DOWN` | warning | Every enabled key is temporarily paused after rate-limit responses. | 1. Wait for the cooldown countdown shown on the Translate page and retry, 2. add another key (or another provider) so the pool always has a usable key |
| `QUOTA_EXHAUSTED` | warning | The key or model has spent its daily/period quota. | 1. Wait until the provider’s window resets (the countdown shows it) and retry, 2. switch provider or model in Settings → AI Providers to keep working meanwhile |
| `NETWORK_OFFLINE` | warning | The device is offline (`navigator.onLine` is false), so network work is paused. | 1. Reconnect and press retry, 2. meanwhile continue offline work (editing, reading, local exports) — the job resumes when the connection returns |
| `MODEL_UNAVAILABLE` | error | The selected model does not exist anymore or is not available on your key (404 / `model_not_found`). | 1. On the provider card press **Refresh models** and choose another model (prefer **Free tier** + **Recommended for PDF**), 2. retry the job |
| `BAD_JSON_RESPONSE` | error | The AI answered, but the text could not be parsed as the expected JSON structure. | 1. Retry the request (transient model hiccups are common), 2. reduce the context size — translate fewer lines per batch / split the document, 3. if it repeats with one model, switch model |
| `OCR_FAILED` | error | The OCR engine could not read the page (worker error or empty recognition). | 1. Run OCR again (a retry often succeeds), 2. if the scan is unreadable, type the text manually into the block, 3. check that the page image is not rotated or too small |
| `STORAGE_QUOTA_EXCEEDED` | critical | The browser’s IndexedDB quota for this site is full. | 1. Settings → Cache → **Clear all caches**, 2. delete old projects you no longer need, 3. export a backup first if you want to keep them, 4. as a last resort free browser storage (site data) and re-import the backup |
| `EXPORT_FONT_MISSING` | warning | A font used by the document is not in the bundled registry, so exported layout may shift. | 1. Open the font mapping in the export/font settings and pick an available substitute, or 2. export anyway if the shift is acceptable |
| `SYNC_FAILED` | error | Pushing to the Google Sheet failed (non-2xx response or timeout). | 1. Press **Retry sync**, 2. check Settings → Data → Cloud sync: URL ends in `/exec`, token matches the `TOKEN` Script Property, deployment access is *Anyone*, 3. see [Sync error codes](#sync-error-codes) for the exact code |
| `BACKUP_INVALID` | error | The chosen backup file failed schema/payload validation. | 1. Choose another file (must be an `aidt-backup` JSON exported by this app), 2. or export a fresh backup from this device and keep it safe |
| `INVALID_STATE_TRANSITION` | warning | The workflow was asked to move to a state that is not allowed from the current one (e.g. resuming a cancelled job). | 1. Dismiss the notice, 2. restart the operation from its beginning — the state machine only accepts legal transitions |
| `FILE_NOT_PDF` | error | The selected file is not a PDF (or lacks the `%PDF-` header). | 1. Choose a PDF file, 2. if it should be a PDF, re-export it as PDF from the source app, then try again |
| `FILE_TOO_LARGE` | error | The file exceeds the size limit for safe processing in the browser. | 1. Split the PDF into smaller parts (or compress it) and import them one by one, 2. or choose another, smaller file |
| `TOO_MANY_PAGES` | error | The document has more pages than the supported limit. | 1. Split the document into shorter files, 2. or choose a file with fewer pages |
| `OCR_LANGUAGE_MISSING` | warning | The OCR language pack has not been downloaded to this device yet (it needs the network once). | 1. Connect to the internet and press **Download OCR language**, 2. run OCR again; afterwards it works offline |
| `PROVIDER_NOT_CONFIGURED` | error | No translation provider/model pair has been selected. | 1. Open Settings → AI Providers, 2. select a **Model** on a provider card, 3. press **Use this provider**, 4. return to the Translate page |
| `LANGUAGES_MISSING` | error | Source or target language is missing (or both are the same). | 1. On the Translate page pick **both** languages explicitly (or confirm the auto-detected source), 2. restart the wizard if it is stuck on stale values |

## Sync error codes

These come from the Apps Script backend (`apps-script/Code.gs`) and the sync layer. The server
always answers HTTP 200 with `{ "ok": false, "code": …, "message": … }`.

| Code | Cause | Fix |
| --- | --- | --- |
| `UNAUTHORIZED` | The token sent by the app does not match the `TOKEN` Script Property (or the property is empty). | Re-enter the access token in Settings → Data → Cloud sync; verify the `TOKEN` property in Apps Script → Project Settings; save both again |
| `BAD_REQUEST` | Malformed payload: missing `action`, invalid JSON, body over 5 MB, array fields of the wrong shape, or `wipe` without `confirm: "WIPE"`. | Usually a version mismatch — update the app / redeploy `Code.gs` as a New version, then retry the action |
| `UNKNOWN_ACTION` | The deployed script does not know the requested action (old deployment). | Apps Script → **Deploy → Manage deployments → Edit → New version** with the current `Code.gs`, then retry |
| `LOCK_TIMEOUT` | Another sync session holds the script lock (waits 30 s, then gives up). | Wait a few seconds and press **Sync now** again; avoid syncing from several devices simultaneously; lengthen the auto-sync interval |
| `SECRET_NOT_ALLOWED` | A pushed Settings record id/field looks like a credential (`key`, `token`, `secret`, `password`, `authorization`). The whole request is rejected on purpose — API keys are never stored in the cloud. | Remove or rename that setting locally so it no longer looks like a secret; never store credentials in settings ids; re-sync |
| `NOT_FOUND` | The referenced project row does not exist on the Sheet (wiped or deleted elsewhere). | Run **Sync now** on the device that owns the project so it re-uploads; if you wiped the cloud on purpose, delete or re-create the local project |
| `INTERNAL` | Missing tab, hand-edited header row, unbound spreadsheet (standalone deployment without `SPREADSHEET_ID`), a Google Sheets read/write failure (tab deleted mid-sync, header changed, spreadsheet moved, access revoked), Google throttling the script (per-user execution quota or concurrent-execution limit exhausted), or an unexpected script error. | Restore/delete the damaged tab so the script recreates it with the canonical headers; set the `SPREADSHEET_ID` Script Property for standalone deployments; after throttling, wait for the quota to reset, lengthen the auto-sync interval and sync fewer devices at once; inspect the **SyncLog** tab for the failing action |

Details, CORS notes and a click-by-click setup walkthrough: `docs/GOOGLE_APPS_SCRIPT_SETUP.md`.

## Troubleshooting assistant

The in-app assistant (**Settings → Assistant**, and the button on the **Logs** page) explains
errors in plain language and proposes fix steps using the same structured context the logs
carry (error code, job state, provider/model, recent events, browser info). It runs in one of
two modes:

| Mode | When it is active | How it works |
| --- | --- | --- |
| **Proxy mode** | `VITE_ASSISTANT_PROXY_URL` points at the `proxy/` server (`proxy/server.js` or `proxy/cloudflare-worker.js`) | The browser sends the question + context to `POST /assistant`; the proxy calls OpenRouter and returns a normalised `{ title, explanation, steps, actions }` answer. The assistant’s OpenRouter key lives **only** in the proxy’s server-side `.env` as `OPENROUTER_ASSISTANT_KEY` — never in the frontend bundle. See `proxy/README.md` |
| **Offline rule-based mode** | No proxy URL is set, or the network is unavailable | A built-in rule engine maps reason codes and error patterns to explanations **without any network request** |

The proxy always fails with the same JSON envelope (`{ "ok": false, "code", "message" }`). When
the assistant cannot answer:

| Proxy code | Meaning | What to do |
| --- | --- | --- |
| `RATE_LIMITED` | More than 20 requests per 15 minutes from your IP (or OpenRouter itself rate-limited). | Wait for the window to pass and ask again; the offline mode still works meanwhile |
| `MISSING_KEY` (HTTP 503) | The proxy has no `OPENROUTER_ASSISTANT_KEY`. | Set it in `proxy/.env` (from `proxy/.env.example`), restart the proxy, verify with `GET /health` → `"hasKey": true` |
| `UPSTREAM_ERROR` (502) / `TIMEOUT` (504) | OpenRouter was unreachable or too slow (20 s limit). | Retry later; check the proxy’s server logs; the free model may be down — set `ASSISTANT_MODEL` to another free id |
| `BAD_REQUEST` (400/413) | Question empty/too long (> 4000 chars) or body over 32 KB. | Shorten the question; trim the attached context |
| `INTERNAL` (500) | Unexpected proxy bug. | Details are in the proxy’s stdout, not the response — check the server log |

If nothing else works, use this document’s tables directly: find the reason code in the Logs
page, then read its row above.

## Offline work and sync conflicts

- **Offline is normal.** The app is local-first: parsing, editing, glossary work and exports
  all run against IndexedDB. `NETWORK_OFFLINE` only pauses network-dependent steps (translation
  requests, OCR language download, cloud sync) and they resume automatically.
- **Two devices edited the same record.** When both devices sync, the **conflict policy** in
  Settings → Data decides which copy survives:
  - **Keep local version** — this device wins,
  - **Keep cloud version** — the Sheet’s copy wins,
  - **Keep newest version** (default) — the record with the later `updatedAt` wins; ties are
    broken by version, then device id (last-write-wins, identical to the server-side rule).
- **Conflicts are logged locally.** Every resolution stores the losing copy in the local
  conflict log (`syncConflicts`), and **Settings → Data shows the conflict count** so you can
  notice that something was overwritten and restore it from the log or from a backup export.
- **Pending changes** are counted in the badge `N changes waiting to sync` on the Settings →
  Data card. If it never reaches zero, check the sync error code in the table above.

## Browser and environment

| Requirement | Detail |
| --- | --- |
| Browser | Any evergreen browser: current Chrome/Edge (Chromium), Firefox, or Safari. The app relies on ES2020+, Web Workers, WebCrypto `subtle`, `fetch` and CSS custom properties |
| IndexedDB | **Required** — Dexie stores everything here (projects, settings, sealed keys, logs). Private/incognito windows may block or wipe it; use a normal window for real work |
| Web Workers | Heavy work (PDF parse, OCR, translation) runs in workers; a browser that blocks workers will stall jobs |
| Service worker | After the first visit the app shell is served offline by `public/sw.js`. If the UI looks stale or broken after an update: DevTools → **Application → Service Workers → Unregister**, then **Application → Storage → Clear site data**, and reload |
| Storage quota | The `STORAGE_QUOTA_EXCEEDED` reason code appears when the origin’s quota is full. Free space via Settings → Cache → **Clear all caches**, deleting old projects, or the browser’s site-data settings. Export a backup before deleting projects |
| Memory | Very large PDFs (hundreds of pages, many images) can exhaust tab memory. Split the document (see `TOO_MANY_PAGES` / `FILE_TOO_LARGE`) and close unused tabs |
| Network | Needed only for: AI translation, OCR language pack download (once per language), model discovery, cloud sync and the assistant proxy. Everything else works offline |
| Time & locale | Timestamps use the device clock; the Sheet backend runs in `Asia/Yangon`. Clock skew several hours off can make “newest version” conflict resolution pick the wrong side — keep the system clock synced |

## Still stuck? Support checklist

Before reporting an issue, collect these four things:

1. **Export the logs** — Logs page → filter to `Error`/`Critical` → **Export JSON** → attach
   `aidt-logs-<timestamp>.json`.
2. **Export a backup** — Settings → Data → **Export backup (JSON)** → attach the file *only if*
   you are comfortable sharing its contents (it contains your projects, glossary and settings —
   but never plaintext API keys; they travel sealed).
3. **Browser + OS info** — browser name and version, operating system, whether you are in a
   private window, and roughly how much local storage the site uses (DevTools → Application →
   Storage).
4. **What you did** — the exact steps to reproduce, the reason code shown, and (for sync
   problems) the Apps Script deployment type, the sync error code and a recent row from the
   Sheet’s **SyncLog** tab.

With those four items most problems can be traced to a single row in one of the tables above.

## Where the pieces live in this repository

| Path | Role |
| --- | --- |
| `src/core/reasonCodes.ts` | Every reason code with severity, bilingual messages and fix actions |
| `src/pages/LogsPage.tsx` | The Logs page: filters, technical detail, JSON export |
| `src/core/eventLogger.ts` | The event envelope that every state change emits |
| `apps-script/Code.gs` | Sync backend error codes (`UNAUTHORIZED`, `BAD_REQUEST`, `UNKNOWN_ACTION`, `LOCK_TIMEOUT`, `SECRET_NOT_ALLOWED`, `NOT_FOUND`, `INTERNAL`) |
| `proxy/README.md` | Assistant proxy contract and its error envelope |
| `src/i18n/locales/en.json` | English UI strings for logs, settings and status messages |
| `public/sw.js` | Service worker (offline shell) — the cache to clear when the UI is stale |
