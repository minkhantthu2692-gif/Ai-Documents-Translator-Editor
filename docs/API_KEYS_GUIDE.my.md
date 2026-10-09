# API Keys လမ်းညွှန်

**AI Documents Translator & Editor** သည် BYOK — *Bring Your Own Key* (မိမိ key ကိုယ်တိုင်ယူသုံး) စနစ်ဖြစ်ပါသည်။ AI
provider key တစ်ခုကို တစ်ခါတည်း paste လုပ်လိုက်ပါ; ၄င်းကို မိမိစက်အတွင်းတွင် seal လုပ်သိမ်းထားပြီး
မိမိ ဘာသာပြန်မှုများအတွက်သာ အသုံးပြုပါသည်။ ဤလမ်းညွှန်တွင် key ဘယ်မှာရနိုင်သလဲ၊ app က key ကို
ဘယ်လိုသိမ်းဆည်းသလဲ၊ key pool က key များကြား ဘယ်လို လှည့်ပြောင်းသလဲ၊ နှင့် အများဆုံး ဖြစ်လေ့ရှိသော
အမှားများကို ဘယ်လိုဖြေရှင်းသလဲ တို့ကို ရှင်းလင်းစွာ ဖော်ပြထားပါသည်။

## ပံ့ပိုးထားသော providers များ

| Provider | Official key စာမျက်နှာ | Free tier မှတ်ချက် (Settings → AI Providers တွင် ပြသသလို) |
| --- | --- | --- |
| Google Gemini | <https://aistudio.google.com/apikey> | Google AI Studio မှ free tier (တစ်မိနစ်/တစ်နေ့ quota များ)။ |
| OpenRouter | <https://openrouter.ai/keys> | `:free` routes မှတစ်ဆင့် free tier — provider ၏ rate limit ဖြင့်။ |
| Groq | <https://console.groq.com/keys> | တစ်မိနစ်/တစ်နေ့ ကြီးမားသော ကန့်သတ်ချက်များဖြင့် free tier။ |
| OpenAI-compatible | <https://platform.openai.com/api-keys> | မိမိ endpoint ကိုယ်တိုင်ယူသုံး — quota သည် ချိတ်ဆက်ထားသော server ပေါ်တွင် မူတည်သည်။ |

မှတ်ချက်များ -

- **Settings → AI Providers** ရှိ provider card တိုင်းတွင် **Get API Key** (official console ကို ဖွင့်ပေးသည်) နှင့်
  **Documentation** ခလုတ်များ ရှိသည် — ရှာဖွေစရာ မလိုဘဲ ၄င်းတို့ကို အသုံးပြုပါ။
- **OpenAI-compatible** provider သည် custom **Base URL** ကို လက်ခံသဖြင့် local server
  (Ollama, LM Studio, llama.cpp) သို့မဟုတ် မိမိ proxy ကိုယ်တိုင်ဖြင့် ပေးချေမှု plan မလိုဘဲ models များကို
  တင်ဆက်နိုင်သည်။
- ပါဝင်သော model စာရင်းတွင် free models များကို **Free tier** badge ဖြင့်လည်းကောင်း၊ PDF နှင့် သင့်လျော်သော
  models များကို **Recommended for PDF** ဖြင့်လည်းကောင်း မှတ်သားထားသည်။ **Refresh models** သည် provider ထံမှ
  လက်ရှိစာရင်းကို တောင်းယူသည်; **Verify availability** သည် ပါဝင်သော fallback list မှ လာသော id များကို မှတ်ပေးပြီး
  ၎င်းတို့ကို upstream တွင် ပြန်မည် အမည်ပြောင်းထားနိုင်သည်။

## Key ဘယ်မှာရနိုင်သလဲ (official links)

1. **Gemini** — <https://aistudio.google.com/apikey> → sign in → **Create API key**။
2. **OpenRouter** — <https://openrouter.ai/keys> → **+ Create Key**။ Free models များသည် `:free` ဖြင့် ပြီးသည်။
3. **Groq** — <https://console.groq.com/keys> → **Create API Key**။
4. **OpenAI** — <https://platform.openai.com/api-keys> → **Create new secret key** (OpenAI ၏
   ပေးချေရန် API ကိုသာ ချိတ်ဆက်ပါက လိုအပ်သည် — မိမိ endpoint မဟုတ်ပါက)။

