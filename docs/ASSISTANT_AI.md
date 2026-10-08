# Assistant AI — စွမ်းရည်များနှင့် အဆင့်မြင့်တိုးတက်အောင် လုပ်နည်း

> ဤစာရွက်စာတမ်းက app အတွင်းပါဝင်သော **Assistant AI** (ပြဿနာဖြေရှင်းရာ လက်ထောက်) ၏ အသက်ဝင်ပုံ၊
> ၎င်း **တကယ်ပြင်ပေးနိုင်သလား ဒါမှမဟုတ် အကြံပေးရုံလား** ဆိုသည့်မေးခွန်း၊ နှင့်
> **အဆင့်မြင့် (advanced) အဆင့်သို့ တိုးတက်အောင် ဘယ်လိုလုပ်ရမည်** ဆိုသည်တို့ကို
> ကုဒ်အခြေခံ (codebase) မှ အတည်ပြုထားသည့်အတိုင်း ရှင်းလင်းစွာ ဖော်ပြထားသည်။

---

## ၁။ Assistant AI ဆိုသည်မှာ ဘာလဲ

Assistant AI သည် app တွင် ဖြစ်ပွားသော အမှားများ၊ ပြဿနာများကို ရှင်းလင်းပြီး **ဖြေရှင်းနည်းအဆင့်များ** ပြသပေးသည့်
built-in troubleshooting လက်ထောက် ဖြစ်သည်။ ဘာသာစကား ၂ မျိုး (မြန်မာ / အင်္ဂလိပ်) ဖြင့် အဖြေပေးနိုင်သည်။

**ဂရုပြုရန် —** ဤ feature သည် စာသားဘာသာပြန် AI (translation provider) နှင့် မတူပါ။ ဘာသာပြန်ရာတွင် သုံးသော
provider key / model နှင့် မသက်ဆိုင်ဘဲ၊ ပြဿနာဖြေရှင်းရာတွင် ကူညီဖို့ သီးခြားထည့်သွင်းထားသော စနစ် ဖြစ်သည်။

### ၁.၁ ဝင်ရောက်နိုင်သော နေရာများ

| ဝင်ရောက်နည်း | ရှင်းလင်းချက် |
| --- | --- |
| **Settings → Assistant** | `assistant-open` ခလုတ်ဖြင့် dialog ကို ဖွင့်နိုင်သည် |
| **Logs စာမျက်နှာ** | မှတ်တမ်းတစ်ခု (event) ကို ရွေးပြီး "ဘာဖြစ်နေတာလဲ" ရှင်းပြခိုင်းနိုင်သည် |
| **Dialog (global)** | AppShell တွင် အမြဲတမ်း mount ထားသော dialog — မည်သည့်စာမျက်နှာမှ ဖွင့်နိုင်သည် |
| **အမှားဖမ်းယူစနစ်** | `AssistantBootstrap` က uncaught error နှင့် unhandled promise rejection များကို အလိုအလျောက် မှတ်သားထားသည် — နောက်မှ dialog ဖွင့်လျှင် "မကြာသေးမီက ဘာဖြစ်ခဲ့သလဲ" ကို ရှင်းပြနိုင်သည် |

### ၁.၂ အလုပ်လုပ်ပုံ ၂ မျိုး (two modes)

| Mode | ဘယ်လိုအလုပ်လုပ်လဲ | အာုသာချက် / အားနည်းချက် |
| --- | --- | --- |
| **`offline`** (default / floor) | စက်အတွင်းရှိ **စည်းမျဉ်းစည်းကမ်း အခြေခံ rule engine** ဖြင့်သာ အဖြေတည်ဆောက်သည် | အင်တာနက် မလို၊ အမြဲတမ်း အလုပ်လုပ်သည် — သို့သော် ကြိုတင်ရေးထားသော rule များထဲကသာ ဖြေနိုင်သည် |
| **`proxy`** (advanced tier) | မေးခွန်း + လုံခြုံရေးဖြင့် ဖျက်ထားပြီး (redacted) context ကို `proxy/` server ထံ ပို့သည်။ Server က OpenRouter key ဖြင့် LLM ထံမေးပြီး အဖြေပြန်ပို့သည် | စိတ်ကြိုက်/နက်ရှိုင်းသော အဖြေ — သို့သော် proxy configure လုပ်ထားရန် လိုအပ်သည် |

