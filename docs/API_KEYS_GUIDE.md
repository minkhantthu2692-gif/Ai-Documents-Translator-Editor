# API Keys Guide

**AI Documents Translator & Editor** is BYOK — *Bring Your Own Key*. You paste your own AI
provider key once; it is sealed on your device and used only for your translations. This guide
explains where to get a key, how the app stores it, how the key pool rotates between keys, and
how to fix the common errors.

## Supported providers

| Provider | Official key page | Free-tier note (as shown in Settings → AI Providers) |
| --- | --- | --- |
| Google Gemini | <https://aistudio.google.com/apikey> | Free tier via Google AI Studio (per-minute and per-day quotas). |
| OpenRouter | <https://openrouter.ai/keys> | Free tier through `:free` routes, rate limited by the provider. |
| Groq | <https://console.groq.com/keys> | Free tier with generous per-minute and per-day limits. |
| OpenAI-compatible | <https://platform.openai.com/api-keys> | Bring your own endpoint — the quota depends on the server you configure. |

Notes:

- Every provider card in **Settings → AI Providers** has **Get API Key** (opens the official
  console) and **Documentation** buttons — use them instead of searching.
- The **OpenAI-compatible** provider accepts a custom **Base URL**, so a local server
  (Ollama, LM Studio, llama.cpp) or your own proxy can serve models without any paid plan.
- The bundled model list marks free models with a **Free tier** badge and PDF-friendly models
  with **Recommended for PDF**. **Refresh models** asks the provider for the live list;
  **Verify availability** marks ids that come from the bundled fallback list and may have been
  renamed upstream.

## Where to get a key (official links)

1. **Gemini** — <https://aistudio.google.com/apikey> → sign in → **Create API key**.
2. **OpenRouter** — <https://openrouter.ai/keys> → **+ Create Key**. Free models end in `:free`.
3. **Groq** — <https://console.groq.com/keys> → **Create API Key**.
4. **OpenAI** — <https://platform.openai.com/api-keys> → **Create new secret key** (only needed
   if you point at OpenAI’s paid API rather than your own endpoint).

Copy the whole key in one go. It is shown only once by most providers.

## How your keys are stored

