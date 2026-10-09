# Troubleshooting (ပြဿနာဖြေရှင်းခြင်း)

ဤလမ်းညွှန်တွင် အရာတစ်ခုခု မှားယွင်းသောအခါ app က ပြောပြသများအားလုံး ပါဝင်သည် — **Logs** စာမျက်နှာ၊
**reason code** အားလုံး၊ **sync** error codes များ၊ **troubleshooting assistant**၊ စက်များကြား
conflict များနှင့် browser/environment လိုအပ်ချက်များ။

## Logs စာမျက်နှာကို ဘယ်လိုဖတ်ရသလဲ

Sidebar တွင် **Logs** ကို ဖွင့်ပါ။ app ထုတ်ပေးသော state ပြောင်းလဲမှု၊ warning နှင့် error တိုင်းသည်
၎င်းတွင် row တစ်ခုစီအဖြစ် ပေါ်လာပြီး အသစ်ဆုံး အပေါ်တွင် ရှိသည်။

| အစိတ်အပိုင်း | ပြောပြသောအရာ |
| --- | --- |
| **Severity badge** | `Info` / `Success` / `Warning` / `Error` / `Critical`။ စာရင်းအပေါ်ရှိ chips များဖြင့် filter လုပ်ပါ (chip တစ်ခုစီက ၎င်း၏ count ပြသည်) |
| **Timestamp** | ဖြစ်ရပ် ဖြစ်ခဲ့သောအချိန် (စက်၏ local time) |
| **Reason code chip** | Machine-readable code (ဥပမာ `PDF_ENCRYPTED`) — အောက်ရှိ ဇယားများတွင် ရှာဖွေပါ |
| **State tag** | Pipeline ၏ မည်သည့်အပိုင်းက ထုတ်ပေးသည် (`SETTINGS`, `BACKUP`, `TRANSLATE`, FSM states, …) |
| **Message** | သင့် interface ဘာသာစကားဖြင့် ရိုးရှင်းသော စာသား (မြန်မာနှင့် အင်္ဂလိပ် နှစ်မျိုးစလုံးကို ဖြစ်ရပ်တိုင်းတွင် သိမ်းထားသည်) |
| **Technical detail** (ချဲ့နိုင်) | Bug report အတွက် raw detail — HTTP status, exception text, file size, cursors။ ချောက်ကျခြင်းသည် အထူးသဖြင့် တည်နေရာတစ်ခုနှင့် ဆက်စပ်ပါက Page/line indices ပေါ်လာသည် |
| **Suggested fixes** | ထို reason code ၏ `fixActions` များကို chips အဖြစ် render လုပ်ထားသည် |
| **Search box** | Messages များအပေါ် full-text ရှာဖွေမှု |
| **Export JSON** | လက်ရှိ filter ရလဒ်ကို `aidt-logs-<timestamp>.json` (`format: "aidt-logs"`) အဖြစ် download လုပ်သည် |
| **Clear logs** | Local event timeline ကို ဖယ်ရှားသည် (အတည်ပြုချက် တောင်းသည်) |

Tip — `Error` + `Critical` သို့ filter လုပ်ပြီး reason codes များကို မှတ်ထားကာ၊ issue အစီရင်ခံရာတွင် **Export JSON**
ကို အသုံးပြုပါ — ၎င်းတွင် structured event envelope
(`timestamp, state, reasonCode, messageMy, messageEn, technicalDetail, fixActions`) ကို အတိအကျ ပါဝင်သည်။

## Reason codes

ချောက်ကျမှုတိုင်းသည် အောက်ပါ codes များထဲမှ တစ်ခုအဖြစ် ပြေလည်သည်။ Severity — **info** · **success** ·
**warning** · **error** · **critical**။

