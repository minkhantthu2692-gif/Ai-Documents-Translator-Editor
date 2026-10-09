# AI Documents Translator & Editor

**Offline-first AI စာရွက်စာတမ်း ဘာသာပြန်ကိရိယာနှင့် တည်းဖြတ်ကိရိယာ** — PDF စာရွက်စာတမ်း
များကို မူရင်း ပုံဖော်မှု၊ ဖောင့်များနှင့် ပုံများ မပျက်စီးဘဲ ဘာသာပြန်ပြီး၊ block တစ်ခုချင်း
ပြင်ဆင် တည်းဖြတ်ကာ အမျိုးမျိုးသော format များဖြင့် ထုတ်ယူနိုင်ပါသည်။ အသုံးပြုသူ၏
browser အတွင်းတွင်သာ အလုပ်လုပ်ပြီး UI သည် အင်္ဂလိပ်နှင့် မြန်မာ နှစ်ဘာသာဖြစ်ပါသည် —
cloud sync နှင့် AI troubleshooting assistant မှာ လိုအပ်မှသာ ဖွင့်သုံးနိုင်ပါသည်။

- **Local-first** — စာရွက်စာတမ်းများကို ဆာဗာပေါ်မဟုတ်ဘဲ
  သင့်စက်ရှိ IndexedDB ထဲတွင် သိမ်းဆည်းထားပါသည်။
- **BYOK** — Gemini, OpenRouter, Groq သို့မဟုတ် OpenAI-compatible key ကို သင်ပိုင်သည်ဖြင့် သုံးပါ။
- **PWA** — install လုပ်နိုင်ပြီး offline application shell ဖြင့်
  အင်တာနက်မရှိလည်း အသုံးပြုနိုင်ပါသည်။

တည်နေရာ — <https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor>

## အင်္ဂါရပ်များ

**စာရွက်စာတမ်း မောဒယ်နှင့် တည်းဖြတ်ရေး** (Phase 1)

- Project → page → block ဖွဲ့စည်းပုံ၊ Dexie (IndexedDB) ဇယားများနှင့် schema migration များ။
- Undo/redo သမိုင်း၊ find & replace၊ split view၊ inspector နှင့် revision များပါသော block editor။
- အင်္ဂလိပ်/မြန်မာ နှစ်ဘာသာ UI၊ light / dark / system theme၊ မျက်နှာပြင်အလိုက် ကိုက်ညီသော ပြသမှု။

**PDF သွင်းယူခြင်းနှင့် ခွဲခြမ်းစိတ်ဖြာခြင်း** (Phase 2)

- Pre-flight စစ်ဆေးချက်များ — စကားဝှက်ထားထားခြင်း၊ အရွယ်အစားကြီးလွန်းခြင်း၊ စာသားမပါခြင်း
  (text layer မရှိ)၊ ဖိုင်ပျက်နေခြင်း။
- Web Worker အတွင်း pdf.js ဖြင့် ဖတ်ရှုခြင်း၊ ပုံဖော်မှု ဆွဲထုတ်ခြင်းနှင့် စာမျက်နှာ thumbnail များ။
- Scan ထားသော/ဓာတ်ပုံစာမျက်နှာများအတွက် OCR (tesseract.js) — တစ်ခါ download ပြီးနောက်
  offline သုံးနိုင်ပါသည်။
- စာရွက်စာတမ်း metadata နှင့် စာမျက်နှာ အမျိုးအစား ခွဲခြမ်းခြင်း (စာသား / ဓာတ်ပုံ)။

**ဘာသာပြန်စက်** (Phase 3)

- Provider များ — Google Gemini၊ OpenRouter၊ Groq နှင့် OpenAI-compatible endpoint များ။
- Key pool၊ key လဲသုံးခြင်း၊ key အလိုက် cooldown၊ rate-limit bucket နှင့် model fallback စနစ်။
- တစ်ကြိမ်လျှင် စာကြောင်း 15–25 ကြောင်း (သို့) ခန့်မှန်းခြေ token 1500 ဝန်းကျင်အထိ batch
  ခွဲပြီး၊ မအောင်မြင်သော batch ကို ခွဲကာ line-by-line ပြန်ကြိုးစားပါသည် — စာကြောင်းတစ်ကြောင်းမှ
  လွတ်သွားခြင်း၊ အစီအစဉ်ပြောင်းသွားခြင်း မရှိပါ။