**အရေးကြီးစည်းမျဉ်း —** proxy မကောင်းပါက (URL မသတ်မှတ်ထားခြင်း၊ ကွန်ရက်ပြတ်ခြင်း၊ timeout — စောင့်ချိန် ၂၀ စက္ကန့်၊
HTTP 4xx/5xx၊ ပုံစံမမှန်သော အဖြေ) ဆိုပါက **အမြဲတမ်း `offline` rule သို့ ချက်ချင်းပြန်ကျ**သည်။
Dialog သည် အချိန်မရွေး အဖြေတစ်ခုခု ပြသနိုင်ရန် တာဝန်ယူထားသည်။

---

## ၂။ ဘာတွေ လုပ်ပေးနိုင်လဲ (စွမ်းရည်များ)

### ၂.၁ အလိုအလျောက် ဖတ်ယူပေးသော အချက်အလက် (auto context)

မေးခွန်းတစ်ခု မေးတိုင်း၊ assistant က အောက်ပါအချက်များကို အလိုအလျောက် စုစည်းပြီး (စွန့်ပစ်/ဖျက်မထားမီ
`redact()` ဖြင့် ဖယ်ရှားပြီးမှ) အသုံးပြုသည်:

- နောက်ဆုံးဖြစ်ပွားခဲ့သော **error code / reason code / stack** (ဖျက်ထားပြီး — redacted)
- နောက်ဆုံး job အခြေအနေ (queued/running/paused/failed …)
- လက်ရှိ **provider နှင့် model** (key ကိုယ်တိုင် မပါ)
- မှတ်တမ်း (Logs) မှ နောက်ဆုံး error/warning စာကြောင်း ၈ ကြောင်း (redacted + ဖြတ်ထား)
- Browser အချက် (UA, ဘာသာစကား, online/ offline, viewport)
- `errorMemory` — မကြာသေးမီက ဖြစ်ခဲ့သော uncaught error များ (အများဆုံး ၂၀ ခု, in-memory)

### ၂.၂ Offline rule engine ၏ ဗဟုသုတ အခြေခံ

အောက်ပါအစဉ်အလိုက် အရင်တွေ့သည့်ဟု ဖြေသည်:

1. **မေးခွန်းစာသား keyword rule** (မြန်မာ + အင်္ဂလိပ်) — ၁၁ ခု: rate-limit (429/quota), missing-key, offline,
   sync-error, cache, export, backup, conflict, slow-batch, model, storage-full
2. **Sync error code table** — ၈ ခု: `sync-unauthorized`, `sync-not-configured`, `sync-network`,
   `sync-timeout`, `sync-lock`, `sync-secret`, `sync-bad-response`, `sync-internal`
3. **Reason-code catalogue** — app ၏ အမှားစာရင်းအားလုံး (ဥပမာ `NO_API_KEY`, `KEYS_LOCKED`,
   `QUOTA_EXHAUSTED`, `PDF_ENCRYPTED` …) ၏ ရှင်းလင်းချက် + ဖြေရှင်းနည်း အဆင့်များ
4. **Fallback** — ဘာမှ မကိုက်ညီပါကလည်း ယေဘုယျ ဖြေရှင်းနည်း အဆင့်များ + လုံခြုံသော လုပ်ဆောင်ချက်ခလုတ်များ ပေးသည်

### ၂.၃ အဖြေပုံစံ

တစ်ခုချင်းစီသော အဖြေသည် အောက်ပါအစုံ ပါဝင်သည်:

- **Title** (စာလုံး ၁၆၀ အထိ)
- **ရှင်းလင်းချက်** (explanation — စာလုံး ၃၀၀၀ အထိ)
- **အဆင့်များ** (steps — အများဆုံး ၆ ဆင့်, တစ်ဆင့်လျှင် စာလုံး ၄၀၀)
- **လုပ်ဆောင်ချက်ခလုတ်များ** (actions — အများဆုံး ၅ ခု, အမည် စာလုံး ၆၀)

