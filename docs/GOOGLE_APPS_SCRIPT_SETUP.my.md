# Google Apps Script Cloud Sync ပြင်ဆင်ခြင်း

**AI Documents Translator & Editor** ကို Google Sheet နှင့် ချိတ်ဆက်ပြီး သင့်စီမံကိန်းများကို
ဘရောက်ဇာတစ်ခုမှ နောက်တစ်ခုသို့ လိုက်ပါအသုံးပြုနိုင်အောင် ေညွှန်ပြပါမည်။ စာရေးကျွမ်းကျင်မှု
မလိုအပ်ပါ — နှိပ်ရမည့်ခလုတ်တိုင်းကို အောက်တွင် အဆင့်ဆင့် ဖော်ပြထားပါသည်။

## Sync က ဘာလုပ်ပေးသလဲ

- စက်တိုင်းက သင့်ဒေတာကို သူ့ဘာသူသူ **IndexedDB** (ဘရောက်ဇာအတွင်းရှိ ဒေတာဘေ့စ်) ထဲတွင်
  သိမ်းထားပါသည်။ ဤစက်တွင်းမှတ်တမ်းသည် **အဓိကအမှန်တရ** (source of truth) ဖြစ်ပြီး အက်ပ်က
  အရင်ဖတ်၊ အရင်ရေးပါသည်။
- **Google Sheet** တစ်ခုတည်းက သင့်စက်များကြား ပို့ဆောင်ရေးတံတား (relay) အဖြစ် အသုံးပြုပါ
 သည်။ **Sync now** နှိပ်လျှင် အက်ပ်က စက်တွင်းပြောင်းလဲမှုများကို Sheet ထဲသို့ တင်ပို့ပြီး
  အခြားစက်များက ထားခဲ့သော ပြောင်းလဲမှုများကို ဆွဲယူပါသည်။