| Property | Behaviour |
| --- | --- |
| Encryption | WebCrypto **AES-GCM** (256-bit), derived with **PBKDF2-SHA256**, 150,000 iterations, a fresh random salt and 96-bit IV per seal (`src/core/crypto.ts`) |
| Storage | Sealed ciphertext inside **IndexedDB** on this device (`apiKeys` table, Dexie) — never in `localStorage` as plaintext, and not on a server unless the separate sync switch below is turned on |
| Optional vault passphrase | In **Settings → AI Providers → Vault passphrase** you can add a passphrase. With it, keys are sealed with your passphrase and kept in memory **for this session only**; leave it empty and the keys are device-bound instead |
| Display | The UI only ever renders the masked form `••••1234` (last four characters) |
| Logs | The plaintext never reaches a log line; provider adapters redact the key out of every error message before it is shown |
| Cloud sync | **Off by default, and its own switch.** Until you turn on **Settings → Data → Cloud sync → API keys**, nothing leaves the device: secret-looking setting ids are filtered client-side, and the sync backend rejects those with `SECRET_NOT_ALLOWED`. Switch it on and the *readable value* of each key is written to the `ApiKeys` tab of your Sheet — that is a deliberate, personal choice (the Sheet is your own database), and the panel states it plainly before you do. See [SECURITY.md](SECURITY.md#plaintext-key-sync-opt-in-and-reversible) |
| `.env` / bundle | Never present. Only non-sensitive `VITE_` values are compiled into the browser bundle (see [below](#warning-vite_-env-vars-are-public)) |

The main thread never holds a secret: translation runs open the sealed records inside the
translation Web Worker, which reads the plaintext only while a request is in flight.

## Adding, testing and enabling keys

All of this happens in **Settings → AI Providers**:

1. **(Optional) Vault passphrase** — enter a passphrase and press **Apply passphrase** to
   protect keys beyond this device, or leave it empty for device-bound keys. **Forget
   passphrase** drops it from memory for the session.
2. **Add key** — pick the provider card, paste the key into *Paste API key* (values shorter
   than 8 characters are rejected as too short), optionally give it a **Nickname** such as
   `phone-plan` or `work`, and press **Add key**. Toast: *API key added*.
3. **Test key** — sends one cheap request to the provider. The result line shows
   `kind · latency ms` (for example `ok · 412 ms`). Only a definitive verdict changes the
   status: a network hiccup does not condemn a good key.
4. **Enabled switch** — turn a key off without deleting it (for example to reserve a key for
   manual runs).
5. **Use this provider** — the card’s activation button makes the provider the active one for
   translation; toast: *… is now the active provider*.
6. **Usage counters** — each row shows `N requests · X in / Y out tokens`, updated as the pool
   spends the key. The cooldown countdown appears as *Cooling down until 14:03:22*.

### Health badges

| Badge | Meaning | What the pool does |
| --- | --- | --- |
| **Healthy** | Last test/request succeeded, no cooldown | Eligible for every request |
| **Cooling down** | Rate-limited (HTTP 429) or a transient server error | Skipped until the cooldown deadline; exponential backoff (base 2 s, cap 5 min) with ±25 % jitter, or the provider’s `Retry-After` if longer |
| **Quota exhausted** | Daily/period quota hit | Skipped until the window resets (default cooldown 60 minutes if the provider gives no reset time) |
| **Invalid** | Provider answered 401/403 | Excluded permanently until you fix or replace the key |
| **Not tested** | Freshly added, never called | Used like a healthy key |
| **Disabled** | Your switch is off | Never selected |

### How the pool picks the next key

- **Rotation strategy** (Translate page → *Key rotation*): **Round robin** cycles through the
  usable keys in order; **Least used** prefers the key with the fewest requests so far.
- Before each request the pool checks three fixed-window token buckets per key — **RPM**
  (requests/min), **TPM** (tokens/min) and **RPD** (requests/day), with model-aware ceilings
  (defaults: 30 rpm / 100,000 tpm / 1,000 rpd). Live `RateLimit-*` headers from the provider
  always override the estimates.
- On **429** the current key goes into cooldown and the pool immediately **picks the next
  usable key**, so a translation run keeps going instead of stalling. If the run pauses, the
  UI shows *Every key is cooling down — waiting for the first one* with a countdown.
- When **every** key is unusable the run stops with a reason code:
  `ALL_KEYS_COOLING_DOWN`, `QUOTA_EXHAUSTED`, `INVALID_KEY` or `NO_API_KEY`.
- Cooldowns, counters and bucket positions are persisted to IndexedDB, so refreshing the page
  mid-run resumes with the same state instead of stampeding the provider again.

## Warning: `VITE_` env vars are public

Anything prefixed `VITE_` is **inlined into the JavaScript bundle at build time** and is
readable by anyone who opens your site’s source. This affects:

| Variable | Purpose | Safe to expose? |
| --- | --- | --- |
| `VITE_APPS_SCRIPT_URL` | Sync endpoint (`/exec` URL) | Yes — but see note |
| `VITE_APPS_SCRIPT_TOKEN` | Shared sync token | Only for a **single-user, private** deployment; anyone who can load your bundle can sync to your Sheet. Never a provider API key |
| `VITE_ASSISTANT_PROXY_URL` | Troubleshooting-assistant proxy (`proxy/`) | Yes — it is just a URL |
| `VITE_APP_NAME`, `VITE_APP_VERSION`, `VITE_ENABLE_ANALYTICS` | Display/build flags | Yes |

**Rules:**

- **Never** put a Gemini/OpenRouter/Groq/OpenAI API key in any `VITE_` variable — it would be
  published with every build.
- The assistant’s OpenRouter key lives **only** in the proxy’s server-side `.env` as
  `OPENROUTER_ASSISTANT_KEY` (see `proxy/README.md`); it is never `VITE_`-prefixed and never
  committed.
- The sync token’s normal home is the Script Property on Google’s side and the sealed field
  in Settings → Data on your device. A `.env` copy is acceptable only when you alone run and
  build this app, and even then it must never be a real provider key.
- `.env` files are gitignored; only `.env.example` templates may be committed, and they must
  contain no real values.

## Rotating a compromised key

If you suspect a key leaked (shared screen, committed file, stolen laptop):

1. **In the app:** Settings → AI Providers → the key row → trash icon (*API key removed*).
   If the key was sealed with a vault passphrase you no longer trust, also **Forget
   passphrase** and clear local data if the device itself is compromised.
2. **In the provider console:** delete/regenerate the key so the old value stops working
   immediately (Gemini: *Delete key*; OpenRouter: *Delete*; Groq: *Delete*; OpenAI: *Roll
   key*).
3. **Add the new key** to the same provider card and **Test key** before starting a run.

## Multiple keys for rate-limit spreading

- Add several keys to one provider (each with its own nickname) and leave them **Enabled**.
- Choose **Round robin** to spread requests evenly, or **Least used** to balance by volume.
- Keep at least one key from a *different* provider configured as well — on
  `QUOTA_EXHAUSTED`, **Switch provider** (Settings → AI Providers → *Use this provider*)
  lets the run continue elsewhere while the first provider’s daily window resets.
- Per-key counters show which keys actually carry traffic; disable or delete the ones that do
  not.

## Troubleshooting

| Reason code | What you see | Cause | Fix |
| --- | --- | --- | --- |
| `NO_API_KEY` | *No AI API key has been added yet.* | The active provider has no key rows | 1. Settings → AI Providers → the provider card. 2. Paste a key → **Add key**. 3. **Test key**, then start again |
| `INVALID_KEY` | *The AI key is invalid or was rejected by the provider.* | Provider answered HTTP 401/403: key mistyped, revoked or expired | 1. **Test key** to confirm. 2. Open the provider site (**Check key**) and copy a fresh key. 3. Replace the row: delete the old one, add the new one. 4. Watch out for leading/trailing spaces — paste the whole key |
| `QUOTA_EXHAUSTED` | *The AI quota or rate limit has been exhausted.* | The daily/period quota of the key or model is spent | 1. Wait for the provider window to reset (the cooldown countdown shows the time). 2. **Switch provider** or model with a fresh free tier. 3. Add a second key on the same provider to keep working |
| `ALL_KEYS_COOLING_DOWN` | *All keys are cooling down — wait a moment and retry.* | Every enabled key is inside a cooldown or its RPM/RPD bucket is full | 1. Wait for the countdown (shown on the Translate page). 2. **Add another key**. 3. Spread load: lower batch size or switch to *Least used* rotation |
| `MODEL_UNAVAILABLE` | *The selected model is unavailable.* | Model id removed/renamed upstream (HTTP 404 / `model_not_found`) | 1. **Refresh models** on the provider card. 2. **Choose another model** — prefer a **Free tier** + **Recommended for PDF** entry. 3. Retry; bundled fallback chains step down automatically when an id returns 404 |
| `PROVIDER_NOT_CONFIGURED` | *No translation provider or model has been selected.* | `ai.provider` / `ai.model` settings are empty | 1. Settings → AI Providers. 2. Open a provider card, pick a **Model**. 3. Press **Use this provider**. 4. Return to the Translate page |

If a test or request fails with a **network** kind error, check your connection first —
provider errors caused by being offline are reported as `NETWORK_OFFLINE` instead, and the job
resumes automatically when you are back online.

## Where the pieces live in this repository

| Path | Role |
| --- | --- |
| `src/pages/settings/ProvidersTab.tsx` | The Settings → AI Providers UI: vault, provider cards, key rows, tests |
| `src/translate/keyPool.ts` | Rotation, token buckets, cooldown/backoff, health snapshots |
| `src/core/crypto.ts` | AES-GCM sealing + PBKDF2 key derivation |
| `src/db/repo-apiKeys.ts` | Sealed key storage in IndexedDB |
| `src/providers/` | Gemini, OpenRouter, Groq and OpenAI-compatible adapters |
| `src/config/models.config.ts` | Provider metadata, bundled models, free-tier limits, fallback chains |
| `src/core/reasonCodes.ts` | The reason codes listed in the troubleshooting table |
| `proxy/README.md` | Assistant proxy — where `OPENROUTER_ASSISTANT_KEY` is allowed to live |