Proxy mode မှ ပြန်လာသော အဖြေများကိုပါ format စစ်ဆေးပြီး (validate + cap)၊ နောက်ဆုံးတွင် `redact()` ထပ်ဖြင့်
ဖယ်ရှားပြီးမှပဲ UI တွင် ပြသသည် (defense in depth)။

### ၂.၄ လုံခြုံရေး အာမခံချက်များ

- API key / token / JWT / ရှည်လျားသော blob များကို **အထွက်တိုင်းတွင် `[REDACTED]` ဖြင့် အစားထိုး**သည်
- Proxy mode တွင် LLM key သည် **server တွင်သာ** ရှိပြီး browser ထိ လုံးဝ မရောက်ပါ
- Assistant က ဖတ်/ပြင်နိုင်သော လုပ်ဆောင်ချက်များကို **allowlist (7 ခု)** ဖြင့်သာ ကန့်သတ်ထားသည် —
  ခွင့်မပြုထားသော id ပါလာလျှင် ခလုတ် မပြပဲ ဖယ်ထုတ်သည် (dead button မရှိ)

---

## ၃။ အဓိကမေးခွန်း — တကယ်ပြင်ပေးသလား၊ ဒါမှမဟုတ် အကြံပေးရုံလား

**အဖြေ: နှစ်ခုလုံးပါ — ဒါပေမဲ့ အကြုံးဝင်သော "တကယ်ပြင်ပေးနိုင်တာ" က အကန့်အသတ်ရှိပါသည်။**

### ၃.၁ အခြေခု — ရှင်းပြခြင်းနှင့် အဆင့်ပြ အကြံပေးခြင်း (သုံးစွဲသူ လုပ်ရမည်)

အဖြေတိုင်း၏ အဓိကအစိတ်အပိုင်းက **ရှင်းလင်းချက် + အဆင့်များ** ဖြစ်ပြီး၊ ၎င်းအဆင့်များကို
**သုံးစွဲသူကိုယ်တိုင်** လိုက်လုပ်ရသည်။ ဥပမာ — "Settings → AI Providers တွင် သော့ ထည့်ပါ" ဆိုပါက
သော့ကို assistant က ထည့်မပေးဘဲ၊ သုံးစွဲသူ ကိုယ်တိုင် paste လုပ်ရသည်။

### ၃.၂ One-click safe actions — တကယ်ပြောင်းလဲပေးနိုင်သော လုပ်ဆောင်ချက် ၇ ခု

အဖြေအောက်တွင် ပါလာနိုင်သော ခလုတ်များထဲမှ **တကယ် state ပြောင်းလဲပေးနိုင်သည့်** လုပ်ဆောင်ချက်များ:

| Action ID | ဘာလုပ်ပေးလဲ | တကယ်ပြောင်းလဲမှု ရှိလား |
| --- | --- | --- |
| `rotate-key` | အအေးခံ (cooldown) ရောက်နေသော သော့များ၏ cooldown ကို ဖျက်ပေးပြီး AI Providers သို့ ခေါ်သွားသည် | ✅ **တကယ်** — key row data ပြောင်းသည် (သော့ secret ကိုယ်တို့ မဖတ်/မပြင်) |
| `reduce-batch` | ဘာသာပြန် လုပ်ဆောင်ချက်အစု ကို ×၀.၆ အထိ လျှော့ပေး (အနည်းဆုံး ၅ စာကြောင်း) | ✅ **တကယ်** — settings value ရေးသည် |
| `clear-cache` | ဘာသာပြန် cache အားလုံး ဖျက်သည် | ✅ **တကယ်** — cache table ဖျက်သည် |
| `retry` | Sync ဖြေရှင်းမှုဆိုပါက sync ချက်ချင်းစတင်; မဟုတ်ပါက app reload (offline ဖြစ်နေပါက တားပြီး အကြံပေးသည်) | ✅ **တကယ်** — sync/reload effect ဆောင်ရွက်သည် |
| `open-providers` | Settings → AI Providers သို့ ခေါ်သွားသည် | ⚠️ လမ်းညွှန်ဝင်ကူ (navigation) သာ |
| `open-data` | Settings → Data & Sync သို့ ခေါ်သွားသည် | ⚠️ navigation သာ |
| `open-logs` | Logs စာမျက်နှာ ဖွင့်သည် | ⚠️ navigation သာ |