- AIMD ဖြင့် တိုးတက်ညီညွတ်သော concurrency — free-tier key ကို အလွန်အကျွံ မနှိပ်ချုပ်ပါ။
- Glossary/terminology ထိန်းချုပ်မှု၊ translation memory၊ confidence score နှင့် quality flag များ။
- Pause / resume / cancel ရှိသော job queue — page refresh ပြီးနောက်လည်း ပြန်စတင်နိုင်ပါသည်။

**ထုတ်ယူခြင်းနှင့် ဒေတာ** (Phase 4)

- DOCX၊ EPUB၊ PDF (print)၊ raster PDF၊ bilingual PDF၊ HTML၊ Markdown၊ TXT၊ JSON၊
  CSV/TSV နှင့် စာမျက်နှာပုံများ (zip) — အများစုကို Web Worker အတွင်း progress ဖြင့် ဆောင်ရွက်သည်။
- JSON backup / restore — API key များ sealed အဖြစ်သာ ပါသွားပြီး ၎င်းကို ဖန်တီးခဲ့သော စက်တွင်သာ
  ဖွင့်နိုင်ပါသည်။
- Reason code များ၊ ပြင်ဆင်နည်း အကြံပြုချက်များနှင့် JSON export ပါသော Logs page။
- Writing assistant toggle၊ သုံးစွဲမှု charts နှင့် Settings tabs — General, Cache, Data, Providers,
  Assistant, About။

**Cloud sync နှင့် troubleshooting assistant** (Phase 5 — လက်ရှိအဆင့်)

- `apps-script/Code.gs` မှတစ်ဆင့် Google Sheets sync — shared-secret token၊ LockService၊
  chunked push/pull၊ tombstone ဖြင့် delete ပျံ့နှံ့ခြင်း၊ per-entity toggle၊ auto-sync၊
  **Sync Now**၊ connection test၊ cloud wipe နှင့် local delete။
- `src/sync/` ရှိ sync engine — outbox → delta push → paged pull → last-write-wins merge
  (အသိုက်အမြုံ conflict log ဖြင့်)။ Offline တွင် မြန်မြန် fail ပြီး ကွန်ရက်ပြန်ရလျှင်
  အလိုအလျောက် retry ပြန်ဆောင်ရွက်ပါသည်။
- `src/assistant/` ရှိ Troubleshooting Assistant — proxy mode (သင့် `proxy/` server) သို့မဟုတ်
  အပြည့်အဝ offline rule-based fallback၊ secret များ အလိုအလျောက် redaction နှင့်
  one-click safe action များ (rotate-key, reduce-batch, clear-cache, retry စသည်)။
- `.env.example`၊ `tools/` ရှိ launcher script များနှင့် GitHub Pages deploy workflow။

## အမြန်စတင်နည်း

**ကြိုတင်လိုအပ်ချက် —** Node.js ≥ 18 (20 ကို အကြံပြုသည်)၊ npm နှင့် မော်ဒန် browser တစ်ခု။

```bash
git clone https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor.git
cd Ai-Documents-Translator-Editor
npm install
npm run dev
```

<http://localhost:5173> ကို ဖွင့်ပါ။ Cloud sync သို့မဟုတ် assistant proxy ကို ဖွင့်ချင်ပါက
`cp .env.example .env` ပြုလုပ်ပါ (ဤအက်ပ်သည် ထိုဖိုင်မပါဘဲလည်း အပြည့်အဝ အလုပ်လုပ်ပါသည်)။

**တစ်ချက်နှိပ် နည်းလမ်းများ**

| ရွေးချယ်စရာ | လုပ်ဆောင်ချက် |
| --- | --- |
| `tools/open-app.bat` (Windows) / `tools/open-app.sh` (macOS/Linux) | Node ≥ 18 ရှိ/မရှိ စစ်ဆေးပြီး၊ dependency မရှိလျှင် install လုပ်ကာ၊ `.env.example` → `.env` ကို တစ်ခါသာ ကူးယူပြီး၊ Vite ကို စတင်ကာ <http://localhost:5173> ကို ဖွင့်ပေးသည် |
| `tools/launcher.html` | နှစ်ဘာသာ စတင်မီနူး — setup checklist၊ command တစ်ခုချင်းစီအတွက် copy ခလုတ်၊ environment စစ်ဆေးမှုနှင့် **Open app** ခလုတ်ပါရှိသည် |
| `tools/push-to-github.bat` / `tools/push-to-github.sh` | `main` သို့ commit + push လမ်းညွှန် — `.env`၊ `node_modules`၊ `dist` ကို `.gitignore` က ဖုံးထားကြောင်း စစ်ဆေးပြီး credential မှတ်သားထားခြင်း မရှိပါ |