- Cloud တွင် အခြားဘာမှ မသိမ်းပါ။ PDF များ၊ ပြသထားသောစာမျက်နှာများ၊ ကက်ရှ်များနှင့် မှတ်တမ်းများ
  က local တွင်သာ ရှိသည်။ **API key များလည်း စက်တွင်းတွင်ပဲ ရှိသည်** — အောက်က
  [Selective sync](#selective-sync-နှင့်-api-keys) တွင် သီးခြား၊ မူလပိတ်ထားသော key sync ကို
  သင်ဖွင့်မှသာ ထွက်ပါမည် — ထိုဖွင့်ထားပါက key များကို ဖတ်နိုင်သော စာသားအဖြစ် Sheet ထဲ
  ရေးသားမှန်း သိထားပါ။
- Backend သည် Google Apps Script ရေးထားသော stateless JSON web app ဖြစ်သည်
  (`apps-script/Code.gs`)။ ဒေတာအားလုံးက Sheet ထဲမှာပဲရှိပြီး script က တောင်းဆိုမှုတစ်ခုနှင့်
  တစ်ခုကြား မည်သည့်အခြေအနေမှ မမှတ်ထားပါ။

```text
 Device A (IndexedDB)  ──push/pull──►  Google Sheet  ◄──push/pull──  Device B (IndexedDB)
        အဓိကအမှန်တရ                (တံတားသာ)                    အဓိကအမှန်တရ
```

## မစတင်မီ လိုအပ်သည်များ

| လိုအပ်ချက် | အကြောင်းအရင်း |
| --- | --- |
| Google account | Sheet နှင့် Apps Script deployment ကို လက်ခံရန် |
| ဤ repo ရှိ `apps-script/Code.gs` ဖိုင် | ထည့်သွင်းမည့် sync backend ကုဒ် |
| ဤ repo ရှိ `apps-script/appsscript.json` ဖိုင် | Script manifest (အချိန်ဇုန်၊ runtime၊ scope) |
| ဘရောက်ဇာတွင် အက်ပ်ဖွင့်ထားခြင်း | Settings → Data → Cloud sync |
| Password generator သို့မဟုတ် OpenSSL | Shared access token ထုတ်ရန် |

## အဆင့် ၁ — Google Sheet အသစ်ဖန်တီးပါ

1. <https://sheets.new> ကို ဖွင့်ပါ (သို့မဟုတ် Google Drive → **New → Google Sheets**)။
2. နောက်ပိုင်းမှတ်မိရန် အမည်ပေးပါ — ဥပမာ `Doc Translator Sync`။
3. Sheet ကို ဗလာထားပါ။ Tab အားလုံးကို script က အလိုအလျောက် ဖန်တီးပေးပါမည်။

## အဆင့် ၂ — Apps Script editor ကို ဖွင့်ပါ

1. Sheet အသစ်တွင် **Extensions → Apps Script** ကို ဖွင့်ပါ။
2. Tab အသစ်တစ်ခု ပွင့်လာပြီး spreadsheet အမည်နှင့်အတူ စီမံကိန်းတစ်ခု ပေါ်လာမည်။ `Code.gs` ဟု
   အမည်ရသောဖိုင်ထဲတွင် `function myFunction() {}` ကဲ့သို့ နမူနာ function တစ်ခု ပါဝင်ပါမည်။

## အဆင့် ၃ — Backend ကုဒ်ကို ထည့်သွင်းပါ

1. `Code.gs` ထဲတွင်းလက်ရှိရှိသည့်အရာအားလုံးကို ဖျက်ပါ။
2. ဤ repository မှ `apps-script/Code.gs` ကို ဖွင့်ပြီး **ဖိုင်အပြည့်** ကူးယူပါ။
3. Editor ထဲတွင် ပဲ့စတူဒီယိုအကြောင်းအရာများကို အစားထိုး၍ ထည့်ပါ။
4. **Ctrl+S** (သို့မဟုတ် 💾 ခလုတ်) ဖြင့် သိမ်းပါ။

> ပထမဆုံးအကြိမ် လုပ်ဆောင်သောအခါ script က tab ရှစ်ခုကို ဖန်တီးပါသည် — **Projects**,
> **Pages**, **Blocks**, **Glossary**, **Settings**, **UsageStats**, **ApiKeys** နှင့် **SyncLog**။ ဒေတာtab
> တိုင်းတွင် `id, updatedAt, deviceId, version, deleted, …` ဟု သတ်မှတ်ထားသော header row ဖြင့်
> စတင်သည်။ ဖျက်သိမ်းမှုများကို tombstone (`deleted = TRUE`) အဖြစ် ရေးသိမ်းသဖြင့် အခြားစက်များသို့
> ကူးစက်ပျံ့နှံ့ပါသည်။

## အဆင့် ၄ — Manifest (`appsscript.json`) သတ်မှတ်ပါ

1. Editor တွင် **View → Show manifest file** ကို ရွေးပါ။ `appsscript.json` ဟု အမည်ရသောဖိုင်
   ဖိုင်စာရင်းတွင် ပေါ်လာပါမည်။ ဖွင့်ပါ။
2. အကြောင်းအရာအားလုံးကို ဖျက်ပြီး `apps-script/appsscript.json` မှ manifest ကို ထည့်ပါ:

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

3. **Ctrl+S** ဖြင့် သိမ်းပါ။ ဤ manifest ၏ အဓိပ္ပာယ်များ —

| Field | တန်ဖိုး | အဓိပ္ပာယ် |
| --- | --- | --- |
| `timeZone` | `Asia/Yangon` | အချိန်နှင့် မှတ်တမ်းများကို မြန်မာအချိန်ဇုန်ဖြင့် ပြသသည် |
| `runtimeVersion` | `V8` | ခေတ်သစ် JavaScript runtime (script အတွက် မဖြစ်မနေလို) |
| `oauthScopes` | `spreadsheets` | Script က spreadsheet တစ်ခုတည်းကိုသာ ထိတွေ့နိုင်သည် — Drive, Gmail, Docs ခွင့်ပြုချက် မရှိပါ |
| `webapp.executeAs` | `USER_DEPLOYING` | သင့်အထောက်အထားဖြင့် လုပ်ဆောင်သည် (“Execute as: Me”) |
| `webapp.access` | `ANYONE_ANONYMOUS` | URL ရှိသူတိုင်း ခေါ်နိုင်သည်; ဒေတာကို token က ကာကွယ်သည် |

## အဆင့် ၅ — Shared token ဖန်တီးပါ (Script Property)

Token သည် **shared secret** ဖြစ်သည် — အက်ပ်က တောင်းဆိုမှုတိုင်းနှင့်အတူ ၄င်းကို ပို့ပြီး script
က စီမံကိန်း၏ Script Properties ထဲတွင် သိမ်းထားသောတန်ဖိုးနှင့် နှိုင်းယှဉ်သည်။ Token မကိုက်လျှင်
တောင်းဆိုမှုအားလုံးကို `UNAUTHORIZED` ဖြင့် ငြင်းပယ်ပါသည်။

1. Apps Script editor တွင် **Project Settings (⚙) → Script Properties → Add property** ကို ဖွင့်ပါ။
2. Key — `TOKEN`
3. Value — random ဖြစ်သော စာလုံးရှည်ရှည် ကျပ်ကျပ်မကျပ်မကျပ် string။ အောက်ပါ
   နည်းလမ်းဖြင့် ထုတ်နိုင်သည် —

```bash
# OpenSSL (Git Bash, WSL, Linux, macOS)
openssl rand -hex 32
```

…သို့မဟုတ် အနည်းဆုံး စာလုံး ၃၂ လုံးပါသော password generator ကို အသုံးပြုပါ။ ရလဒ်သည်
hex/base64 ဆန်းသော ရှည်လျားသော string ဖြစ်ရမည် — စာကြောင်းမဟုတ်ရ၊ သင့် Google
စကားဝှက်မဟုတ်ရ။

4. Property ကို သိမ်းပါ။

**Token ဘေးကင်းရေး စည်းမျဉ်းများ**

- Token ကို ဤ repository ထဲ တစ်ခါမှ မတင်ပါနှင့်၊ git က စောင့်ကြည့်နေသော `.env` ဖိုင်ထဲတွင်
  မူရင်း token တန်ဖိုးကို တစ်ခါမ်မထည့်ပါနှင့် (`.env` ဖိုင်များသည် သတိမမူရသည့် `VITE_`
  တန်ဖိုးများအတွက်သာ ဖြစ်သည်)။
- Token ကို screenshot, issue, စကားပြောစာ, Sheet ထဲ တစ်ခါမှ မထည့်ပါနှင့်။
- အက်ပ်က ၎င်းကို **ဤစက်အတွင်းတွင်သာ AES-GCM ဖြင့် ပိတ်ဆို့၍** သိမ်းပြီးနောက် အကွက်တွင်
  `••••` နှင့် နောက်ဆုံးစာလုံးလေးလုံးသာ ပြသပါတော့သည်။
- နောက်ပိုင်း လှည့်ပြောင်းရန် (rotate) လိုပါက Script Property တွင် `TOKEN` တန်ဖိုးကိုသာ
  ပြောင်းပါ — `Code.gs` ထဲမှာလည်းကောင်း Sheet ထဲမှာလည်းကောင်း ၎င်း တစ်ခါမှ မပါဝင်ပါ။
  ပြီးနောက် အက်ပ်ထဲက token ကို ချက်ချင်း အသစ်လဲပါ၊ မဟုတ်ပါက sync ပျက်ပါမည်။

## အဆင့် ၆ — Web app အဖြစ် deploy လုပ်ပါ

1. Apps Script editor တွင် **Deploy → New deployment** ကို နှိပ်ပါ။
2. Gear အိုင်ကွန်ကို နှိပ်ပြီး **Web app** ကို ရွေးပါ။
3. သတ်မှတ်ပါ —
   - **Description** — `sync v1`
   - **Execute as** — **Me** (သင့် Google account)
   - **Who has access** — **Anyone**
4. **Deploy** ကို နှိပ်ပြီး တောင်းဆိုပါက ခွင့်ပြုပါ (consent screen တွင် အဆင့် ၄ မှ spreadsheets
   scope တစ်ခုတည်း ပါဝင်သည်)။
5. **Web app URL** ကို ကူးယူပါ။ ၎င်းသည် `/exec` ဖြင့် ပြီးရမည် — ဥပမာ —

```text
https://script.google.com/macros/s/AKfycb…/exec
```

> `Code.gs` ကို ပြင်ပြီးတိုင်း **Deploy → Manage deployments → ✏️ edit → Version: New version →
> Deploy** ဖြင့် ပြန် deploy လုပ်ရပါမည်။ ယခင် `/exec` URL ကို ဖွင့်လျှင် အမြဲတမ်း deploy လုပ်
> ပြီးသော version ကိုသာ အလုပ်လုပ်ပြီး editor ထဲက မသိမ်းရသေးသောပြင်ဆင်မှု မပါဝင်ပါ။

## အဆင့် ၇ — အက်ပ်ကို ပြင်ဆင်ပါ

အက်ပ်ထဲတွင် **Settings → Data → Cloud sync** ကို ဖွင့်ပြီး card ကို အပေါ်မှအောက်အထိ ဖြည့်ပါ —

| အကွက် (UI စာသား) | ထည့်ရန် |
| --- | --- |
| **Apps Script URL** | အဆင့် ၆ မှ `/exec` URL |
| **Access token** | အဆင့် ၅ မှ `TOKEN` တန်ဖိုး။ အကွက်က password ကဲ့သို့ ပြုမူပြီး ကွက်လပ်သို့ ပြောင်းသောအခါ (on blur) သိမ်းပါသည်၊ ထို့နောက် `••••1234` သာ ပြတော့သည် |
| **Enable sync** | ဖွင့်ပါ — အင်တာနက်ရှိစဉ် စက်တွင်းပြောင်းလဲမှုများကို တင်ပို့သည် |
| **Auto sync** | အက်ပ်ဖွင့်ထားစဉ် ပုံမှန် sync လုပ်ရန် ဖွင့်ပါ |
| **Interval (minutes)** | Auto-sync ကြာချိန် — ၁ မှ ၁၄၄၀ မိနစ် (မူလ ၁၅) |
| **Conflict policy** | စက်နှစ်ခုလုံးက အတူတူပြင်ထားလျှင် ဘယ်ဘက်က အနိုင်ရမည် — **Keep local version**၊ **Keep cloud version** သို့မဟုတ် **Keep newest version** (မူလ) |

Card အပေါ်တွင် `N changes waiting to sync` ဟု အမှတ်အသားပြ badge ပေါ်နေလျှင် queue ထဲတွင်
ပြင်ဆင်မှုများ စောင့်နေခြင်းဖြစ်သည်။

### ချိတ်ဆက်မှု စမ်းကြည့်ခြင်း (Test connection)

**Test connection** ကို နှိပ်ပါ။ မျှော်လင့်ရသည့်ရလဒ်များ —

| ရလဒ် | အဓိပ္ပာယ် | လုပ်ရန် |
| --- | --- | --- |
| Sheet အမည်များ (`Projects, Pages, Blocks, Glossary, Settings, UsageStats, ApiKeys, SyncLog`) ပါသော အောင်မြင်မှု toast | URL ရောက်ရှိ၊ token လက်ခံခံရ၊ tab အားလုံး ဖန်တီးပြီး | **Sync now** ဆက်လုပ်ပါ |
| `UNAUTHORIZED` | အက်ပ်ထဲက token သည် `TOKEN` Script Property နှင့် မကိုက်ပါ | Token ကို **Access token** ထဲ တိတ်တိတ်ကူးထည့်၊ သိမ်း၊ ပြန်စမ်း |
| `LOCK_TIMEOUT` | အခြား sync session တစ်ခုက script lock ကို ကိုင်ထားသည် | စက္ကန့်အနည်းငယ်စောင့်ပြီး ပြန်စမ်းပါ |
| `BAD_REQUEST` / ကွန်ရက် သို့မဟုတ် CORS အမှား | URL မှား (`/exec` မဟုတ်), deployment access က *Anyone* မဟုတ်၊ သို့မဟုတ် deploy မလုပ်ရသေး | အောက်က [CORS မှတ်ချက်များ](#cors-နှင့်-textplain-posts) ကို ကြည့်ပါ |
| `INTERNAL` — စာတန်းအမည်ပါသော မက်ဆေ့ | Tab တစ်ခု ဖျက်ခံရ သို့မဟုတ် header row ကို လက်ဖြင့် ပြင်ထားသည် | ပျက်စီးနေသော tab ကို ဖျက်ပါ (script က ပြန်ဖန်တီးပေးမည်) သို့မဟုတ် header row ကို ပြန်ထားပြီး ပြန်စမ်းပါ |

### Sync now

**Sync now** ကို နှိပ်ပါ။ အောင်မြင်သော run တစ်ခုက —

1. Queue ထဲရှိ စက်တွင်းပြောင်းလဲမှုအားလုံးကို တင်ပို့သည် (`pushChanges`) — *applied* / *skipped* အဖြစ်
   ရေတွက်ပြသည်။
2. နောက်ဆုံး pull မှ ယခုအချိန်အထိ Sheet ပေါ်တွင် ပြောင်းလဲထားသည်အားလုံးကို ဆွဲယူသည်
   (`pullChanges`) — အခြားစက်များ၏ ဖျက်သိမ်းမှုများအပါအဝင်။
3. အတွက်အရေအတွက်ပါသော အောင်မြင်မှု toast ပြပြီး **SyncLog** tab ထဲသို့ စာကြောင်းတစ်ကြောင်း
   ရေးသွင်းသည် (`timestamp, deviceId, action, rowsIn, rowsOut, status, message`)။

ကြီးမားသောစာတမ်းများက **partial** ရလဒ်ဖြင့် ပြီးနိုင်သည် — Apps Script က run တစ်ခုကို မိနစ် ၆ အကြာတွင်
ရပ်ပြီး `nextCursor` ပြန်ပေးသည်။ အက်ပ်က ထို cursor မှ ဆက်လုပ်သဖြင့် ဘာမှ မဆုံးရှုံးပါ — toast တွင်
ဆက်လုပ်ရန်ကျန်သေးသည် ဖော်ပါက **Sync now** ကို ထပ်နှိပ်ပါ။

## Selective sync (နှင့် API keys)

ခလုတ် ရှစ်ခုက ဘာသွားမလဲကို ဆုံးဖြတ်သည် — **Settings → Data → Cloud sync** တွင် တစ်ခုစီ
ဖွင့်/ပိတ်ပါ —

| Toggle | ဘာ sync ဖြစ်သလဲ | ဘာက စက်တွင်းတွင်သာ ရှိသလဲ |
| --- | --- | --- |
| **projects** | စီမံကိန်းအမည်များ၊ ဘာသာစကားများ၊ အခြေအနေ၊ အချိန်တံဆိပ်များ | — |
| **pages** | စာမျက်နှာ အရွယ်အစားဖွဲ့စည်းပုံနှင့် စာမျက်နှာဆိုင်ရာ metadata | Render cache / ပြကွက်များ |
| **blocks** | စာသား block များ၊ layout၊ စာကြောင်းပုံစံ (JSON ကို `data` column ထဲ) | ပြင်ဆင်မှု ရာဇဝင်များ |
| **glossary** | ဝေါဟာရ စကားလုံးများနှင့် မှတ်စုများ | — |
| **ပေးပို့သူ ဆက်တင်များ** *(မူလ ဖွင့်ထား)* | `ai.` နှင့် စတောင့်သော setting id များ — လက်ရှိ ပေးပို့သူ၊ မော်ဒယ်၊ base URL၊ သွင်းထားသော မော်ဒယ်စာရင်း | `ai.` မဟုတ်သော အားလုံး |
| **အက်ပ် ဆက်တင်များ** *(မူလ ပိတ်ထား)* | theme၊ ဘာသာစကား၊ cache ကန့်သတ်ချက်၊ sync မူဝါဒ … | secret နှင့်တူသော id များ (မပို့မီ ဖယ်ရှား)၊ ပေးပို့သူ ဆက်တင် ပိတ်ထားစဉ် `ai.` id အားလုံး |
| **usage** | အသုံးပြုမှုစာရင်းအင်း counters | Job queue, outbox, event များ |
| **API key များ** *(မူလ ပိတ်ထား)* | အောက်ကအတိုင်း | အောက်တွင် ပိတ်ထားစဉ် အားလုံး |

ပေးပို့သူ ဆက်တင်နှင့် အက်ပ် ဆက်တင်တို့သည် `Settings` tab တစ်ခုတည်းကို သုံးကြသော်လည်း
**ခလုတ် မိမိဘာသာ** လိုက်နာသည် — တစ်ခုကိုဖွင့်လျှင် နောက်တစ်ခုရှိ စာကြောင်းများပါ သွားမလာပါ။

### API key များ — သီးခြား ဖွင့်ရန်၊ ဖတ်နိုင်သော စာသားအဖြစ်

Key များ မူလအားဖြင့် sync **မဖြစ်ပါ**။ **API key များ** ခလုတ်ကို ဖွင့်ပါက Sheet ၏ `ApiKeys`
tab ထဲသို့ key တစ်ခုချင်းစီ၏ **ဖတ်နိုင်သော တန်ဖိုး** ရောက်သွားပါမည်။

၎င်းကို တမင်ရည်ရွယ်၍ ဒီလိုပြုလုပ်ထားခြင်း — Sheet သည် သင့်ကိုယ်ပိုင် ဒေတာဘေ့စ် (သင်ဖန်တီးခဲ့ခြင်း၊
သင့် `TOKEN` ကို သင်ကိုင်ထားခြင်း၊ ဝင်ရောက်ကြည့်ရှုခွင့်ကို သင်ထိန်းချုပ်ခြင်း) ဖြစ်ပြီး၊ တစ်စက်မှ
တစ်စက်သို့ key တိုင်းကို ပြန်ရိုက်ရခြင်းက ဤရွေးချယ်မှု ရှိရခြင်း၏ အကြောင်းရင်းဖြစ်သည်။ ဆိုလိုသည်မှာ
အက်ပ်ထဲတွင် လျှို့ဝှက်ချက် ရွေ့ပြောင်းသည့် တစ်ခုတည်းသော နေရာလည်း ဖြစ်သောကြောင့် စည်းကမ်းများ
တင်းကြပ်ပါသည် —

- **မူလ ပိတ်ထားပြီး ခလုတ်သီးသန့်။** သင်မဖွင့်မက `ဘာမှ` မထွက်ပါ။ ဖွင့်ခါနီး ပန်နယ်တွင်
  spreadsheet ကို ဖတ်နိုင်သူတိုင်း ကိုယ်စားလုယူနိုင်မည်ဟု ရိုးရိုးသားသား ရေးထားသည်။
- **အဓိကအချက်များသာ။** ပေးပို့သူ၊ မှတ်စုအမည်၊ မော်ဒယ်စာရင်း၊ ဖွင့်/ပိတ် flag၊ နောက်ဆုံးလေးလုံး၊
  secret နှင့် ဖန်တီးချိန်။ စက်အလိုက် counter၊ cooldown၊ probe ရလဒ်များ နောက်ကျန်ခဲ့သည် — မဟုတ်ပါက
  တစ်စက်က တစ်စက်၏ counter ကို နှိပ်ဖျက်မည်။
- **နောက်ဆုံးအချိန်မှ ဖွင့်သည်။** sealed payload ကို တောင်းဆိုမှု တည်ဆောက်နေစဉ်တွင်သာ
  ဖွင့်သည် — IndexedDB၊ outbox သို့မဟုတ် မှတ်တမ်းထဲတွင် ဖတ်နိုင်သော secret တစ်ခုမှ မရေး။ delete
  tombstone တွင် payload လုံးဝ မပါ။
- **ရောက်ရာတွင် ပြန် seal လုပ်သည်။** Device B က ဝင်လာသော plaintext ကို ဖွင့်ပြီး ၎င်း၏ ကိုယ်ပိုင်
  key ဖြင့် သိမ်းမီ ပြန် seal လုပ်သည်။ အခြားစက်မှ `cipher` ကို ယုံမထားပါ — ဤနေရာတွင် ၎င်းကို
  ဖွင့်၍မရနိုင်။
- **ပြန်ပြောင်းနိုင်သည်။** ခလုတ် ပိတ်လိုက်လျှင် ရေးသားမှု ရပ်သည်။ Sheet ထဲတွင် ရှိပြီးသား
  အချက်များကို ဖယ်ရှားရန် `ApiKeys` tab ကို ဖျက်ပါ၊ သို့မဟုတ် **Delete cloud data** သုံးပါ။

စနစ်၏ ကျန်အပိုင်းကို ကာကွယ်သည့် အလွှာနှစ်ခု ဆက်လက်ရှိသည် —

1. **Client ဘက်** — credential နှင့်တူသော settings id အားလုံး (`key`၊ `token`၊ `secret`၊
   `password`၊ `authorization`) ကို ဘိုက်တစ်ခုမှ မပိုးမီ ဖယ်ရှားသည် — ခလုတ် ဘယ်လိုပဲ ဖြစ်ဖြစ်။
2. **Server ဘက်** — `Settings` tab ပေါ်ရှိ record တစ်ခုခုက ထိုပုံစံနှင့် ကိုက်လျှင်
   `apps-script/Code.gs` က request အပြည့်အလုံးကို ငြင်းပယ်သည်။ ကာကွယ်မှုက ထို tab အတွက်သာ
   ဖြစ်ပြီး — `ApiKeys` သည် ရည်ရွယ်ချက်ရှိရှိ တစ်ခုတည်းသော ချွင်းချက်ဖြစ်သည်။

### Code.gs အဟောင်း deploy လုပ်ထားပါက

`Code.gs` သည် တစ်ခုမှ မရေးမီ push အပြည့်အလုံးကို အရင်စစ်ဆေးသည် — မသိသော entity တစ်ခုက
batch အပြည့်ကို ဖျက်မည်။ ထို့ကြောင့် အက်ပ်က `ping` ဖြင့် deploy လုပ်ထားသော backend က ဘာတွေ
သိမ်းနိုင်သည်ကို မေးမြန်းပြီး၊ အဖြေရမှသာ key row များကို **ဆိုင်းထား** (queue ထဲတွင် backoff ဖြင့်)။
ကျန် entity များက ထိုအချိန်တစ်လျှောက် ဆက် sync ဖြစ်နေသည်။ ပြန် deploy ပြီးနောက်
**Test connection** နှိပ်လျှင် API key ခလုတ်အောက်ရှိ အသိပေးချက် ပျောက်သွားမည်။

## Cloud data ဖျက်ခြင်း နှင့် local data ဖျက်ခြင်း

လုပ်ဆောင်ချက်နှစ်ခုလုံးက ဒေတာ ဖျက်ပစ်သည်။ ခလုတ်တစ်ခုခု မနှိပ်မီ ကွာခြားချက်ကို ဖတ်ပါ —

| | **Delete cloud data** (Settings → Data → Cloud sync) | **Delete all local data** (Settings → Data → Danger zone) |
| --- | --- | --- |
| ဘာဖယ်ရှားသလဲ | Sheet ၏ Projects / Pages / Blocks / Glossary / Settings / UsageStats / ApiKeys tab အားလုံးရှိ data row အားလုံး | ဤဘရောက်ဇာထဲရှိအားလုံး — စီမံကိန်းများ၊ cache များ၊ settings များ၊ key များ၊ မှတ်တမ်းများ |
| ဘာကျန်ရစ်သလဲ | Header row များ၊ tab ဖွဲ့စည်းပုံနှင့် **SyncLog** audit trail | Cloud ရှိ Sheet က မထိခိုက်ပါ |
| ဘယ်လိုအတည်ပြုသလဲ | `WIPE` ဟု ရိုက်ထည့်မှ အတည်ပြုရသည် | **Delete everything** ဖြင့် အတည်ပြုရသည် |
| ပြန်လည်နိုင်သလဲ? | မနိုင်ပါ — မိတ္တူ အရင်ထုတ်ပါ | မနိုင်ပါ — မိတ္တူ အရင်ထုတ်ပါ |

အကြံပြုချက်များ —

- Google account အသစ်သို့ ပြောင်းမည်ဆိုပါက — ဟောင်းတွင် **Delete cloud data**၊ အသစ်တွင် deploy,
  URL အသစ်ထည့်၊ ထို့နောက် **Sync now**။
- ဤစက်ပေါ်တွင် အစအဦးပြန်စမည်ဆိုပါက — ဖျက်ခင် Settings → Data → Export backup ဖြင့်
  **မိတ္တူ အရင်ထုတ်ပါ**။
- `N changes waiting to sync` သုည မဟုတ်စဉ် “delete local data” ကို ထိုပြောင်းလဲမှုများ
  အခြားနေရာတွင် မရှိသေးဘူးဟု မသေချာသရွေ့ မလုပ်ပါနှင့်။

## Sync ကို စက်နှစ်ခုဖြင့် အသုံးပြုခြင်း

1. စက် B တွင် ဒုတိယဘရောက်ဇာ (သို့မဟုတ် profile) အတွက် အက်ပ်ကို ထည့်သွင့်/ဖွင့်ပါ။
2. **Settings → Data → Cloud sync** သို့ သွားပြီး **အတူတူပင်**သော Apps Script URL နှင့် **အတူတူပင်**
   သော token ကို ထည့်ပြီး sync ဖွင့်ပါ။
3. စက် A တွင် **Sync now**၊ ထို့နောက် စက် B တွင် **Sync now** (သို့မဟုတ် auto-sync စောင့်ပါ)။
   စက် B က အားလုံးဆွဲယူပြီးနောက်၊ နောက်ပိုင်းပြင်ဆင်မှုတိုင်းက sync နှင့် ပေါင်းစည်းသွားသည်။
4. ထိုအချိန်မှစ၍ စက်ဘက်တစ်ခုတွင် ပြင်ပြီး sync လုပ်ပါ — Sheet က ကွာခြားချက်များကို ပို့ဆောင်ပေးသည်။

### Conflict policy — ဘယ်ဘက်က အနိုင်ရမည်လဲ

အော့ဖ်လိုင်းအချိန်၌ စက်နှစ်ခုလုံးက အတူတူ record တစ်ခုကို ပြင်ထားပါက **Settings → Data** တွင်
ရွေးထားသော policy က အနိုင်ရသူကို ဆုံးဖြတ်သည် —

| Policy | အနိုင်ရသူ | ဘယ်အခါသုံးရန |
| --- | --- | --- |
| **Keep local version** (`local`) | ဤစက်ရှိ မိတ္တူ | ဤစက်သည် သင့်အဓိက workstation ဖြစ်လျှင် |
| **Keep cloud version** (`remote`) | Sheet မှ လာသော မိတ္တူ | အခြားစက်က ပိုမိုနောက်ကျသော အလုပ်ပြုထားလျှင် |
| **Keep newest version** (`newest`, မူလ) | `updatedAt` နောက်ကျသော record (အချိန်တူလျှင် version — ထို့နောက် device id ဖြင့် ဆုံးဖြတ်) | မသေချာလျှင် — ပုံမှန်အားဖြင့် အလွယ်ဆုံး |

- Sheet ကိုယ်တိုင်တွင် ရေးသားမှုသည် အမြဲတမ်း `updatedAt → version → deviceId` အစဉ်အလာဖြင့်
  last-write-wins ဖြစ်သဖြင့် တံတားတွင် id တစ်ခုအတွက် row နှစ်ကြောင်း ရှိမနေပါ။
- Conflict တစ်ခုကို ဖြေရှင်းတိုင်း ရှုံးသွားသော မိတ္တူကို စက်တွင်း **conflict log** (`syncConflicts`)
  ထဲတွင် သိမ်းဆည်းသည်။ **Settings → Data** တွင် လက်ရှိ conflict အရေအတွက် ပြသထားသဖြင့်
  တစ်စုံတစ်ခု ဖျက်ခံရသည်ကို သတိပြီး လိုအပ်ပါက ပြန်လည်နိုင်ပါသည်။

## CORS နှင့် `text/plain` posts

ဘရောက်ဇာဘက်က အချက်နှစ်ချက်က “ပို့တောင် မပို့နိုင်” ပြဿနာအများစုကို ရှင်းပြသည် —

1. အက်ပ်က တမင်တကာ **`Content-Type: text/plain`** ဖြင့် JSON body ပို့သည်။
   `application/json` body က CORS `OPTIONS` preflight ကို ဖြစ်စေပြီး Apps Script web app
   များက ၄င်းကို မကိုင်တွယ်နိုင်သဖြင့် request သည် သင့် script ထိ မရောက်မီ ပျက်ပါမည်။
2. Apps Script က `Access-Control-Allow-Origin: *` ကို deployment က *Execute as: Me* နှင့်
   *Who has access: Anyone* ဖြစ်ပါမှသာ ပြန်သည်။ Script ကိုယ်တိုင် response header များ မပြင်
   နိုင်သဖြင့် deployment ဆက်တင်သည် ပြင်ရန်ရှိသည့်အရာ တစ်ခုတည်းဖြစ်သည်။

ဘရောက်ဇာက request ကို ပိတ်ပါက အောက်ပါအစဉ်အလိုက် ပြန်စစ်ပါ —

1. Deployment access = **Anyone** (*Anyone with Google account* မဟုတ်၊ *Only myself* မဟုတ်)။
2. URL သည် **`/exec`** ဖြင့် ပြီးသည် (မဟုတ်ရ `/dev`၊ editor link မဟုတ်)။
3. နောက်ဆုံးကုဒ်ပြင်ပြီးနောက် ပြန်deploy လုပ်ပြီးပြီ (**New version**)။
4. Deploy ပြီးနောက် token ကို တစ်ကြိမ် အတည်ပြုပြီးပြီ (ထို `/exec` URL ကို တိုက်ရိုက်ဖွင့်ကြည့်ပါ —
   JSON စာသားအနည်းငယ် ပြန်ရမည်)။

## ပြဿနာဖြေရှင်းခြင်း

Apps Script web app များက အမြဲတမ်း HTTP 200 ပြန်သည်။ အမှားများက JSON envelope အတွင်းမှ
`{ "ok": false, "code": …, "message": … }` အဖြစ် ရောက်လာသည်။ အက်ပ်က `code` ကို ပြသည် —
အောက်တွင် ရှာပါ —

| Code | ဖြစ်နိုင်ချေ အကြောင်းအရင်း | ဖြေရှင်းနည်း |
| --- | --- | --- |
| `UNAUTHORIZED` | အက်ပ်၏ token သည် `TOKEN` Script Property နှင့် မကိုက်; property ပျောက် သို့မဟုတ် ဗလာ | Settings → Data → Cloud sync တွင် token ကို ပြန်ထည့်ပါ (နောက်ကပ်စာလုံး မပါစေရ); Project Settings တွင် `TOKEN` property ထည့်/ပြင်; စီမံကိန်းပြန်ဖန်တီးထားပါက ပြန်deploy လုပ်ပါ |
| `BAD_REQUEST` | Malformed request — `action` ပျောက်၊ body 5MB ကျော်၊ JSON မမှန်၊ သို့မဟုတ် `wipe` တွင် `confirm: "WIPE"` မပါ | ပုံမှန် app/version မကိုက်သဖြင့် — app အသစ်ပြန်ထည့်; ဆက်လက်ဖြစ်ပါက နောက်ဆုံး `Code.gs` ပြန်deploy; action ကို ပြန်စမ်း |
| `UNKNOWN_ACTION` | Deploy ထားသော script က app ထက်အို (သို့မဟုတ် ဆန့်ကျင်) — action အမည် script ၏ registry ထဲ မရှိ | `apps-script/Code.gs` ကို **New version** အဖြစ် ပြန်deploy လုပ်ပြီး ပြန်စမ်း |
| `LOCK_TIMEOUT` | အခြားစက်/session တစ်ခုက လက်ရှိ sync နေသည် (script lock စက္ကန့် ၃၀ ကျော် ကိုင်ထား)၊ သို့မဟုတ် ယခင် run က မပြီးရသေး | စက္ကန့်အနည်းငယ်စောင့်ပြီး ပြန်စမ်း; စက်အချို့တည်း တစ်ပြိုင်နက် **Sync now** မနှိပ်; auto-sync ကြာချိန် ရှည်အောင်လုပ် |
| `SECRET_NOT_ALLOWED` | id သို့မဟုတ် field အမည် credential နှင့်တူသော **Settings** tab ပေါ်ရှိ record တစ်ခု ပါဝင်သည် | ၎င်းသည် လုံးဝအလုပ်လုပ်နေသော လုံးချင်းကာကွယ်မှု — Settings tab တွင် sync token အပါအဝင် လျှို့ဝှက်ချက် ဘယ်တော့မှ မသိမ်းပါ။ အပြစ်ရှိသော setting ကို စက်တွင်းတွင် ဖယ်ရှား/ပြန်နာမည်ပြောင်း; setting id ထဲ လျှို့ဝှက်ချက် မသိမ်း။ (API key များ မထိခိုက်ပါ — ၎င်းတို့က `ApiKeys` tab ရှိပြီး ခလုတ်သီးသန့် လိုအပ်သည်) |
| `NOT_FOUND` | အက်ပ်က  Sheet ပေါ်မရှိသော project id ကို ရည်ညွှန်းထားသည် (အခြားနေရာတွင် wipe/ဖျက်ထား) | Project ပိုင်ရှင်စက်တွင် **Sync now** လုပ်၍ ပြန်တင်; cloud data ကို တမင် wipe ထားပါက လျစ်လျူရှု သို့မဟုတ် local project ကို ဖျက် |
| `INTERNAL` | Tab ပျောက်၊ header row ကို လက်ဖြင့်ပြင်ထား၊ script က sheet နှင့် မချိတ်ထား (standalone deploy — `SPREADSHEET_ID` မပါ)၊ Google Sheets ဖတ်/ရေး မအောင်မြင် (sync အလယ်တွင် tab ဖျက်ခံရ၊ header row ပြောင်းခံရ၊ spreadsheet ရွှေ့ခံရ သို့မဟုတ် ခွင့်ပြုချက် ပြန်ရုပ်သိမ်းခံရ)၊ Google က script ကို ကန့်သတ် (per-user execution quota သို့မဟုတ် concurrent-execution limit ကုန်)၊ သို့မဟုတ် script error မထင်မှတ်ပါ | ပျက်စီးနေသော tab ကို ဖျက်၍ script ပြန်ဖန်တီးစေ သို့မဟုတ် header row ကို ပြန်ထား; standalone deploy ဆိုပါက `SPREADSHEET_ID` Script Property သတ်မှတ်; quota ကန့်သတ်ခံရပါက quota reset ဖြစ်ရန် စောင့်၊ auto-sync ကြာချိန် ရှည်စေ၊ စက်နည်းနည်းဖြင့် sync; action မအောင်မြင်သည်ကို **SyncLog** တွင် ကြည့် |

အသုံးဝင်နိုင်သေးသည်များ —

- **SyncLog tab** — request တစ်ခုလျှင် row တစ်ကြောင်း၊ `status` (`OK` / `ERROR`) နှင့် တိုတောင်းသော
  message ပါသည်။ `status = ERROR` ဖြင့် filter လုပ်လျှင် action ဘယ်ခု ဘာကြောင့် ကျရှုံးသည်
  တိုက်ရိုက်မြင်ရသည်။
- **အက်ပ်အတွင်း Logs page** (ဘေးဘက်ဆိုင်းဘား → Logs) — `SYNC_FAILED` ကဲ့သို့ reason code များနှင့်
  ပြည်တွင်းလက်တွေ့ပုံ; bug တင်လိုပါက JSON ထုတ်ယူပါ။
- **ကြီးမားသော cell** — Google Sheets က cell တစ်ခုကို စာလုံး ၅၀,၀၀၀ အထိ ခွင့်ပြုသည်; script က
  စာလုံး ၄၅,၀၀၀ ကျော်လွန်သောတန်ဖိုးများကို ဖြတ်တောက်ပြီး truncation ကို request မကျရှုံးစေရန်
  SyncLog ထဲ မှတ်တမ်းတင်သည်။

## Uninstall (ဖြုတ်ချခြင်း)

ချိတ်ဆက်မှုကို အပြည့်အဝ ဖယ်ရှားရန် —

1. **Deployment ရပ်ပါ** — Apps Script → **Deploy → Manage deployments → ⋮ → Delete**။ `/exec`
   URL ချက်ချင်း အဖြေမပေးတော့ပါ။
2. **Token ဖျက်ပါ** — Project Settings → Script Properties → `TOKEN` ကို ဖျက်ပါ၊ ထို့ဖြင့်
   ပေါက်ကြားသွားသော URL ကို နောက်ပိုင်း အသုံးမချနိုင်ပါ။
3. **Sheet ဖျက်ပါ** — `Doc Translator Sync` (သို့မဟုတ် သင်ပေးထားသောအမည်) ကို Google Drive ၏
   အမှိုက်ပုံးထဲ ရွှေ့ပါ။ Sheet ဖျက်လျှင် cloud ဘက်က သင့်ဒေတာ ဖျက်သွားပါမည်။
4. **App ရှင်းပါ** — Settings → Data → Cloud sync တွင် Apps Script URL နှင့် access token
   ကို ရှင်းပြီး **Enable sync** နှင့် **Auto sync** ကို ပိတ်ပါ။ စက်တွင်းစီမံကိန်းများကို ဆက်ထားနိုင်သည် —
  ၎င်းတို့က ဤဘရောက်ဇာထဲတွင်ပဲ ရှိပြီး အော့ဖ်လိုင်း ဆက်အသုံးပြုနိုင်ပါသည်။

## ဤ repository ထဲတွင် အစိတ်အပိုင်းများ ဘယ်မှာရှိသလဲ

| လမ်းကြောင်း | အခန်းကဏ္ဍ |
| --- | --- |
| `apps-script/Code.gs` | Backend — action များ (`ping`၊ `pushChanges`၊ `pullChanges`၊ `listProjects`၊ `getProject`၊ `upsertBlocks`၊ `deleteProject`၊ `backup`၊ `wipe`)၊ sheet layout၊ error code များ၊ locking |
| `apps-script/appsscript.json` | Manifest — Asia/Yangon, V8 runtime, spreadsheets-only scope, web-app access |
| `src/pages/settings/DataTab.tsx` | Settings → Data UI (URL၊ ပိတ်ဆို့ထားသော token၊ switch များ၊ conflict policy၊ danger zone) |
| `src/i18n/locales/en.json` | `settings.data` အောက်ရှိ sync UI စာသားများ |