**လုံခြုံရေး စည်းမျဉ်း** — ဤလုပ်ဆောင်ချက်များသည်: key material ကို မဖတ်/မရေး/မပြ၊ အတည်ပြုမှု (confirmation)
မပါဘဲ ဘာမှ **ဖျက်မသတ်**၊ ထပ်ဆောင်ရွက်လျှင် ပျက်စီးမှုမရှိ (idempotent)၊ နာမည်မသိပါက **ဘာမှ မပြောင်း**ပါ။

### ၃.၃ Assistant က **မလုပ်ပေးနိုင်သည်များ** (ကန့်သတ်ချက်)

- ❌ API key အသစ် ထည့်/လဲ/တင်ပေးခြင်း (သော့ထည့်ခြင်းက သုံးစွဲသူ၏ တာဝန် — လုံခြုံရေးအရ မဖျက်နိုင်)
- ❌ PDF/စာသား ဘာသာပြန်ပေးခြင်း၊ document ကိုယ်တိုင် ပြင်ပေးခြင်း (translation engine ၏ အလုပ်)
- ❌ ခွင့်ပြုထားသော ၇ ခု以外 **settings / ကုဒ် / ကိရိယာ configuration** ကို စိတ်ကြိုက် ပြင်ဆင်ခြင်း
- ❌ သုံးစွဲသူ နှိပ်မပေးဘဲ **အလိုအလျောက် လုပ်ဆောင်ခြင်း** — အဖြေက ခလုတ် "ပေး"ရုံသာဖြစ်ပြီး
  တကယ်လုပ်ရန် user ၏ explicit click လိုအပ်သည် (တစ်ဆိုင်းလုံး consent-based)
- ❌ Provider ဘက်ခြမ်းပြဿနာ (quota ပြန်ဖြည့်ပေးခြင်း၊ server ပြင်ပေးခြင်း) — ထိန်းချုပ်၍ မရနိုင်
- ❌ ကုဒ်ကိုယ်တိုင် debug / patch လုပ်ခြင်း

**အကျဉ်းချုပ် —** ၎င်းသည် *"ဘာဖြစ်နေလဲ ရှင်းပြပြီး ဘယ်လိုဖြေရှင်ရမလဲ အဆင့်ပြ"* သူ (guide) ဖြစ်သလို၊
လုံခြုံရေးအရ ခွင့်ပြုထားသော **အနည်းငယ်သော ပြင်ဆင်မှုများကို တစ်နှိပ်တည်းနှင့် တကယ်လုပ်ပေးနိုင်သော**
executor လည်း ဖြစ်သည်။ ၎င်းသည် **လုံးဝအလိုအလျောက် repair bot** တော့ မဟုတ်ပါ။

---

## ၄။ Advanced (အဆင့်မြင့်) အဆင့်သို့ တိုးတက်အောင် ဘယ်လိုလုပ်မလဲ

လက်ရှိ ဖွဲ့စည်းပုံသည် "offline floor + proxy tier" ဆိုပြီး ဒီဇိုင်းချထားသဖြင့် **အဆင့်လိုက် တိုးတက်အောင်
လုပ်နိုင်သည်** — အောက်ပါအတိုင်း အဆင့်များအလိုက် တက်နိုင်သည်:

### အဆင့် ၁ — Proxy mode (LLM) ကို deploy လုပ်ခြင်း — လက်ရှိ code ထဲ ပြင်ဆင်ပြီးသား

LLM ဖြင့် အဖြေထုတ်ပေးသော advanced mode သည် **တည်ဆောက်ပြီး** ဖြစ်သည် — deploy လုပ်ရုံသာ ကျန်သည်:

1. `proxy/server.js` (Node/Express) ကို run ပါ၊ သို့မဟုတ် `proxy/cloudflare-worker.js` ကို
   Cloudflare Workers တွင် deploy ပါ
