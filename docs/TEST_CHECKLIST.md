# Test Checklist

Everything that must pass before a Phase 5 release. Sections 1–3 are automated; sections 4–9
need a human, a Sheet and two browsers. Myanmar version of the reasoning lives inline so one
file stays in sync with itself — commands are identical in both languages.

> စမ်းသပ်ခြင်း အစီအစဉ် — အပိုင်း ၁–၃ ကို tool ဖြင့် အလိုအလျောက် စစ်ပြီး ကျန်အပိုင်းများကို
> လူဖြင့် စစ်ဆေးပါ။

---

## 1. Automated gate (run from the repo root)

| # | Command                        | Expect                                        |
| --- | ------------------------------ | --------------------------------------------- |
| 1 | `npx tsc --noEmit`             | exits 0, no output                            |
| 2 | `npx eslint .`                 | exits 0, no warnings                          |
| 3 | `npx prettier --check .`       | `All matched files use Prettier code style!`  |
| 4 | `npx vitest run`               | all files green (500+ tests)                  |
| 5 | `npm run build`                | `dist/` produced, no type errors              |
| 6 | `npm run dev` (window 1)       | server on <http://localhost:5173>             |
| 7 | `npm run smoke` (window 2)     | `SUMMARY: n/n passed`, zero failures          |

PowerShell 5.1 note: run the commands one at a time — `&&` does not work there.

**What the smoke run covers for Phase 5** (section 10 in `scripts/smoke.mjs`):

- [ ] `Phase 5 tooling + docs files exist` — Apps Script, proxy, tools/, workflow, every doc
- [ ] `.env.example documents the three VITE_ variables`
- [ ] `.gitignore excludes .env (secrets stay local)`
- [ ] `sync status line renders a valid state` (`data-state` ∈ disabled/idle/syncing/error/offline)
- [ ] `sync controls present` (9/9) and `per-entity sync toggles present` (6/6)
- [ ] backup file input still unique + export/import/delete-local buttons present
- [ ] assistant dialog opens, mode badge = `offline`, ≥ 3 safe actions, rate-limit explained
- [ ] `launcher.html renders from file:// with all controls` (6/6 ids) + copyable commands

## 2. Secret scan (must be clean)

```sh
git status --porcelain                # .env must NOT appear
git ls-files | Select-String -Pattern '\.env$'   # PowerShell: no results (only .env.example)
git grep -nIE '(sk-[a-zA-Z0-9]{8,}|ghp_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|OPENROUTER_ASSISTANT_KEY=.)' 
```

- [ ] No tracked file contains a real-looking key (the grep above returns nothing but
      documentation examples with obvious placeholders)
- [ ] `git check-ignore .env node_modules dist` prints all three paths
- [ ] `tools/push-to-github.*` contains **no** stored token — it only uses the credential helper
- [ ] `src/assistant/redact.ts` rule list still covers `Bearer`, `sk-`, `sk-or-v1-`, `ghp_`,
      `github_pat_`, `AKIA`, `AIza`, `key=`, long hex/base64 (unit tests in
      `src/assistant/assistant.test.ts`)

## 3. Assistant — both modes (automated part)

- [ ] `npx vitest run src/assistant/assistant.test.ts` → 28/28 (redact, rules, proxy fallbacks,
      actions, error memory, context)
- [ ] Offline mode (no `VITE_ASSISTANT_PROXY_URL`): open **Logs → open assistant**, ask
      “rate limit exceeded” → plain-language answer, numbered steps, ≥ 3 action buttons, badge
      shows **Offline rules**
- [ ] Answer actions actually run: **Reduce batch size** lowers
      Settings → `translate.batchMaxLines`, **Clear cache** empties the cache,
      **Rotate key** clears provider cooldowns
- [ ] Auto-redaction: paste a fake `sk-or-v1-…` into a log line / question → both the context
      preview and the rendered answer show `[REDACTED]`

## 4. Assistant — proxy mode (manual, needs a key)

1. `cd proxy && cp .env.example .env` then set `OPENROUTER_ASSISTANT_KEY=…` (server-side only)
2. `node server.js` (or deploy `cloudflare-worker.js`), note `http://localhost:8787`
3. Frontend `.env`: `VITE_ASSISTANT_PROXY_URL=http://localhost:8787`, restart `npm run dev`
4. Reopen the dialog → badge shows **AI proxy**, answer carries `model`

- [ ] Proxy answer arrives and is normalised (title ≤ 160 chars, ≤ 6 steps, ≤ 5 actions)
- [ ] Proxy action ids are mapped to the safe vocabulary — unknown ids are dropped, never rendered
- [ ] With the proxy **stopped**: ask again → falls back to offline rules, `fallbackNote` shown,
      badge flips back to **Offline rules** (no crash, no unhandled rejection)
- [ ] Proxy with no key → `{ok:false, code:"MISSING_KEY"}` → same offline fallback
- [ ] Assistant key is absent from the frontend bundle:
      `Select-String -Path dist\assets\*.js -Pattern 'OPENROUTER'` → no results