## script များနှင့် အရည်အသွေး စစ်ဆေးမှု

| Command | လုပ်ဆောင်ချက် |
| --- | --- |
| `npm run dev` | Vite dev server — <http://localhost:5173> |
| `npm run build` | `tsc --noEmit` ပြီးနောက် `vite build` → `dist/` |
| `npm run preview` | production build ကို သီးသန့် serve လုပ်ခြင်း (port 4173) |
| `npm test` / `npx vitest run` | Unit စမ်းသပ်ချက်များ (Vitest + Testing Library + fake-indexeddb) |
| `npm run test:watch` | Vitest watch mode |
| `npm run lint` / `npm run lint:fix` | ပတ်ဝန်းကျင် အပြည့်အဝ ESLint |
| `npx prettier --check .` | Prettier format စစ်ဆေးမှု (`.md` ဖိုင်များ ကျုံ့မဝင်ပါ) |
| `npm run typecheck` | `tsc --noEmit` သာ |
| `npm run smoke` | **ဖွင့်ထားသော** dev server ကို headless Chrome CDP ဖြင့် စမ်းသပ်သော smoke test |

**တိုင်းတာခြင်း (full gate) — commit / PR မလုပ်မီ အမြဲတမ်း ရှိပါ:**

```bash
npx tsc --noEmit
npx eslint .
npx prettier --check .
npx vitest run
npm run build
npm run dev &        # ဒုတိယ terminal တွင်၊ :5173 ပေါ်မှာ
npm run smoke
```

`npm run smoke` အတွက် Chrome ထည့်သွင်းထားရန်၊ `fixtures/` ဖိုင်များ ရှိရန်
(`node scripts/make-fixtures.mjs` ဖြင့် ဖန်တီးနိုင်) နှင့် dev server စတင်ထားရန် လိုအပ်ပါသည်။

## ပတ်ဝန်းကျင် ပြောင်းလဲနိုင်သော တန်ဖိုးများ

`.env.example` ကို `.env` အဖြစ် ကူးယူပြီး (git-ignored) ပြင်ပါ။ တန်ဖိုးအားလုံး မဖြစ်မနေ
မဟုတ်ပါ (optional)။

| ပြောင်းလဲနိုင်သောတန်ဖိုး | မဖြစ်မနေ လိုအပ်သည့်အခါ | ရည်ရွယ်ချက် |
| --- | --- | --- |
| `VITE_APPS_SCRIPT_URL` | Cloud sync | `/exec` ဖြင့် ပြီးသော Apps Script web-app endpoint။ ကွက်လပ် = အချက်အလက်အားလုံး ဤ browser အတွင်းမှာပင် |
| `VITE_APPS_SCRIPT_TOKEN` | Cloud sync | `TOKEN` Script Property အဖြစ် သင်သတ်မှတ်ထားသော shared secret — မကိုက်လျှင် `UNAUTHORIZED` ဖြင့် ငြင်းပယ်ခံရသည် |
| `VITE_ASSISTANT_PROXY_URL` | Assistant proxy mode | `proxy/` server ၏ base URL (ဥပမာ `http://127.0.0.1:8787`)။ ကွက်လပ် = built-in offline assistant |
| `VITE_BASE` | Sub-path hosting | အက်ပ်ကို serve လုပ်သည့် base path — GitHub Pages project site အတွက် `/REPO_NAME/` ကဲ့သို့ |

> တန်ဖိုးများသည် **build လုပ်စဉ်အတွင်းသာ** ပါဝင်သွားပါသည် — `.env` ပြင်ပြီးနောက်
> `npm run dev` ကို ပြန်စတင်ပါ သို့မဟုတ် build ပြန်လုပ်ပါ။ Provider API key သို့မဟုတ်
> assistant key ကို `VITE_` အရှေ့ဆက်ဖြင့် တိုးမထည့်ပါနှင့် — `VITE_` စာသားဖြင့် စတင်သော
> တန်ဖိုးမှန်သမျှ public JavaScript ထဲသို့ ရောက်သွားပါသည်။

## Cloud sync (ရွေးချယ်နိုင်)