2. Server ဘက်တွင် `OPENROUTER_ASSISTANT_KEY` ထည့်ပါ (key သည် browser ထိ လုံးဝ မရောက်ပါ)
3. Frontend `.env` တွင် `VITE_ASSISTANT_PROXY_URL` သတ်မှတ်ပါ
4. ပြီးလျှင် dialog က အဆင့်မြင့် အဖြေများကို `proxy` mode ဖြင့် ရယူပြီး၊ ပြဿနာရှိလျှင် offline သို့
   အလိုအလျောက် ကျသည် (mode badge တွင် မြင်နိုင်သည်)

> ဤအဆင့်တစ်ခုတည်းဖြင့် "စည်းမျဉ်းစည်းကမ်းအခြေခံ" မှ "စိတ်ကြိုက်နားလည်နိုင်သော LLM အဖြေ" သို့
> တက်လှမ်းနိုင်သည် — ပြင်ဆင်စရာ ကုဒ် မလိုပါ။

### အဆင့် ၂ — လုပ်ဆောင်ချက် (tool/action) များ ချဲ့ခြင်း — code development

လက်ရှိ allowlist ၇ ခုကို တိုးချဲ့နိုင်သည် — ဥပမာ:

- ပြဿနာဖြစ်နေသော **job/batch ကို တိုက်ရိုက် ပြန်စ**ခြင်း (ခုနစ်လုံး "retry" ထက် ပိုတိကျ)
- **provider/model ကူးပြောင်း**ရွေးချယ်မှု settings ထဲမှ တိုက်ရိုက် ပြောင်းပေးခြင်း
- တစ်သော့ချင်း cooldown ဖျက်ခြင်း၊ **preflight ပြန်လည်စစ်ဆေး**ပေးခြင်း
- ပျက်သွားသော run ကို အဆင့်မြင့် resume ခလုတ်

**လိုက်နာရန် မဖြစ်မနေ လိုအပ်သော စည်းမျဉ်းများ (invariants):** allowlist + executor + unit test တိုးရဦးမည်,
idempotent ဖြစ်ရမည်, key material ကို မထိရမည်, confirmation မပါဘဲ ဖျက်မသတ်ရန် —
`SafeActionId` type, `actions.ts` executor, `mapActionId` mapping တို့ကို တစ်ပြိုင်နက် ပြင်ရမည်။

### အဆင့် ၃ — နက်ရှိုင်းသော context + proactive (အလိုအလျောက် ကမ်းလှမ်း) — code development

- Context ထဲသို့ **လက်ရှိ project/run metrics** (coverage %, ကျန် line အရေအတွက်, rate, cooldown),
  **preflight ရလဒ်များ**, key health အကျဉ်းချုပ် ထည့်ရန် (`context.ts` တိုးချဲ့)
- `errorMemory` တွင် error ကို ဖမ်းမိသည်နှင့်တစ်ပြိုင်နက် **"ဘာဖြစ်နေတာလဲ ရှင်းပြမလား"** စာပေးပြီး
  ခလုတ်တစ်ခုဖြင့် dialog ဖွင့်နိုင်သော proactive suggestion (auto-explain on failure)
- သုံးစွဲသူ မေးသမျှ **conversation history** ကို session အတွင်း မှတ်ထားနိုင်ရန် (ဆက်မေးနိုင်/နောက်သို့ ပြန်ကြည့်နိုင်)

### အဆင့် ၄ — စာရွက်စာတမ်း RAG + မှတ်ဉာဏ် — larger feature

- `docs/*.md` (ဥပမာ `PDF_TYPES_SUPPORT.md`) နှင့် အထောက်အထားစာရွက်များကို **检索 (retrieve) လုပ်ပြီး
  အခြေခံဖြေနိုင်သော RAG** ချိတ်ဆက်မှု
- Logs table (ရှည်လျားသော မှတ်တမ်း) မှ **ပြန်လည်သင်ယူခြင်း** — မကြာခဏ ဖြစ်သော အမှားများကို
  auto-classify လုပ်ပြီး ကြိုတင်အကြံပေးခြင်း
- မိုဘိုင်း/တွင်း (on-device) model ဖြင့် offline advanced mode (local provider endpoint ပေါင်းထည့်ခြင်း)

**လုံခြုံရေး invariants အားလုံး ဆက်လက်ထိန်းသိမ်းရမည်:** ① LLM key = server ဘက်တွင်သာ
② အထွက်/အဝင် အားလုံး `redact()` ③ action allowlist ၄ offline floor အမြဲရှိရမည်။