## 5. Cloud sync — two browsers converge (manual, one Sheet)

Setup: deploy `apps-script/Code.gs` as a web app (see `docs/GOOGLE_APPS_SCRIPT_SETUP.md`),
put the URL + token in **Settings → Data** on both browsers, enable sync.

- [ ] Browser A: create/edit a project, press **Sync now** → status turns `Up to date`,
      Sheet shows Projects/Pages/Blocks rows
- [ ] Browser B: **Sync now** → the same project appears with identical text
- [ ] Browser A: edit a block, sync; Browser B: edit a different block, sync → **both edits
      survive** (independent rows)
- [ ] True conflict: A and B edit the **same** block while offline, then sync in any order →
      newer `updatedAt` wins (LWW), the loser is listed under **conflicts** and can be restored
- [ ] **Test connection** → `Connected — … ms · 7 sheets visible`
- [ ] Selective toggle: turn **Usage stats** off, sync → no new UsageStats rows; turn it on →
      everything re-scans and pushes
- [ ] Wrong token → status `Sync error` with `UNAUTHORIZED`, Logs page records the failure,
      assistant explains it (`UNAUTHORIZED` rule)
- [ ] **Delete cloud data** → confirm dialog → Sheet tables emptied, local data untouched
- [ ] Deleting a project locally removes its Sheet rows on the next sync (cascade)

## 6. Offline → reconnect (manual)

- [ ] Go offline (DevTools → Network → Offline, or disconnect Wi-Fi)
- [ ] Edit several projects/blocks/settings → sync badge shows `Offline — queued locally`,
      pending counter grows (`syncPending`)
- [ ] Auto-sync while offline fails quietly — no toast spam, backoff applied (max 10 min)
- [ ] Reconnect → the next interval (or **Sync now**) drains the outbox in order
- [ ] Reload the page while offline → IndexedDB still has every edit; nothing was lost
- [ ] Outbox rows are removed only after the server confirms `applied`

## 7. Scripts on a clean machine (manual)

Simulate a fresh clone (rename your `node_modules` first, or clone into a temp folder):

- [ ] `tools/open-app.sh` (Git Bash/macOS) or `tools/open-app.bat` (Windows):
      checks Node ≥ 18 → `npm install` → copies `.env.example` → `.env` → starts dev →
      browser opens on `localhost:5173`
- [ ] `tools/push-to-github.sh` / `.bat` on a folder with no `.git`: initialises, sets branch
      `main`, sets **local-only** identity, adds/repairs `origin`, verifies `.gitignore`,
      prompts for a message, commits, pushes — and stores no token anywhere
- [ ] `bash -n tools/open-app.sh tools/push-to-github.sh` → no syntax errors
- [ ] `tools/launcher.html` opened directly from disk (`file://`): dark/light toggle, EN/မြန်မာ
      toggle, checklist ticks persist, every **copy** button copies its command, **Open app**
      reaches `localhost:5173`, **GitHub repository** opens the repo — no console errors

## 8. GitHub Pages deploy (manual, once)

- [ ] Repo **Settings → Pages → Source: GitHub Actions**
- [ ] Push to `main` → `.github/workflows/deploy.yml` goes green (typecheck → tests → build)
- [ ] Site loads at `https://minkhantthu2692-gif.github.io/Ai-Documents-Translator-Editor/`
- [ ] Hard-refresh a deep link (`/settings?tab=data`) → served via `404.html` fallback, app
      routes correctly (router `basename` = `VITE_BASE`)
- [ ] pdf.js CMaps/fonts load (`<base>pdfjs-assets/…`), service worker registers at
      `<base>sw.js`, offline reload keeps the shell

## 9. Regression sweep (any phase)

- [ ] en/my parity: switch to မြန်မာ and walk Settings/Logs/Sync/Assistant — no raw dotted keys,
      Myanmar renders in Noto Sans Myanmar (`src/i18n/coverage.test.ts` guards this)
- [ ] Backup export → wipe → import restores projects, settings and theme
- [ ] Translation queue: pause/resume/cancel survive a mid-run reload
- [ ] Export DOCX/EPUB/HTML/TXT still open correctly (known limits: style reset on re-parse,
      EPUB “Page N” labels, PDF via print dialog — see `docs/ARCHITECTURE.md`)
- [ ] `npm run smoke` still ends at `SUMMARY: n/n passed` after every section above

---

### Sign-off

| Area             | Automated | Manual | Notes |
| ---------------- | --------- | ------ | ----- |
| Gate (§1)        | ☐         | —      |       |
| Secrets (§2)     | ☐         | ☐      |       |
| Assistant (§3–4) | ☐         | ☐      |       |
| Sync (§5–6)      | ☐         | ☐      |       |
| Scripts (§7)     | ☐         | ☐      |       |
| Pages (§8)       | —         | ☐      |       |
| Regression (§9)  | ☐         | ☐      |       |