စက်တိုင်းတွင် ၎င်း၏ IndexedDB မိတ္တူကို **source of truth** အဖြစ် သိမ်းထားပါသည်။ Google Sheet
သည် စက်များကြား မျှဝေသည့် relay အဖြစ် အသုံးပြုပါသည် — **Settings → Data → Cloud sync**
တွင် ဒေတာပို့ပြီး ယူပါသည် (`ping`, `pushChanges`, `pullChanges`, `listProjects`,
`getProject`, `upsertBlocks`, `deleteProject`, `backup`, `wipe`)၊ ပေါင်းစပ်ရာတွင်
last-write-wins သုံးကာ ပြောင်းလဲခံရသည့် record တိုင်းကို စက်အတွင်း conflict log တွင်
မှတ်တမ်းတင်ပါသည်။ API key များနှင့် secret နှင့်တူသော settings များကို တက်မတင်ပါ။

အဆင့်ဆင့် ပြင်ဆင်နည်း (Sheet ဖန်တီးခြင်း၊ `apps-script/Code.gs` နှင့် `appsscript.json`
ကူးထည့်ခြင်း၊ `TOKEN` Script Property သတ်မှတ်ခြင်း၊ web app အဖြစ် deploy လုပ်ခြင်း) —

**→ [docs/GOOGLE_APPS_SCRIPT_SETUP.my.md](docs/GOOGLE_APPS_SCRIPT_SETUP.my.md)**
(English: [docs/GOOGLE_APPS_SCRIPT_SETUP.md](docs/GOOGLE_APPS_SCRIPT_SETUP.md))

## Troubleshooting assistant (ရွေးချယ်နိုင်)

Logs page တွင် သုံးသော တူညီသော structured context ကို အသုံးပြုပြီး error များကို ရိုးရှင်းသော
ဘာသာစကားဖြင့် ရှင်းပြကာ ပြင်ဆင်နည်း အဆင့်များ အကြံပြုပါသည်။ စနစ်နှစ်ခု ရှိပါသည် —

| စနစ် | အသုံးပြုသည့်အခါ | နည်းလမ်း |
| --- | --- | --- |
| Proxy | `VITE_ASSISTANT_PROXY_URL` သည် `proxy/` ကို ညွှန်နေလျှင် | Browser မှ `{question, context, lang}` ကို `POST /assistant` သို့ ပို့ပြီး၊ proxy က server တွင်သာ ရှိသော key ဖြင့် OpenRouter ကို ခေါ်ပါသည် |
| Offline rules | Proxy URL မရှိ သို့မဟုတ် ကွန်ရက်မရှိ | reason code များကို ရှင်းလင်းချက်များအဖြစ် ပြောင်းပေးသော built-in rule engine — request တစ်ခုမှ မပို့ပါ |

One-click safe action များ (rotate-key, reduce-batch, clear-cache, retry, open-providers,
open-data, open-logs) သည် အားလုံး သင့်စက်ပေါ်တွင်ပင် အလုပ်လုပ်ပါသည်။

- **→ [docs/TROUBLESHOOTING.my.md](docs/TROUBLESHOOTING.my.md)** — reason code အားလုံးနှင့်
  ဖြေရှင်းနည်း ([English](docs/TROUBLESHOOTING.md))
- **→ [docs/API_KEYS_GUIDE.my.md](docs/API_KEYS_GUIDE.my.md)** — key ဘယ်မှာရယူရမည်၊
  ဘယ်လိုသိမ်းမည် ([English](docs/API_KEYS_GUIDE.md))
- **→ [proxy/README.md](proxy/README.md)** — proxy ၏ contract၊ ကန့်သတ်ချက်များနှင့် deployment

## ဒေတာနှင့် ကိုယ်ရေးအချက်အလက်

- သင့်စာရွက်စာတမ်းများ၊ glossary၊ log များနှင့် settings များ အားလုံး **သင့် browser ၏
  IndexedDB** တွင်ပင် ရှိနေပါသည်။ Cloud sync ကို သင်ဖွင့်မချိန်အထိ တစ်စက်မှ မတက်ပါ။
- **Telemetry၊ analytics၊ error reporting လုံးဝ မရှိပါ။** အက်ပ်သည် မိမိဘာသာ ကွန်ရက်
  တောင်းဆိုမှု မလုပ်ပါ — ဘာသာပြန်မှု စတင်ခြင်း၊ sync ဖွင်ခြင်း၊ OCR data download ခြင်း၊
  assistant မေးမြန်းခြင်း သင် လုပ်သမျှအတွက်သာ request ထွက်ပါသည်။