| Reason code | Severity | ရိုးရှင်းသော အကြောင်းရင်း | အဆင့်ဆင့် ပြင်ဆင်ချက် |
| --- | --- | --- | --- |
| `PDF_ENCRYPTED` | error | PDF သည် စကားဝှက်ဖြင့် ကာကွယ်ထားသဖြင့် ၎င်း၏ အကြောင်းအရာများကို ခွဲခြမ်း၍ မရပါ။ | 1. ဖိုင်တစ်ခုခု ထပ်ဖွင့်ပါ၊ သို့မဟုတ် 2. စကားဝှက် ရယူပြီး PDF-password prompt တွင် ထည့်သွင်းပါ၊ ထို့နောက် စာရွက်စာတမ်းကို ပြန်ဖွင့်ပါ |
| `PDF_CORRUPTED` | error | ဖိုင် ပျက်စီးနေသည် သို့မဟုတ် ဖတ်နိုင်သော PDF မဟုတ်ပါ (parser က ငြင်းပယ်ခဲ့သည်)။ | 1. မူလ application (Word, scan tool, browser “Print → Save as PDF”) မှ PDF ကို ပြန်ထုတ်ပါ၊ 2. ၎င်းမအောင်မြင်ပါက source ပြဿနာဖြစ်ကြောင်း အတည်ပြုရန် ဖိုင်တစ်ခုခု စမ်းကြည့်ပါ |
| `NO_TEXT_LAYER` | warning | စာမျက်နှာသည် ရွေးချယ်နိုင်သော စာသားမရှိသော ပုံ (scan လုပ်ထားခြင်း သို့မဟုတ် ဓာတ်ပုံရိုက်ထားခြင်း) ဖြစ်သဖြင့် ဘာသာပြောင်းစရာ မရှိပါ။ | 1. စာမျက်နှာအတွက် OCR လုပ်ပါ (app က ဤစာမျက်နှာအတွက် ကမ်းလှမ်းသည်)၊ သို့မဟုတ် 2. ပင်မစာသား မပါဝင်ပါက စာမျက်နှာကို ကျော်လွှာပါ |
| `NO_API_KEY` | error | Provider တစ်ခုအတွက်မှ AI API key မထည့်ရသေးပါ။ | 1. Settings → AI Providers ဖွင့်ပါ၊ 2. provider card ထဲတွင် key paste လုပ် → **Add key**၊ 3. **Test key** ပြီး job ကို ပြန်စတင်ပါ |
| `INVALID_KEY` | error | Provider က key ကို ငြင်းပယ်ခဲ့သည် (HTTP 401/403) — မှားရိုက်ထားခြင်း, revoke ဖြစ်ခြင်း သို့မဟုတ် သက်တမ်းကုန်ခြင်း။ | 1. Provider ၏ website ဖွင့်ပြီး key ကို စစ်/လှည့်ပြောင်းပါ၊ 2. Settings → AI Providers တွင် ဟောင်း row ကို ဖျက်ပြီး fresh value ဖြင့် **Add key** လုပ်ပါ၊ 3. ပြောင်းလဲနေသော space မပါဘဲ key အပြည့် paste လုပ်ပါ၊ 4. ပြန်စမ်းမီ **Test key** လုပ်ပါ |
| `ALL_KEYS_COOLING_DOWN` | warning | Rate-limit ဖြေကြောင်းများအပြီး enabled key အားလုံး ယာယီ ရပ်နားထားသည်။ | 1. Translate page တွင် ပြသထားသော cooldown countdown ကို စောင့်ပြီး ပြန်စမ်းပါ၊ 2. pool တွင် အသုံးပြုနိုင်သော key အမြဲရှိစေရန် key (သို့မဟုတ် provider တစ်ခုခု) ထပ်ထည့်ပါ |
| `QUOTA_EXHAUSTED` | warning | Key သို့မဟုတ် model ၏ နေ့/period quota ကုန်သွားပြီ။ | 1. Provider ၏ window reset ဖြစ်ရန် စောင့်ပြီး (countdown က ပြသည်) ပြန်စမ်းပါ၊ 2. ဆက်လက်လုပ်ဆောင်နိုင်ရန် Settings → AI Providers တွင် provider သို့မဟုတ် model ပြောင်းပါ |
| `NETWORK_OFFLINE` | warning | စက်သည် offline ဖြစ်နေသည် (`navigator.onLine` သည် false)၊ ထို့ကြောင့် network work ကို ရပ်ထားသည်။ | 1. ပြန်ချိတ်ပြီး retry နှိပ်ပါ၊ 2. ထိုအတောတွင် offline work (တည်းဖြည့်ခြင်း, ဖတ်ခြင်း, local exports) ဆက်လုပ်ပါ — connection ပြန်ရလျှင် job ပြန်လည်လည်ပတ်သည် |
| `MODEL_UNAVAILABLE` | error | ရွေးထားသော model သည် တည်မနေတော့ပါ သို့မဟုတ် သင့် key ပေါ်တွင် မရနိုင်ပါ (404 / `model_not_found`)။ | 1. Provider card ပေါ်တွင် **Refresh models** နှိပ်ပြီး model တစ်ခုခု ရွေးပါ (**Free tier** + **Recommended for PDF** ကို ဦးစားပေးပါ)၊ 2. job ကို ပြန်စမ်းပါ |
| `BAD_JSON_RESPONSE` | error | AI ဖြေကြားသော်လည်း စာသားကို မျှော်လင့်ထားသော JSON structure အဖြစ် ခွဲခြမ်း၍ မရပါ။ | 1. Request ကို ပြန်စမ်းပါ (model ၏ ယာယီချို့ယွင်းမှုများ မကြာခဏ ဖြစ်လေ့ရှိသည်)၊ 2. context အရွယ်အစား လျှော့ပါ — batch လျှင် နည်းသော line ဘာသာပြောင်း / စာရွက်စာတမ်း ခွဲပါ၊ 3. model တစ်ခုတွင် ထပ်ဖြစ်ပါက model ပြောင်းပါ |
| `OCR_FAILED` | error | OCR engine က စာမျက်နှာကို မဖတ်နိုင်ခဲ့ပါ (worker error သို့မဟုတ် အသိအမှတ်ပြုမှု ကွက်လပ်)။ | 1. OCR ကို ထပ်လုပ်ပါ (ပြန်စမ်းခြင်း မကြာခဏ အောင်မြင်သည်)၊ 2. scan က မဖတ်နိုင်ပါက block ထဲတွင် စာသားကို လက်ဖြင့် ရိုက်ထည့်ပါ၊ 3. စာမျက်နှာပုံ လှည့်မထားခြင်း သို့မဟုတ် အလွန်သေးနေခြင်း မဟုတ်ကြောင်း စစ်ပါ |
| `STORAGE_QUOTA_EXCEEDED` | critical | ဤ site အတွက် browser ၏ IndexedDB quota ပြည့်နေပြီ။ | 1. Settings → Cache → **Clear all caches**၊ 2. မလိုအပ်တော့သော ပရောဂျက်ဟောင်းများ ဖျက်ပါ၊ 3. သိမ်းချင်ပါက အရင် backup export လုပ်ပါ၊ 4. နောက်ဆုံးအနေဖြင့် browser storage (site data) လွတ်ပြီး backup ပြန်သွင်းပါ |
| `EXPORT_FONT_MISSING` | warning | စာရွက်စာတမ်းက အသုံးပြုသော font တစ်ခု ပါဝင်သော registry တွင် မရှိသဖြင့် export layout ရွှေ့ပြောင်းနိုင်သည်။ | 1. Export/font settings တွင် font mapping ဖွင့်ပြီး ရနိုင်သော substitute တစ်ခု ရွေးပါ၊ သို့မဟုတ် 2. ရွှေ့ပြောင်းမှု လက်ခံနိုင်ပါက ထို့အတိုင်း export လုပ်ပါ |
| `SYNC_FAILED` | error | Google Sheet သို့ push လုပ်ခြင်း မအောင်မြင် (non-2xx response သို့မဟုတ် timeout)။ | 1. **Retry sync** နှိပ်ပါ၊ 2. Settings → Data → Cloud sync စစ်ပါ — URL သည် `/exec` ဖြင့် ပြီးသည်၊ token သည် `TOKEN` Script Property နှင့် ကိုက်သည်၊ deployment access သည် *Anyone* ဖြစ်သည်၊ 3. တိကျသော code အတွက် [Sync error codes](#sync-error-codes) ကို ကြည့်ပါ |
| `BACKUP_INVALID` | error | ရွေးထားသော backup ဖိုင်သည် schema/payload validation မအောင်မြင်ပါ။ | 1. ဖိုင်တစ်ခုခု ရွေးပါ (ဤ app မှ export လုပ်ထားသော `aidt-backup` JSON ဖြစ်ရပါမည်)၊ 2. သို့မဟုတ် ဤစက်မှ backup အသစ် export လုပ်ပြီး ဘေးကင်ရာ သိမ်းပါ |
| `INVALID_STATE_TRANSITION` | warning | Workflow အား လက်ရှိ state မှ ခွင့်မပြုသော state သို့ ပြောင်းရန် တောင်းဆိုခံရသည် (ဥပမာ ပယ်ဖျက်ထားသော job ကို ပြန်စတင်ခြင်း)။ | 1. အသိပေးချက်ကို ပိတ်ပါ၊ 2. လုပ်ဆောင်ချက်ကို ၎င်း၏ အစမှ ပြန်စတင်ပါ — state machine က တရားဝင် transitions များကိုသာ လက်ခံသည် |
| `FILE_NOT_PDF` | error | ရွေးထားသော ဖိုင်သည် PDF မဟုတ်ပါ (သို့မဟုတ် `%PDF-` header ကွက်နေသည်)။ | 1. PDF ဖိုင် ရွေးပါ၊ 2. ၎င်းသည် PDF ဖြစ်သင့်ပါက source app မှ PDF အဖြစ် ပြန်ထုတ်ပြီး ထပ်ကြည့်ပါ |
| `FILE_TOO_LARGE` | error | ဖိုင်သည် browser အတွင်း ဘေးကင်စွာ ဆောင်ရွက်ရန် size limit ကျော်လွန်နေသည်။ | 1. PDF ကို အစိတ်အပိုင်းငယ်များ ခွဲပါ (သို့မဟုတ် compress လုပ်) ပြီး တစ်ခုချင်း သွင်းပါ၊ 2. သို့မဟုတ် ပိုသေးသော ဖိုင်တစ်ခု ရွေးပါ |
| `TOO_MANY_PAGES` | error | စာရွက်စာတမ်းတွင် ပံ့ပိုးသော limit ထက် စာမျက်နှာ ပိုများသည်။ | 1. စာရွက်စာတမ်းကို တိုသော ဖိုင်များ ခွဲပါ၊ 2. သို့မဟုတ် စာမျက်နှာ နည်းသော ဖိုင် ရွေးပါ |
| `OCR_LANGUAGE_MISSING` | warning | OCR language pack ကို ဤစက်သို့ မဆွဲယူရသေးပါ (တစ်ကြိမ် network လိုအပ်သည်)။ | 1. Internet ချိတ်ပြီး **Download OCR language** နှိပ်ပါ၊ 2. OCR ထပ်လုပ်ပါ; ထို့နောက် offline အလုပ်လုပ်သည် |
| `PROVIDER_NOT_CONFIGURED` | error | ဘာသာပြောင်းရာ provider/model pair တစ်ခုမှ မရွေးထားပါ။ | 1. Settings → AI Providers ဖွင့်ပါ၊ 2. Provider card ပေါ်တွင် **Model** ရွေးပါ၊ 3. **Use this provider** နှိပ်ပါ၊ 4. Translate page သို့ ပြန်သွားပါ |
| `LANGUAGES_MISSING` | error | Source သို့မဟုတ် target ဘာသာစကား ကွက်နေသည် (သို့မဟုတ် နှစ်ခုလုံး တူညီသည်)။ | 1. Translate page တွင် ဘာသာစကား **နှစ်ခုလုံး** ကို ရှင်းရှင်းလင်းလင်း ရွေးပါ (သို့မဟုတ် auto-detected source ကို အတည်ပြုပါ)၊ 2. wizard က ဟောင်းသော values တွင် ညှပ်နေပါက ပြန်စတင်ပါ |

## Sync error codes

၎င်းတို့သည် Apps Script backend (`apps-script/Code.gs`) နှင့် sync layer မှ လာသည်။ Server က
အမြဲတမ်း HTTP 200 ဖြင့် `{ "ok": false, "code": …, "message": … }` ဖြင့် ဖြေသည်။

| Code | အကြောင်းရင်း | ပြင်ဆင်ချက် |
| --- | --- | --- |
| `UNAUTHORIZED` | App ပို့သော token သည် `TOKEN` Script Property နှင့် မကိုက်ပါ (သို့မဟုတ် property ကွက်နေသည်)။ | Settings → Data → Cloud sync တွင် access token ပြန်ထည့်ပါ; Apps Script → Project Settings တွင် `TOKEN` property ကို စစ်ဆေးပါ; နှစ်ခုလုံးကို ပြန်သိမ်းပါ |
| `BAD_REQUEST` | Malformed payload — `action` ကွက်နေခြင်း, invalid JSON, body 5 MB ကျော်ခြင်း, shape မမှန်သော array fields, သို့မဟုတ် `confirm: "WIPE"` မပါဘဲ `wipe`။ | များသောအားဖြင့် version mismatch — app ကို update လုပ် / `Code.gs` ကို New version အဖြစ် ပြန်deploy လုပ်ပြီး action ကို ပြန်စမ်းပါ |
| `UNKNOWN_ACTION` | Deploy လုပ်ထားသော script က တောင်းဆိုသော action ကို မသိပါ (deployment ဟောင်း)။ | Apps Script → **Deploy → Manage deployments → Edit → New version** ကို လက်ရှိ `Code.gs` ဖြင့် လုပ်ပြီး ပြန်စမ်းပါ |
| `LOCK_TIMEOUT` | အခြား sync session တစ်ခုက script lock ကို ကိုင်ထားသည် (30 s စောင့်ပြီး လက်လျှော့သည်)။ | စက္ကန့်အနည်းငယ် စောင့်ပြီး **Sync now** ထပ်နှိပ်ပါ; စက်အများအပြားဖြင့် တစ်ပြိုင်နက် sync မလုပ်ပါနှင့်; auto-sync interval ကို ရှည်စေပါ |
| `SECRET_NOT_ALLOWED` | Push လုပ်သော Settings record ၏ id/field သည် credential ကဲ့သို့ ပေါ်သည် (`key`, `token`, `secret`, `password`, `authorization`)။ Request အပြည့်အစုံကို ရည်ရွယ်ချက်ရှိရှိ ငြင်းပယ်သည် — `Settings` tab တွင် sync token အပါအဝင် credential ဘယ်တော့မှ မသိမ်းပါ။ | ထို setting ကို local တွင် ဖယ်ရှား သို့မဟုတ် ပြန်မည်ပြောင်းပြီး secret ကဲ့သို့ မပေါ်တော့အောင် လုပ်ပါ; settings ids တွင် ဘယ်တော့မှ credentials မသိမ်းပါ; ပြန် sync လုပ်ပါ။ API key များ မထိခိုက်ပါ — ၎င်းတို့က `ApiKeys` tab ရှိပြီး ခလုတ်သီးသန့် လိုအပ်သည် |
| `NOT_FOUND` | ညွှန်းထားသော project row သည် Sheet ပေါ်တွင် မရှိပါ (အခြားနေရာတွင် wipe သို့မဟုတ် delete လုပ်ထား)။ | Project ပိုင်ရှင် စက်ပေါ်တွင် **Sync now** လုပ်ပြီး ၎င်း ပြန်တင်စေပါ; cloud ကို ရည်ရွယ်ချက်ရှိရှိ wipe လုပ်ထားပါက local project ကို ဖျက်ပါ သို့မဟုတ် ပြန်ဖန်တီးပါ |
| `INTERNAL` | Tab ကွက်ခြင်း, header row ကို လက်ဖြင့် ပြင်ထားခြင်း, unbound spreadsheet (`SPREADSHEET_ID` မပါဘဲ standalone deployment), Google Sheets ဖတ်/ရေး မအောင်မြင် (sync အလယ်တွင် tab ဖျက်ခံရ၊ header row ပြောင်းခံရ၊ spreadsheet ရွှေ့ခံရ သို့မဟုတ် ခွင့်ပြုချက် ပြန်ရုပ်သိမ်းခံရ), Google က script ကို throttle လုပ်ခြင်း (per-user execution quota သို့မဟုတ် concurrent-execution limit ကုန်) သို့မဟုတ် မျှော်လင့်မထားသော script error။ | ပျက်စီးနေသော tab ကို ပြန်ထား/ဖျက်ပြီး script က canonical headers ဖြင့် ၎င်းကို ပြန်ဖန်တီးစေပါ; standalone deployments အတွက် `SPREADSHEET_ID` Script Property သတ်မှတ်ပါ; quota ကန့်သတ်ခံရပါက quota reset ဖြစ်ရန် စောင့်ပါ၊ auto-sync interval ကို ရှည်စေပါ၊ စက်များကို တစ်ချိန်တည်းတွင် နည်းနည်းသာ sync လုပ်ပါ; ချောက်ကျသော action အတွက် **SyncLog** tab ကို စစ်ပါ |

အသေးစိတ်များ, CORS မှတ်ချက်များနှင့် ခလုတ်တစ်ခုချင်းစီ လိုက်လုပ်ရသော setup walkthrough —
`docs/GOOGLE_APPS_SCRIPT_SETUP.md`။

## Troubleshooting assistant

App အတွင်းရှိ assistant (**Settings → Assistant**, နှင့် **Logs** စာမျက်နှာပေါ်ရှိ ခလုတ်) က error များကို
ရိုးရှင်းသော ဘာသာစကားဖြင့် ရှင်းလင်းပြီး logs များ သယ်ဆောင်သည့် အတူတူပင် structured context
(error code, job state, provider/model, နောက်ဆုံးဖြစ်ရပ်များ, browser info) ကို အသုံးပြု၍ fix steps များ
အကြံပြုသည်။ ၎င်းသည် modes နှစ်ခုထဲမှ တစ်ခုတွင် လည်ပတ်သည် -

| Mode | ဘယ်အခါ အသုံးပြုသလဲ | ဘယ်လိုအလုပ်လုပ်သလဲ |
| --- | --- | --- |
| **Proxy mode** | `VITE_ASSISTANT_PROXY_URL` သည် `proxy/` server (`proxy/server.js` သို့မဟုတ် `proxy/cloudflare-worker.js`) ကို ညွှန်ပြသောအခါ | Browser က မေးခွန်း + context ကို `POST /assistant` သို့ ပို့သည်; proxy က OpenRouter ကို ခေါ်ပြီး normalised `{ title, explanation, steps, actions }` အဖြေ ပြန်သည်။ Assistant ၏ OpenRouter key သည် proxy ၏ server-side `.env` အတွင်းတွင် `OPENROUTER_ASSISTANT_KEY` အဖြစ် **သာ** ရှိသည် — frontend bundle ထဲတွင် ဘယ်တော့မှ မရှိပါ။ `proxy/README.md` ကို ကြည့်ပါ |
| **Offline rule-based mode** | Proxy URL မသတ်မှတ်ထားပါက သို့မဟုတ် network မရနိုင်ပါက | ပါဝင်သော rule engine က reason codes နှင့် error patterns ကို network request **တစ်ခုမှ မပြုဘဲ** ရှင်းလင်းချက်များအဖြစ် ပြောင်းသည် |

Proxy က အမြဲတမ်း အတူတူပင် JSON envelope (`{ "ok": false, "code", "message" }`) ဖြင့်
လက်လျှော့သည်။ Assistant ဖြေ၍မရသောအခါ -

| Proxy code | အဓိပ္ပာယ် | ဘာလုပ်ရမလဲ |
| --- | --- | --- |
| `RATE_LIMITED` | သင့် IP မှ 15 မိနစ်လျှင် request 20 ခုထက် ပိုများခြင်း (သို့မဟုတ် OpenRouter ကိုယ်တိုင် rate limit)။ | Window ကုန်ရန် စောင့်ပြီး ထပ်မေးပါ; ထိုအတောတွင် offline mode က ဆက်အလုပ်လုပ်သည် |
| `MISSING_KEY` (HTTP 503) | Proxy တွင် `OPENROUTER_ASSISTANT_KEY` မရှိပါ။ | `proxy/.env` (ကို `proxy/.env.example` မှ) တွင် သတ်မှတ်ပါ, proxy ကို ပြန်စတင်ပါ, `GET /health` → `"hasKey": true` ဖြင့် စစ်ပါ |
| `UPSTREAM_ERROR` (502) / `TIMEOUT` (504) | OpenRouter သို့ ရောက်၍မရ သို့မဟုတ် အလွန်နှေးသည် (20 s limit)။ | နောက်မှ ပြန်စမ်းပါ; proxy ၏ server logs ကို စစ်ပါ; free model ဆိုင်က down ဖြစ်နိုင်သည် — `ASSISTANT_MODEL` ကို အခြား free id သို့ ပြောင်းပါ |
| `BAD_REQUEST` (400/413) | မေးခွန်း ကွက်/အလွန်ရှည် (> 4000 chars) သို့မဟုတ် body 32 KB ကျော်။ | မေးခွန်းကို တိုစေပါ; ပါတဲ့ context ကို လျှော့ပါ |
| `INTERNAL` (500) | မျှော်လင့်မထားသော proxy bug။ | အသေးစိတ်များသည် response တွင်မဟုတ်ဘဲ proxy ၏ stdout တွင် ရှိသည် — server log ကို စစ်ပါ |

အခြားအရာ မအလုပ်လုပ်ပါက ဤစာရွက်စာတမ်း၏ ဇယားများကို တိုက်ရိုက် အသုံးပြုပါ — Logs
စာမျက်နှာတွင် reason code ရှာပြီး အပေါ်ရှိ ၎င်း၏ row ကို ဖတ်ပါ။

## Offline အလုပ်လုပ်ခြင်းနှင့် sync conflict များ

- **Offline သည် ပုံမှန်ဖြစ်သည်။** App သည် local-first — parsing, editing, glossary work နှင့် exports
  အားလုံးကို IndexedDB ပေါ်တွင် လုပ်ဆောင်သည်။ `NETWORK_OFFLINE` က network လိုအပ်သော steps (translation
  requests, OCR language download, cloud sync) ကိုသာ ရပ်စေပြီး ၎င်းတို့ အလိုအလျောက် ပြန်လည်လည်ပတ်သည်။
- **စက်နှစ်ခုက အတူတူ record ကို ပြင်ထားသည်။** စက်နှစ်ခုစလုံး sync လုပ်သောအခါ Settings → Data ရှိ
  **conflict policy** က မည်သည့် copy ရှင်သန်မည်ကို ဆုံးဖြတ်သည် —
  - **Keep local version** — ဤစက် အနိုင်ရသည်၊
  - **Keep cloud version** — Sheet ၏ copy အနိုင်ရသည်၊
  - **Keep newest version** (default) — `updatedAt` နောက်ကျသော record အနိုင်ရသည်; tie ဖြစ်ပါက
    version ဖြင့် ပြီးလျှင် device id ဖြင့် ဆုံးဖြတ်သည် (last-write-wins — server-side rule နှင့် အတူတူပင်)။
- **Conflict များကို local တွင် log လုပ်သည်။** Resolution တိုင်းက ရှုံးသော copy ကို local conflict log
  (`syncConflicts`) တွင် သိမ်းဆည်းပြီး၊ **Settings → Data က conflict count ကို ပြသ**သဖြင့် တစ်ခုခု overwrite
  ခံရကြောင်း သတိထားမိပြီး log သို့မဟုတ် backup export မှ ပြန်နိုင်သည်။
- **Pending changes** များကို Settings → Data card ပေါ်ရှိ badge `N changes waiting to sync` တွင်
  ရေတွက်သည်။ ဘယ်တော့မှ zero မရောက်ပါက အပေါ်ရှိ ဇယားတွင် sync error code ကို စစ်ပါ။

## Browser နှင့် environment

| လိုအပ်ချက် | အသေးစိတ် |
| --- | --- |
| Browser | Evergreen browser မဆိုး — လက်ရှိ Chrome/Edge (Chromium), Firefox, သို့မဟုတ် Safari။ App သည် ES2020+, Web Workers, WebCrypto `subtle`, `fetch` နှင့် CSS custom properties ကို မှီခိုသည် |
| IndexedDB | **လိုအပ်သည်** — Dexie က အရာအားလုံးကို ၎င်းတွင် သိမ်းသည် (projects, settings, sealed keys, logs)။ Private/incognito windows များက ပိတ်ခြင်း သို့မဟုတ် wipe လုပ်နိုင်သည်; အမှန်တကယ်အလုပ်အတွက် ပုံမှန် window အသုံးပြုပါ |
| Web Workers | ပြင်းထန်သော အလုပ်များ (PDF parse, OCR, translation) ကို workers အတွင်း လည်ပတ်သည်; workers ကို ပိတ်သော browser သည် jobs များကို တန့်စေမည် |
| Service worker | ပထမအကြိမ် ဝင်ရောက်ပြီးနောက် app shell ကို `public/sw.js` မှ offline တင်ဆက်သည်။ Update အပြီး UI ဟောင်း/ပျက်နေပါက — DevTools → **Application → Service Workers → Unregister**၊ ထို့နောက် **Application → Storage → Clear site data**၊ ထို့နောက် reload လုပ်ပါ |
| Storage quota | Origin ၏ quota ပြည့်သောအခါ `STORAGE_QUOTA_EXCEEDED` reason code ပေါ်လာသည်။ Settings → Cache → **Clear all caches** ဖြင့်လည်းကောင်း၊ ဟောင်း project များ ဖျက်ခြင်းဖြင့်လည်းကောင်း၊ သို့မဟုတ် browser ၏ site-data settings ဖြင့်လည်းကောင်း နေရာလွတ်ပါ။ Project များ ဖျက်မီ backup export လုပ်ပါ |
| Memory | အလွန်ကြီးမားသော PDFs (ရာနှင့်ချီသော စာမျက်နှာများ, ပုံများစွာ) က tab memory ကုန်စေနိုင်သည်။ စာရွက်စာတမ်းကို ခွဲပါ (`TOO_MANY_PAGES` / `FILE_TOO_LARGE` ကြည့်ပါ) နှင့် မလိုသော tabs များ ပိတ်ပါ |
| Network | AI translation, OCR language pack download (ဘာသာစကားတစ်ခုချင်းစီ တစ်ကြိမ်), model discovery, cloud sync နှင့် assistant proxy အတွက်သာ လိုအပ်သည်; ကျန်အားလုံး offline အလုပ်လုပ်သည် |
| Time & locale | Timestamps များသည် စက်၏ clock ကို သုံးသည်; Sheet backend သည် `Asia/Yangon` တွင် လည်ပတ်သည်။ Clock သည် နာရီအနည်းငယ် လွဲနေပါက “newest version” conflict resolution က မမှန်သောဘက်ကို ရွေးနိုင်သည် — system clock ကို sync ဖြစ်အောင် ထားပါ |

## တစ်ဖက်ကမ်း မမီသေးဘူးလား? Support checklist

Issue အစီရင်ခံမီ အောက်ပါ အချက်လေးခုကို စုဆောင်းပါ -

1. **Logs ကို export လုပ်ပါ** — Logs စာမျက်နှာ → `Error`/`Critical` သို့ filter → **Export JSON** →
   `aidt-logs-<timestamp>.json` ကို ပူးတွဲပါ။
2. **Backup တစ်ခု export လုပ်ပါ** — Settings → Data → **Export backup (JSON)** → ၎င်း၏ အကြောင်းအရာကို
   မျှဝေရန် သင့်လျော်ပါကသာ ဖိုင်ကို ပူးတွဲပါ (သင့် projects, glossary နှင့် settings ပါဝင်သည် —
   သို့သော် plaintext API keys ဘယ်တော့မှ မပါ; ၎င်းတို့သည် sealed အဖြစ် သယ်ဆောင်သည်)။
3. **Browser + OS info** — browser ၏ အမည်နှင့် version, operating system, private window ဖြစ်မမဖြစ်၊
   နှင့် site က local storage ခန့်မှန်းခြေ ဘယ်လောက်သုံးသည် (DevTools → Application → Storage)။
4. **ဘာလုပ်ခဲ့သလဲ** — ပြန်လည်ဖြစ်ပွားစေရန် တိကျသော steps များ၊ ပြသခဲ့သော reason code၊ နှင့် (sync
   ပြဿနာများအတွက်) Apps Script deployment type၊ sync error code နှင့် Sheet ၏ **SyncLog** tab
   မှ နောက်ဆုံး row တစ်ခု။

ထိုအချက်လေးခုရှိလျှင် ပြဿနာအများစုကို အပေါ်ရှိ ဇယားတစ်ခုခု၏ row တစ်ခုတည်းအထိ ခြေရာခံနိုင်သည်။

## ဤ repository အတွင်း အစိတ်အပိုင်းများ ရှိရာနေရာများ

| Path | အခန်းကဏ္ဍ |
| --- | --- |
| `src/core/reasonCodes.ts` | Severity, ဘာသာစကားနှစ်မျိုး messages နှင့် fix actions များဖြင့် reason code တိုင်း |
| `src/pages/LogsPage.tsx` | Logs စာမျက်နှာ — filters, technical detail, JSON export |
| `src/core/eventLogger.ts` | State ပြောင်းလဲမှုတိုင်း ထုတ်ပေးသော event envelope |
| `apps-script/Code.gs` | Sync backend error codes (`UNAUTHORIZED`, `BAD_REQUEST`, `UNKNOWN_ACTION`, `LOCK_TIMEOUT`, `SECRET_NOT_ALLOWED`, `NOT_FOUND`, `INTERNAL`) |
| `proxy/README.md` | Assistant proxy contract နှင့် ၎င်း၏ error envelope |
| `src/i18n/locales/en.json` | Logs, settings နှင့် status messages အတွက် English UI strings |
| `public/sw.js` | Service worker (offline shell) — UI ဟောင်းနေသောအခါ ရှင်းရန် cache |