---

## ၅။ စမ်းသပ်ထားသော အထောက်အထား (quality gate)

| စမ်းသပ်ချက် | ရလဒ် |
| --- | --- |
| `src/assistant/assistant.test.ts` | စစ်ဆေးရေး **၂၉ ခု အားလုံးအောင်မြင်** (context တည်ဆောက်မှု, rule matching, redaction, action mapping) |
| Smoke suite (browser) | Dialog ဖွင့်နိုင်ခြင်း, offline အဖြေထုတ်နိုင်ခြင်း (စာလုံး ၅၀၀+), safe action ≥၃ ခု ပါဝင်ခြင်း, rate-limit မေးခွန်း ဖြေနိုင်ခြင်း, console error ကင်းခြင်း |
| i18n coverage test | မြန်မာ/အင်္ဂလိပ် ဘာသာစကား ၂ ခုလုံး ပြည့်စုံခြင်း |

---

## ၆။ နည်းပညာ ကိုးကားချက် (file map)

| ဖိုင် | အခန်းကဏ္ဍ |
| --- | --- |
| `src/assistant/types.ts` | Mode ၂ ခု, `SafeActionId`, context/answer contracts |
| `src/assistant/rules.ts` | Offline rule engine — keyword rule ၁၁ ခု + sync code ၈ ခု + reason catalogue |
| `src/assistant/client.ts` | Proxy-first, offline fallback စည်းမျဉ်း; answer validate/cap/map |
| `src/assistant/context.ts` | အလိုအလျောက် context စုစည်းခြင်း + redact |
| `src/assistant/redact.ts` | API key/token/JWT ဖယ်ရှားရေး |
| `src/assistant/errorMemory.ts` | Uncaught error ring (အများဆုံး ၂၀, in-memory) |
| `src/assistant/AssistantBootstrap.tsx` | Global error/rejection capture |
| `src/assistant/AssistantDialog.tsx` | UI — အဖြေပြခြင်း, action နှိပ်လျှင် run + effect (navigate/sync/reload) |
| `src/assistant/actions.ts` | Safe action executor ၇ ခု |
| `src/stores/assistantStore.ts` | Dialog state (open/question/answer/mode/busy) |
| `src/pages/settings/AssistantTab.tsx` | Settings မှ launcher |
| `src/pages/LogsPage.tsx` | မှတ်တမ်းရွေးပြီး ရှင်းပြခိုင်းနိုင်ခြင်း |
| `proxy/server.js`, `proxy/cloudflare-worker.js` | Online tier (OpenRouter key server-side) |
| `src/assistant/assistant.test.ts` | စစ်ဆေးရေး ၂၉ ခု |

---

## ၇။ အကျဉ်းချုပ်

1. **Assistant AI သည် အဓိက "ရှင်းပြပြီး အဆင့်ပြပေးသူ"** ဖြစ်သည် — context ကို အလိုအလျောက်ဖတ်၍
   မြန်မာ/အင်္ဂလိပ်ဖြင့် ရှင်းပြပေးသည်။
2. **တကယ်ပြင်ပေးနိုင်သည်** — ဒါပေမဲ့ လုံခြုံရေးအရ ခွင့်ပြုထားသော safe action ၇ ခု (cooldown ဖျက်ခြင်း,
   batch လျှော့ခြင်း, cache ဖျက်ခြင်း, retry/reload/sync, navigation) အထိသာ — တစ်ခုမှ user နှိပ်မှ
   လုပ်ဆောင်ပေးသည်။ ကျန်သည်များကို ရှင်းပြပြီး လမ်းညွှန်ပေးရုံသာ။
3. **အဆင့်မြင့်တိုးနိုင်သည်** — အဆင့် ၁ (proxy/LLM deploy — ကုဒ်ပြင်စရာမလို) မှ စတင်၍
   action ချဲ့ခြင်း / proactive context / RAG အထိ အဆင့်လိုက် တက်နိုင်သည် —
   လုံခြုံရေး invariants (key = server, redact, allowlist, offline floor) ကို မဖျက်ဘဲ။
