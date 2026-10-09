# Google Apps Script Cloud Sync Setup

This guide walks you through connecting **AI Documents Translator & Editor** to a Google Sheet
so your projects follow you from one browser to another. No programming knowledge is needed —
every click is described below.

## What sync does

- Every device keeps its own copy of your data in **IndexedDB** (the database inside your
  browser). That local copy is always the **source of truth**: the app reads and writes it first.
- A single **Google Sheet** acts as the shared relay between your devices. On **Sync now** the
  app pushes local changes up to the Sheet and pulls changes that other devices left there.
- Nothing else is stored in the cloud. PDFs, rendered pages, caches and logs stay local.
  **API keys stay on the device too**, unless you deliberately switch on the separate, off-by-default
  key sync (see [Selective sync](#selective-sync-and-api-keys)) — and note that when it is on,
  they are written to the Sheet in readable text.
- The backend is a stateless JSON web app written in Google Apps Script
  (`apps-script/Code.gs`). The Sheet holds all the data; the script never keeps state between
  requests.

```text
 Device A (IndexedDB)  ──push/pull──►  Google Sheet  ◄──push/pull──  Device B (IndexedDB)
        source of truth               (relay only)                  source of truth
```

## Before you start

| What you need | Why |
| --- | --- |
| A Google account | Hosts the Sheet and the Apps Script deployment |
| The file `apps-script/Code.gs` from this repository | The sync backend code you will paste |
| The file `apps-script/appsscript.json` from this repository | The script manifest (timezone, runtime, scope) |
| This app running in a browser | Settings → Data → Cloud sync |
| A password generator or OpenSSL | Creates the shared access token |

## Step 1 — Create a new Google Sheet

1. Open <https://sheets.new> (or Google Drive → **New → Google Sheets**).
2. Name it something you will recognise later, for example `Doc Translator Sync`.
3. Leave the sheet empty. The script creates all required tabs on its own.

## Step 2 — Open the Apps Script editor

1. In the new spreadsheet, open **Extensions → Apps Script**.
2. A new tab opens with a project named after the spreadsheet and a file called `Code.gs`
   containing a placeholder function such as `function myFunction() {}`.

## Step 3 — Paste the backend code

1. Delete everything currently in `Code.gs`.
2. Open `apps-script/Code.gs` from this repository and copy **the whole file**.
3. Paste it into the editor, replacing the placeholder contents.
4. Save with **Ctrl+S** (or the 💾 toolbar button).

> The code creates eight tabs the first time it runs: **Projects**, **Pages**, **Blocks**,
> **Glossary**, **Settings**, **UsageStats**, **ApiKeys** and **SyncLog**. Every data tab starts
> with the fixed header row `id, updatedAt, deviceId, version, deleted, …`; deletions are written
> as tombstones (`deleted = TRUE`) so they propagate to your other devices.

## Step 4 — Set the manifest (`appsscript.json`)

1. In the editor, choose **View → Show manifest file**. A file named `appsscript.json` appears
   in the file list; open it.
2. Delete its contents and paste the manifest from `apps-script/appsscript.json`:

```json
{
  "timeZone": "Asia/Yangon",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

3. Save with **Ctrl+S**. What this manifest does:

| Field | Value | Meaning |
| --- | --- | --- |
| `timeZone` | `Asia/Yangon` | Timestamps and logs use Myanmar time |
| `runtimeVersion` | `V8` | Modern JavaScript runtime (required by the script) |
| `oauthScopes` | `spreadsheets` | The script may touch **only** the spreadsheet — no Drive, Gmail or Docs access |
| `webapp.executeAs` | `USER_DEPLOYING` | Runs with your identity (“Execute as: Me”) |
| `webapp.access` | `ANYONE_ANONYMOUS` | Anyone with the URL may call it; the token guards the data |

## Step 5 — Create the shared token (Script Property)

The token is a **shared secret**: the app sends it with every request, and the script compares
it against the value stored in the project’s Script Properties. Without a matching token every
request is rejected with `UNAUTHORIZED`.

1. In the Apps Script editor open **Project Settings (⚙) → Script Properties → Add property**.
2. Key: `TOKEN`
3. Value: a long random string. Generate one with either of these:

```bash
# OpenSSL (Git Bash, WSL, Linux, macOS)
openssl rand -hex 32
```

…or use any password generator with at least 32 random characters. The result should look like
a long random hex or base64 string — **not** a sentence, **not** your Google password.

4. Save the property.

**Token safety rules**

- Never commit the token to this repository, and never place a real token value in a `.env`
  file that is tracked by git (`.env` files are for non-sensitive `VITE_` values only).
- Never paste the token into a screenshot, an issue, a chat message or the Sheet itself.
- The app stores it **sealed (AES-GCM) on this device only**; the field then displays
  `••••` plus the last four characters.
- To rotate it later, change only the `TOKEN` Script Property — nothing in `Code.gs` or in the
  Sheet ever contains it. Update the token in the app right afterwards, or sync breaks.

## Step 6 — Deploy as a web app

1. In the Apps Script editor click **Deploy → New deployment**.
2. Click the gear icon and choose **Web app**.
3. Set:
   - **Description:** `sync v1`
   - **Execute as:** **Me** (your Google account)
   - **Who has access:** **Anyone**
4. Click **Deploy** and authorise when asked (the consent screen lists only the spreadsheets
   scope from Step 4).
5. Copy the **Web app URL**. It must end with `/exec`, for example:

```text
https://script.google.com/macros/s/AKfycb…/exec
```

> After any edit to `Code.gs` you must deploy again: **Deploy → Manage deployments → ✏️ edit →
> Version: New version → Deploy**. Opening the old `/exec` URL always runs the deployed
> version, not your unsaved editor changes.

## Step 7 — Configure the app

In the app open **Settings → Data → Cloud sync** and fill in the card top to bottom:

| Field (UI label) | What to enter |
| --- | --- |
| **Apps Script URL** | The `/exec` URL from Step 6 |
| **Access token** | The `TOKEN` value from Step 5. The field behaves like a password; it saves when you leave the field (on blur) and afterwards shows only `••••1234` |
| **Enable sync** | Toggle on — pushes local changes when a connection is available |
| **Auto sync** | Toggle on to sync periodically while the app is open |
| **Interval (minutes)** | Auto-sync cadence, 1–1440 minutes (default 15) |
| **Conflict policy** | Which copy survives when both devices edited the same record: **Keep local version**, **Keep cloud version** or **Keep newest version** (default) |

A badge above the card shows `N changes waiting to sync` (the local outbox) whenever edits are
queued.

### Test connection

Press **Test connection**. Expected outcomes:

| Result | What it means | What to do |
| --- | --- | --- |
| Success toast listing the sheet names (`Projects, Pages, Blocks, Glossary, Settings, UsageStats, ApiKeys, SyncLog`) | URL reachable, token accepted, all tabs created | Continue to **Sync now** |
| `UNAUTHORIZED` | The token in the app does not match the `TOKEN` Script Property | Re-copy the exact token into **Access token**, save, test again |
| `LOCK_TIMEOUT` | Another sync session currently holds the script lock | Wait a few seconds and test again |
| `BAD_REQUEST` / network or CORS error | Wrong URL (not `/exec`), deployment access is not *Anyone*, or the deployment was not authorised | See [CORS notes](#cors-and-textplain-posts) below |
| `INTERNAL` with a message naming a sheet | A tab was deleted or its header row was edited by hand | Delete the damaged tab (the script recreates it) or restore the header row, then test again |

### Sync now

Press **Sync now**. A successful run:

1. Uploads every queued local change (`pushChanges`) — counted as *applied* / *skipped*.
2. Downloads everything changed on the Sheet since the last pull (`pullChanges`), including
   deletions from other devices.
3. Shows a success toast with the row counts, and writes one audit line to the **SyncLog**
   tab (`timestamp, deviceId, action, rowsIn, rowsOut, status, message`).

Large documents may finish as a **partial** result: Apps Script stops a run after 6 minutes and
returns a `nextCursor`; the app simply continues from that cursor, so nothing is lost — press
**Sync now** again if the toast says work remains.

## Selective sync (and API keys)

Eight switches control what travels, each in **Settings → Data → Cloud sync**:

| Toggle | What syncs | What stays local |
| --- | --- | --- |
| **projects** | Project names, languages, status, timestamps | — |
| **pages** | Page geometry and per-page metadata | Rendered page images / render cache |
| **blocks** | Text blocks, layout, per-line styling (JSON in the `data` column) | Revisions history |
| **glossary** | Glossary terms and notes | — |
| **Provider settings** *(on by default)* | `ai.*` setting ids: active provider, model, base URL, imported models | Anything not prefixed `ai.` |
| **App settings** *(off by default)* | Theme, language, cache limits, sync policy, … | Secret-looking ids (filtered before sending), and every `ai.*` id while Provider settings is off |
| **usage** | Usage statistics counters | Job queue, outbox, events |
| **API keys** *(off by default)* | See below | Everything, while it is off |

Provider settings and App settings share one `Settings` tab but follow **their own** switches,
so turning one on never drags the other's rows with it.

### API keys — opt-in, and in plain text

Keys are **not synced by default**. If you turn the **API keys** switch on, the sheet's
`ApiKeys` tab receives the *readable value* of each key.

This is deliberate: the Sheet is your own personal database — you created it, you hold its
`TOKEN`, and you control its sharing — and re-typing every key on every device is the problem
the option exists to remove. It is also the only part of the app that moves a secret, so the
rules are strict:

- **Off by default, and its own switch.** Nothing travels until you say so; the panel states in
  plain words that the values will be readable to anyone with access to the spreadsheet.
- **Only identifying fields.** provider, label, model list, enabled flag, last four characters,
  the secret and a creation timestamp. Device-local counters, cooldowns and probe results stay
  behind so one device cannot clobber another's.
- **Opened at the last moment.** The sealed payload is decrypted while the request is being
  built; no readable secret is written to IndexedDB, the outbox, or a log line. A delete
  tombstone carries no payload at all.
- **Re-sealed on arrival.** Device B opens the incoming plaintext and seals it again with its
  own key before storing it. A `cipher` from another device is ignored — it would be
  undecryptable here anyway.
- **Reversible.** Switching it off stops new writes. To remove what is already there, delete the
  `ApiKeys` tab or use **Delete cloud data**.

Two guards still protect the *rest* of the system:

1. **Client side** — every settings id that looks like a credential (`key`, `token`, `secret`,
   `password`, `authorization`) is dropped before a single byte is sent, whatever the toggles say.
2. **Server side** — `apps-script/Code.gs` rejects the whole request with `SECRET_NOT_ALLOWED`
   if any record on the `Settings` sheet matches that pattern. The guard applies to that sheet
   only; `ApiKeys` is the single, intentional exception.

### Older `Code.gs` deployments

`Code.gs` validates an entire push before writing anything, so an unknown entity would fail the
whole batch. The app therefore asks `ping` which entities the deployment can store and **holds
key rows** (queued, with backoff) until it gets an answer — other entities keep syncing the whole
time. Press **Test connection** after re-deploying to clear the notice that appears under the
API keys switch.

## Delete cloud data vs. delete local data

Both actions destroy data. Read the difference before pressing either button:

| | **Delete cloud data** (Settings → Data → Cloud sync) | **Delete all local data** (Settings → Data → Danger zone) |
| --- | --- | --- |
| What it removes | Every data row in the Sheet’s Projects / Pages / Blocks / Glossary / Settings / UsageStats / ApiKeys tabs | Everything in this browser: projects, caches, settings, keys, logs |
| What survives | Header rows, tab structure and the **SyncLog** audit trail | The Sheet in the cloud is untouched |
| How it is confirmed | You must type `WIPE` to confirm | Confirm with **Delete everything** |
| Reversible? | No — export a backup first | No — export a backup first |

Recommendations:

- Moving to a different Google account? **Delete cloud data** in the old one, deploy to the new
  Sheet, update the URL, then **Sync now**.
- Starting over on this device? Export a backup (Settings → Data → Export backup) **before**
  deleting anything.
- Never run “delete local data” while `N changes waiting to sync` is non-zero unless you are
  sure those changes exist somewhere else.

## Using sync on two devices

1. On device B, install/open the app in a second browser (or another browser profile).
2. Go to **Settings → Data → Cloud sync** and enter the **same** Apps Script URL and the
   **same** token, then enable sync.
3. Press **Sync now** on device A, then on device B (or wait for auto-sync). Device B
   downloads everything; further edits converge with each subsequent sync.
4. From then on, edit on either device and sync — the Sheet relays the differences.

### Conflict policy — which copy survives

If both devices edited the same record while offline, the policy chosen in **Settings → Data**
decides the winner when the changes meet:

| Policy | Winner | Use when |
| --- | --- | --- |
| **Keep local version** (`local`) | The copy on this device | This device is your main workstation |
| **Keep cloud version** (`remote`) | The copy coming from the Sheet | The other device did the newer work |
| **Keep newest version** (`newest`, default) | The record with the later `updatedAt` (ties broken by version, then device id) | You are unsure — usually safest |

- On the Sheet itself, writes are always last-write-wins using the same
  `updatedAt → version → deviceId` ordering, so the relay never ends up with two rows for one id.
- Every time a conflict is resolved, the losing copy is captured in the local **conflict log**
  (`syncConflicts`). **Settings → Data** shows the current conflict count, so you can notice and
  restore a losing version if needed.

## CORS and `text/plain` posts

Two browser-side facts explain most “it does not even send” problems:

1. The app posts with **`Content-Type: text/plain`** carrying a JSON body on purpose. A
   `application/json` body would trigger a CORS `OPTIONS` preflight, which Apps Script web apps
   do not handle, and the request would fail before reaching your script.
2. Apps Script answers with `Access-Control-Allow-Origin: *` **only** when the deployment is
   *Execute as: Me* **and** *Who has access: Anyone*. The script itself cannot set response
   headers, so the deployment setting is the only thing to fix.

If the browser blocks the request, re-check, in this order:

1. Deployment access = **Anyone** (not *Anyone with Google account*, not *Only myself*).
2. The URL ends in **`/exec`** (not `/dev`, not an editor link).
3. You redeployed after the last code edit (**New version**).
4. The token was authorised once after deployment (open the `/exec` URL directly; it should
   return a small JSON document).

## Troubleshooting

Apps Script web apps always answer HTTP 200; failures arrive inside the JSON envelope as
`{ "ok": false, "code": …, "message": … }`. The app shows the `code` — match it here:

| Code | Likely cause | Fix |
| --- | --- | --- |
| `UNAUTHORIZED` | The app’s token does not match the `TOKEN` Script Property; the property is missing or empty | Re-enter the token in Settings → Data → Cloud sync (watch for trailing spaces); add/fix the `TOKEN` property in Project Settings; redeploy if you recreated the project |
| `BAD_REQUEST` | Malformed request: missing `action`, body larger than 5 MB, invalid JSON, or a `wipe` call without `confirm: "WIPE"` | Normally an app/version mismatch — update the app; if it persists, redeploy the latest `Code.gs`; retry the action |
| `UNKNOWN_ACTION` | The deployed script is older than the app (or vice versa) — the action name is not in the script’s registry | Deploy `apps-script/Code.gs` again as a **New version**, then retry |
| `LOCK_TIMEOUT` | Another device/session is syncing right now (script lock held longer than 30 s), or a previous run is still finishing | Wait a few seconds and retry; avoid pressing **Sync now** on several devices at the same moment; reduce auto-sync frequency |
| `SECRET_NOT_ALLOWED` | A record on the **Settings** tab whose id or field name looks like a credential was included in the push | This is the safety guard working — the Settings tab never stores credentials, not even for your sync token. Remove/rename the offending setting locally; do not store secrets in settings ids. (API keys are not affected: they belong to the `ApiKeys` tab, which has its own opt-in switch) |
| `NOT_FOUND` | The app referenced a project id that does not exist on the Sheet (it was wiped or deleted elsewhere) | Run **Sync now** on the device that owns the project so it re-uploads; if the cloud data was wiped intentionally, ignore or delete the local project |
| `INTERNAL` | A tab is missing, its header row was edited by hand, the script is not bound to a sheet (standalone deployment without `SPREADSHEET_ID`), a Google Sheets read/write failure (tab deleted mid-sync, header changed, spreadsheet moved or access revoked), Google throttling the script (per-user execution quota or concurrent-execution limit exhausted), or an unexpected script error | Delete the damaged tab so the script recreates it, or restore the exact header row; if you deploy standalone, set the `SPREADSHEET_ID` Script Property; after throttling, wait for the quota to reset, lengthen the auto-sync interval and sync fewer devices at once; check **SyncLog** for the failing action |

Also useful:

- **SyncLog tab** — one row per request with `status` (`OK` / `ERROR`) and a short message.
  Filter `status = ERROR` to see exactly which action failed and why.
- **Logs page in the app** (sidebar → Logs) — the local counterpart with reason codes such as
  `SYNC_FAILED`; export the JSON if you want to file a bug.
- **Large cells** — Google Sheets caps a cell at 50,000 characters; the script truncates values
  over 45,000 characters and records the truncation in SyncLog instead of failing the request.

## Uninstalling

To remove the integration completely:

1. **Stop the deployment** — Apps Script → **Deploy → Manage deployments → ⋮ → Delete**.
   The `/exec` URL stops answering immediately.
2. **Delete the token** — Project Settings → Script Properties → delete `TOKEN`, so a leaked
   URL cannot be abused later.
3. **Delete the Sheet** — move `Doc Translator Sync` (or whatever you named it) to Google
   Drive’s trash. Deleting the Sheet destroys the cloud copy of your data.
4. **Clear the app** — Settings → Data → Cloud sync: clear the Apps Script URL and the access
   token; turn **Enable sync** and **Auto sync** off. You can keep your local projects — they
   live only in this browser and remain usable offline.

## Where the pieces live in this repository

| Path | Role |
| --- | --- |
| `apps-script/Code.gs` | The backend: actions (`ping`, `pushChanges`, `pullChanges`, `listProjects`, `getProject`, `upsertBlocks`, `deleteProject`, `backup`, `wipe`), sheet layout, error codes, locking |
| `apps-script/appsscript.json` | Manifest: Asia/Yangon, V8 runtime, spreadsheets-only scope, web-app access |
| `src/pages/settings/DataTab.tsx` | The Settings → Data UI (URL, sealed token, switches, conflict policy, danger zone) |
| `src/i18n/locales/en.json` | Sync UI labels under `settings.data` |