- Provider API key များကို WebCrypto (AES-GCM + PBKDF2) ဖြင့် sealed အဖြစ် သိမ်းပြီးမှ
  storage တွင်း ရောက်သည် — backup တွင် plaintext အဖြစ် မပါပါ။ sync တွင်လည်း မပို့ပါ —
  သင် မဖွင့်မက **API key များ** sync (မူလ ပိတ်ထားသော ခလုတ်သီးသန့်) ကို ဖွင့်ပါကသာ ၎င်းတို့၏
  ဖတ်နိုင်သော တန်ဖိုုများကို သင့်ကိုယ်ပိုင် Google Sheet ထဲသို့ တမင်ရေးသည်
  (**[docs/SECURITY.md](docs/SECURITY.md)** ကို ကြည့်ပါ)။
- `.env` စီမံခန့်ခွဲမှု၊ redaction rule များနှင့် အသိပေးနည်း လုပ်ထုံးကို
  **[docs/SECURITY.md](docs/SECURITY.md)** တွင် ဖော်ပြထားပါသည်။

## စီမံကိန်းဖွဲ့စည်းပုံ

```text
.
├── src/                 React အက်ပ်
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
├── public/              service worker ဖိုင် (sw.js), manifest, icon များ
├── scripts/             smoke test နှင့် fixture builder များ
├── tools/               launcher.html, open-app.*, push-to-github.*
├── docs/                စာတမ်းများ (ဤဖိုင်နှင့် နှစ်ဘာသာ guide များ)
└── .github/workflows/   deploy.yml — GitHub Pages
```

## စာတမ်းများ

| စာတမ်း | ဘာသာစကား | အကြောင်းအရာ |
| --- | --- | --- |
| [README.md](README.md) | English | ဤ README ၏ အင်္ဂလိပ်မူ |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | English | Layer များ၊ sync data flow၊ translation pipeline၊ offline/PWA |
| [docs/SECURITY.md](docs/SECURITY.md) | English | Threat model၊ key သိမ်ဆည်းပုံ၊ redaction၊ အသိပေးနည်း |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | English | Local build၊ GitHub Pages၊ self-hosting၊ proxy deploy |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | English | ပါဝင်ကူညီနည်း၊ full gate၊ style၊ test၊ i18n၊ testid |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | English | Keep-a-Changelog ထုတ်ပြန်ချက် မှတ်တမ်း |
| [docs/LICENSE](docs/LICENSE) | English | MIT လိုင်စင် စာသား |
| [docs/GOOGLE_APPS_SCRIPT_SETUP.my.md](docs/GOOGLE_APPS_SCRIPT_SETUP.my.md) | မြန်မာ · English | Cloud sync ပြင်ဆင်နည်း အဆင့်ဆင့် |
| [docs/API_KEYS_GUIDE.my.md](docs/API_KEYS_GUIDE.my.md) | မြန်မာ · English | Provider key ရယူခြင်းနှင့် သိမ်ဆည်းခြင်း |
| [docs/TROUBLESHOOTING.my.md](docs/TROUBLESHOOTING.my.md) | မြန်မာ · English | Reason code များ၊ sync error များ၊ assistant |
| [proxy/README.md](proxy/README.md) | English | Assistant proxy ၏ contract နှင့် deployment |

နှစ်ဘာသာ စည်းမျဉ်း — အဖိုင်တစ်ခုနှင့် တွဲဖက်သော `.my.md` ဖိုင်သည် ၎င်းစာတမ်း၏
မြန်မာဘာသာပုံစံဖြစ်ပါသည်။

## ပါဝင်ကူညီခြင်း

Issue နှင့် pull request များ ကြိုဆိုပါသည်။ မလုပ်မီ **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**
ကို အရင်ဖတ်ပါ — အထူးသဖြင့် full gate (`tsc` · `eslint` · `prettier` · `vitest` · `build` ·
`smoke`)၊ UI စာသားအသစ်တိုင်းအတွက် `en.json` နှင့် `my.json` နှစ်ခုလုံး ပြင်ရန် စည်းမျဉ်း၊
နှင့် smoke test သုံးသော `data-testid` စည်းမျဉ်း။

## လိုင်စင်

MIT — [docs/LICENSE](docs/LICENSE) ကို ကြည့်ပါ။
Copyright (c) 2026 minkhantthu2692-gif.

## ပြောင်းလဲမှုမှတ်တမ်း

[docs/CHANGELOG.md](docs/CHANGELOG.md) ကို ကြည့်ပါ။