key အပြည့်အစုံကို တစ်ခါတည်း copy လုပ်ပါ။ providers အများစုသည် ၎င်းကို တစ်ခါတည်းသာ ပြသသည်။

## Key များကို ဘယ်လိုသိမ်းဆည်းသလဲ

| ဂုဏ်သတ္တိ | အပြုအမူ |
| --- | --- |
| Encryption | WebCrypto **AES-GCM** (256-bit)၊ **PBKDF2-SHA256** ဖြင့် ဆင့်ကဲဆွဲယူခြင်း၊ 150,000 iterations၊ seal တိုင်းအတွက် fresh random salt နှင့် 96-bit IV (`src/core/crypto.ts`) |
| Storage | ဤစက်ပေါ်ရှိ **IndexedDB** အတွင်းရှိ sealed ciphertext (`apiKeys` table, Dexie) — plaintext အဖြစ် `localStorage` တွင် ဘယ်တော့မှ မသိမ်း၊ အောက်က sync ခလုတ် မဖွင့်မက server ပေါ်တွင် မရောက်ပါ |
| Optional vault passphrase | **Settings → AI Providers → Vault passphrase** တွင် passphrase ထည့်နိုင်သည်။ ၎င်းဖြင့် key များကို passphrase ဖြင့် seal လုပ်ပြီး ဤ session အတွက်သာ memory တွင် ထားရှိသည်; ကွက်လပ်ထားပါက key များသည် device နှင့်သာ ချိတ်ဆက်သည် |
| Display | UI သည် masked form `••••1234` (နောက်ဆုံး စာလုံးလေးလုံး) ကိုသာ ပြသသည် |
| Logs | plaintext သည် log line တစ်ခုအထိ ဘယ်တော့မှ မရောက်; provider adapters များက error message တိုင်းမှ key ကို ပြသမီ redact လုပ်သည် |
| Cloud sync | **မူလ ပိတ်ထားပြီး ခလုတ်သီးသန့်။** **Settings → Data → Cloud sync → API key များ** ကို မဖွင့်မက စက်မှ ဘာမှ မထွက်ပါ — secret နှင့်တူသော setting id များကို client-side တွင် filter လုပ်ပြီး၊ sync backend က ၎င်းတို့ကို `SECRET_NOT_ALLOWED` ဖြင့် ငြင်းပယ်သည်။ ခလုတ်ဖွင့်ပါက key တစ်ခုချင်းစီ၏ **ဖတ်နိုင်သော တန်ဖိုး** ကို သင့် Sheet ၏ `ApiKeys` tab ထဲ ရေးသည် — ၎င်းသည် တမင်သက်သက် ကိုယ်ရေးကိုယ်တာ ရွေးချယ်မှု (Sheet က သင့်ပိုင်) ဖြစ်ပြီး၊ မလုပ်မီ ပန်နယ်တွင် ရှင်းလင်းစွာ ဖော်ပြထားသည်။ [SECURITY.md](SECURITY.md#plaintext-key-sync-opt-in-and-reversible) ကို ကြည့်ပါ |
| `.env` / bundle | ဘယ်တော့မှ မပါဝင်ပါ။ non-sensitive `VITE_` values များသာ browser bundle အတွင်း compile လုပ်သည် (အောက်ရှိ [Warning](#warning-vite_-env-vars-ကို-public-ဖြစ်သည်) ကို ကြည့်ပါ) |

main thread တွင် secret တစ်ခုမှ မရှိပါ — ဘာသာပြန်မှု run များသည် translation Web Worker အတွင်း၌သာ sealed
records များကို ဖွင့်ပြီး၊ request တစ်ခု လည်ပတ်နေစဉ်သာ plaintext ကို ဖတ်သည်။

## Key များ ထည့်ခြင်း၊ စမ်းခြင်းနှင့် ဖွင့်ခြင်း

၎င်းအားလုံးကို **Settings → AI Providers** တွင် လုပ်ဆောင်သည် -

1. **(ရွေးချယ်နိုင်) Vault passphrase** — passphrase ထည့်ပြီး **Apply passphrase** ကို နှိပ်ပါ (ဤစက်ထက်
   ကျော်လွန်၍ key များကို ကာကွယ်ရန်)၊ သို့မဟုတ် device-bound key များအတွက် ကွက်လပ်ထားပါ။ **Forget
   passphrase** သည် ၎င်းကို ဤ session အတွက် memory မှ ဖယ်ရှားသည်။
2. **Add key** — provider card ကို ရွေးပြီး key ကို *Paste API key* တွင် paste လုပ်ပါ (8 စာလုံးထက် တိုသော
   values များကို အလျားနည်းလွန်းသဖြင့် ငြင်းပယ်သည်)၊ ရွေးချယ်နိုင်သော **Nickname** ဥပမာ `phone-plan`
   သို့မဟုတ် `work` ပေးပြီး **Add key** ကို နှိပ်ပါ။ Toast: *API key added*။
3. **Test key** — provider ထံသို့ စျေးနည်းသော request တစ်ခု ပို့သည်။ ရလဒ် line တွင်
   `kind · latency ms` ပြသသည် (ဥပမာ `ok · 412 ms`)။ ပြတ်သားသော အဖြေတစ်ခုသာ status ကို ပြောင်းသည် —
   network အနည်းငယ် ချို့ယွင်းခြင်းက ကောင်းမွန်သော key ကို မပယ်ဖျက်ပါ။
4. **Enabled switch** — key ကို မဖျက်ဘဲ ပိတ်နိုင်သည် (ဥပမာ လက်စွဲ run များအတွက် key တစ်ခု သီးသန့် ချန်ရန်)။
5. **Use this provider** — card ၏ activation ခလုတ်က provider ကို ဘာသာပြန်ရာတွင် active provider အဖြစ်
   သတ်မှတ်ပေးသည်; toast: *… is now the active provider*။
6. **Usage counters** — row တိုင်းတွင် `N requests · X in / Y out tokens` ပြသပြီး၊ pool က key သုံးသည်နှင့်
   အသစ်ပြောင်းသည်။ cooldown countdown ကို *Cooling down until 14:03:22* အဖြစ် ပြသသည်။

### Health badges

| Badge | အဓိပ္ပာယ် | Pool ၏ လုပ်ဆောင်ချက် |
| --- | --- | --- |
| **Healthy** | နောက်ဆုံး test/request အောင်မြင်၊ cooldown မရှိ | request အားလုံးအတွက် ရွေးချယ်နိုင် |
| **Cooling down** | Rate-limited (HTTP 429) သို့မဟုတ် ယာယီ server error | cooldown deadline အထိ ကျော်သွားသည်; exponential backoff (base 2 s, cap 5 min) ±25 % jitter ဖြင့်၊ သို့မဟုတ် provider ၏ `Retry-After` ပိုကြာပါက ၎င်းကို လိုက်နာ |
| **Quota exhausted** | နေ့/period quota ကုန်သွား | window reset ဖြစ်သည်အထိ ကျော်သွားသည် (provider က reset time မပေးပါက default cooldown 60 မိနစ်) |
| **Invalid** | Provider က 401/403 ဖြင့် ဖြေသည် | key ကို ပြင်သို့မဟုတ် အစားထိုးမချင်း အမြဲတမ်း ဖယ်ထား |
| **Not tested** | အသစ်ထည့်ထား၊ ဘယ်တော့မှ မခေါ်ဖူး | healthy key ကဲ့သို့ အသုံးပြုသည် |
| **Disabled** | သင့် switch က ပိတ်ထား | ဘယ်တော့မှ မရွေး |

### Pool က နောက် key ကို ဘယ်လိုရွေးသလဲ

- **Rotation strategy** (Translate page → *Key rotation*): **Round robin** သည် အသုံးပြုနိုင်သော key များကို
  အစဉ်လိုက် လှည့်ပတ်သည်; **Least used** သည် တောင်းဆိုမှု အနည်းဆုံးရှိသော key ကို ဦးစားပေးသည်။
- request တိုင်းမတိုင်မီ pool က key တစ်ခုချင်းစီအတွက် fixed-window token bucket သုံးခုကို စစ်ဆေးသည် — **RPM**
  (requests/min), **TPM** (tokens/min) နှင့် **RPD** (requests/day)၊ model ကို သိရှိသော ceilings
  (defaults: 30 rpm / 100,000 tpm / 1,000 rpd) ဖြင့်။ Provider ထံမှ live `RateLimit-*` headers များသည်
  အမြဲတမ်း ခန့်မှန်းချက်များထက် ကြွယ်ဝသည်။
- **429** တွင် လက်ရှိ key သည် cooldown ဝင်ပြီး pool က ချက်ချင်း **နောက် အသုံးပြုနိုင်သော key ကို ရွေးသည်** —
  ထို့ကြောင့် ဘာသာပြန်မှု run သည် ရပ်တန့်မသွားဘဲ ဆက်လက်လည်ပတ်သည်။ run ရပ်သွားပါက UI တွင် countdown
  ဖြင့် *Every key is cooling down — waiting for the first one* ပြသသည်။
- **အားလုံး** သော key များ အသုံးမပြုနိုင်တော့သောအခါ run သည် reason code ဖြင့် ရပ်သည် —
  `ALL_KEYS_COOLING_DOWN`, `QUOTA_EXHAUSTED`, `INVALID_KEY` သို့မဟုတ် `NO_API_KEY`။
- Cooldowns, counters နှင့် bucket အနေအထားများကို IndexedDB တွင် သိမ်းဆည်းထားသဖြင့် run အလယ်တွင်
  page refresh လုပ်ပါက ထိုအခြေအနေအတိုင်း ပြန်စတင်ပြီး provider ကို ထပ်မံ ဝါးရုံသိုက် မတိုးပွားစေပါ။

## Warning: `VITE_` env vars များသည် public ဖြစ်သည်

`VITE_` စသော အရာတိုင်းသည် **build အချိန်တွင် JavaScript bundle အတွင်း inline ထည့်သွင်း** ပြီး
သင့် site ၏ source ကို ဖွင့်ကြည့်သူ ဘယ်သူမဆို ဖတ်နိုင်သည်။ ၎င်းက အောက်ပါအတိုင်း သက်ရောက်သည် -

| Variable | ရည်ရွယ်ချက် | ဖော်ပြရန် ဘေးကင်းသလား? |
| --- | --- | --- |
| `VITE_APPS_SCRIPT_URL` | Sync endpoint (`/exec` URL) | ဟုတ်ကဲ့ — သို့သော် မှတ်ချက်ကို ကြည့်ပါ |
| `VITE_APPS_SCRIPT_TOKEN` | Shared sync token | **တစ်ဦးတည်းသော, private** deployment အတွက်သာ; သင့် bundle ကို ဖွင့်နိုင်သူ ဘယ်သူမဆို သင့် Sheet သို့ sync လုပ်နိုင်သည်။ Provider API key ဘယ်တော့မှ မဟုတ်ပါ |
| `VITE_ASSISTANT_PROXY_URL` | Troubleshooting-assistant proxy (`proxy/`) | ဟုတ်ကဲ့ — ၎င်းက URL တစ်ခုသာ ဖြစ်သည် |
| `VITE_APP_NAME`, `VITE_APP_VERSION`, `VITE_ENABLE_ANALYTICS` | Display/build flags | ဟုတ်ကဲ့ |

**စည်းမျဉ်းများ -**

- Gemini/OpenRouter/Groq/OpenAI API key ကို `VITE_` variable တစ်ခုအတွင်း **ဘယ်တော့မှ** မထည့်ပါ — build တိုင်းနှင့်
  အတူ ထုတ်ဝေခံရပါမည်။
- Assistant ၏ OpenRouter key သည် proxy ၏ server-side `.env` အတွင်းတွင် `OPENROUTER_ASSISTANT_KEY`
  အဖြစ် **သာ** ရှိသည် (`proxy/README.md` ကို ကြည့်ပါ); ၎င်းသည် ဘယ်တော့မှ `VITE_` prefix မပါဘဲ commit
  လည်း မလုပ်ပါ။
- Sync token ၏ ပုံမှန်နေရာမှာ Google ဘက်ခြမ်းရှိ Script Property နှင့် သင့်စက်ပေါ်ရှိ Settings → Data ရှိ sealed field
  ဖြစ်သည်။ သင်တစ်ဦးတည်း ဤ app ကို run နှင့် build လုပ်ပါက `.env` copy ကိုသာ လက်ခံနိုင်သော်လည်း၊
  ၎င်းသည် အမြဲတမ်း real provider key မဖြစ်ရပါ။
- `.env` files များကို gitignore လုပ်ထားသည်; `.env.example` templates များသာ commit လုပ်နိုင်ပြီး
  ၎င်းတို့တွင် real values မပါရပါ။

## ပေါက်ကြားသွားနိုင်သော key ကို rotation လုပ်ခြင်း

key တစ်ခု ပေါက်ကြားနိုင်သည်ဟု သံသယရှိပါက (screen မျှဝေခြင်း, commit လုပ်ထားသော file, ခိုးယူခံရသော laptop) -

1. **App အတွင်း:** Settings → AI Providers → key row → trash icon (*API key removed*)။ key ကို
   မယုံကြည်တော့သော vault passphrase ဖြင့် seal လုပ်ထားပါက **Forget passphrase** ကိုလည်း လုပ်ပြီး
   စက်ကိုယ်တိုင် ခိုးယူခံရပါက local data ကိုပါ ရှင်းလင်းပါ။
2. **Provider console အတွင်း:** key ကို ဖျက်/ပြန်ဖန်တီးပြီး ဟောင်းသော value ချက်ချင်း မအလုပ်ရအောင် လုပ်ပါ
   (Gemini: *Delete key*; OpenRouter: *Delete*; Groq: *Delete*; OpenAI: *Roll key*)။
3. **အသစ် key ကို** ထို provider card အတွင်း ထည့်ပြီး run မစတင်မီ **Test key** လုပ်ပါ။

## Rate-limit ဖြန့်ရန် အများကြီးသော key များ

- provider တစ်ခုအတွက် key အများအပြား ထည့်ပြီး (တစ်ခုချင်းစီတွင် ၎င်း၏ nickname) **Enabled** ဖြစ်အောင် ထားပါ။
- request များကို ညီမျှဖြန့်ရန် **Round robin** ကို ရွေးပါ، သို့မဟုတ် အရေအတွက်ဖြင့် မျှတစေရန် **Least used** ကို
  ရွေးပါ။
- *မတူညီ*သော provider ထံမှ key အနည်းဆုံးတစ်ခုကိုလည်း ချိတ်ဆက်ထားပါ —
  `QUOTA_EXHAUSTED` တွင် **Switch provider** (Settings → AI Providers → *Use this provider*) ဖြင့်
  ပထမ provider ၏ နေ့လယ်စာ window reset ဖြစ်နေစဉ် နေရာတူ၌ run ကို ဆက်လက် လည်ပတ်နိုင်သည်။
- Key တစ်ခုချင်းစီ counters များက မည်သည့် key များက တကယ့် traffic ကို သယ်ဆောင်သည်ကို ပြသည်;
  မသယ်ဆောင်သော အပိုင်းများကို ပိတ်ပါ သို့မဟုတ် ဖျက်ပါ။

## Troubleshooting

| Reason code | သင်မြင်ရသည် | အကြောင်းရင်း | ပြင်ဆင်ချက် |
| --- | --- | --- | --- |
| `NO_API_KEY` | *No AI API key has been added yet.* | Active provider တွင် key row မရှိ | 1. Settings → AI Providers → provider card။ 2. Key paste လုပ် → **Add key**။ 3. **Test key** ပြီး ပြန်စမ်းပါ |
| `INVALID_KEY` | *The AI key is invalid or was rejected by the provider.* | Provider က HTTP 401/403 ဖြင့် ဖြေ — key မှားရိုက်ထားခြင်း, revoke ဖြစ်ခြင်း သို့မဟုတ် သက်တမ်းကုန်ခြင်း | 1. အတည်ပြုရန် **Test key**။ 2. Provider site ဖွင့် (**Check key**) ပြီး fresh key ကို copy လုပ်ပါ။ 3. Row ကို အစားထိုးပါ — ဟောင်းကို ဖျက်၊ အသစ်ကို ထည့်။ 4. ရှေ့/နောက် space များကို သတိထားပါ — key အပြည့်ကို paste လုပ်ပါ |
| `QUOTA_EXHAUSTED` | *The AI quota or rate limit has been exhausted.* | Key သို့မဟုတ် model ၏ နေ့/period quota ကုန်သွား | 1. Provider window reset ဖြစ်ရန် စောင့်ပါ (cooldown countdown အချိန်ပြသည်)။ 2. Fresh free tier ရှိ **Switch provider** သို့မဟုတ် model လုပ်ပါ။ 3. ဆက်လုပ်ရန် ထို provider ပေါ်တွင် key ဒုတိယတစ်ခု ထည့်ပါ |
| `ALL_KEYS_COOLING_DOWN` | *All keys are cooling down — wait a moment and retry.* | Enabled key အားလုံး cooldown အတွင်းရှိနေသည် သို့မဟုတ် ၎င်း၏ RPM/RPD bucket ပြည့်နေသည် | 1. Countdown (Translate page တွင် ပြသ) ကို စောင့်ပါ။ 2. **Add another key**။ 3. Load ဖြန့်ပါ — batch size လျှော့ပါ သို့မဟုတ် *Least used* rotation သို့ ပြောင်းပါ |
| `MODEL_UNAVAILABLE` | *The selected model is unavailable.* | Model id ကို upstream တွင် ဖျက်/ပြန်မည်ပြောင်းထား (HTTP 404 / `model_not_found`) | 1. Provider card တွင် **Refresh models**။ 2. **Choose another model** — **Free tier** + **Recommended for PDF** entry ကို ဦးစားပေးပါ။ 3. ပြန်စမ်းပါ; id တစ်ခု 404 ပြန်ပါက bundled fallback chains က အလိုအလျောက် အဆင့်ဆင့် ကျသွားသည် |
| `PROVIDER_NOT_CONFIGURED` | *No translation provider or model has been selected.* | `ai.provider` / `ai.model` settings များ ကွက်နေသည် | 1. Settings → AI Providers။ 2. Provider card ဖွင့်ပြီး **Model** တစ်ခု ရွေးပါ။ 3. **Use this provider** ကို နှိပ်ပါ။ 4. Translate page သို့ ပြန်သွားပါ |

Test သို့မဟုတ် request တစ်ခု **network** kind error ဖြင့် ကျရှုံးပါက အခြေအနေကို အရင်စစ်ပါ — offline ကြောင့်
ဖြစ်သော provider error များကို `NETWORK_OFFLINE` အဖြစ် အစားထိုး အစီရင်ခံပြီး၊ online ပြန်ဝင်လာသောအခါ job
ကို အလိုအလျောက် ပြန်လည်လည်ပတ်သည်။

## ဤ repository အတွင်း အစိတ်အပိုင်းများ ရှိရာနေရာများ

| Path | အခန်းကဏ္ဍ |
| --- | --- |
| `src/pages/settings/ProvidersTab.tsx` | Settings → AI Providers UI — vault, provider cards, key rows, tests |
| `src/translate/keyPool.ts` | Rotation, token buckets, cooldown/backoff, health snapshots |
| `src/core/crypto.ts` | AES-GCM sealing + PBKDF2 key derivation |
| `src/db/repo-apiKeys.ts` | IndexedDB အတွင်း sealed key storage |
| `src/providers/` | Gemini, OpenRouter, Groq နှင့် OpenAI-compatible adapters |
| `src/config/models.config.ts` | Provider metadata, bundled models, free-tier limits, fallback chains |
| `src/core/reasonCodes.ts` | Troubleshooting ဇယားတွင် ဖော်ပြထားသော reason codes |
| `proxy/README.md` | Assistant proxy — `OPENROUTER_ASSISTANT_KEY` ရှိနိုင်သောနေရာ |
