# aidt-assistant-proxy

Server-side proxy for the **Troubleshooting Assistant** in AI Documents Translator & Editor.

The browser app collects structured diagnostic context (error code, stack, job state,
provider/model, recent logs, browser info) and asks an AI for a plain-language explanation and
fix steps. The OpenRouter API key must **never** ship in the frontend bundle, so the browser
calls this proxy instead. When `VITE_ASSISTANT_PROXY_URL` is not set, the app falls back to its
built-in offline rule-based engine — the proxy is optional and always fails with a clear JSON
envelope.

Two interchangeable implementations of the same contract:

| File                     | Runtime                          |
| ------------------------ | -------------------------------- |
| `server.js`              | Node 18+ / Express (local, Render, Railway, Fly) |
| `cloudflare-worker.js`   | Cloudflare Worker (ES module, dependency-free)   |

## Local setup

```bash
cd proxy
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# edit .env and set OPENROUTER_ASSISTANT_KEY to your OpenRouter API key
npm start                 # node server.js  on http://127.0.0.1:8787
# or, with automatic restart on change:
npm run dev               # node --watch server.js
```

Then set `VITE_ASSISTANT_PROXY_URL=http://127.0.0.1:8787` in the frontend `.env` (that value is
`VITE_`-prefixed and non-sensitive, so it may be committed; the key itself never is).

Quick check:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"hasKey":true,"uptime":12.3}
```

## Environment variables

| Variable                   | Where                              | Required | Default                                          | Purpose                                                                 |
| -------------------------- | ---------------------------------- | -------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `OPENROUTER_ASSISTANT_KEY` | `proxy/.env` or `wrangler secret`  | Yes\*    | —                                                | OpenRouter API key. Server-side only. Never `VITE_`-prefixed, never committed. |
| `PORT`                     | `proxy/.env`                       | No       | `8787`                                           | Port for `server.js`. On PaaS platforms this is provided by the host.  |
| `ALLOWED_ORIGIN`           | `proxy/.env` or `wrangler [vars]`  | No       | `http://localhost:5173`                          | Extra CORS origins, comma-separated. `http://localhost:5173` and `http://127.0.0.1:5173` are always allowed. |
| `ASSISTANT_MODEL`          | `proxy/.env` or `wrangler [vars]`  | No       | `meta-llama/llama-3.3-70b-instruct:free`         | OpenRouter model id (`:free` suffix = free tier).                       |
| `TRUST_PROXY`              | `proxy/.env` (`server.js` only)    | No       | `0`                                              | Number of trusted proxy hops. Set to `1` behind Render/Railway/Fly so per-IP rate limiting sees the real client IP. |

\* Without a key the proxy still starts and answers `GET /health` with `hasKey:false`; every
`POST /assistant` returns `503 MISSING_KEY` until the key is configured.

## Request/response contract

### Endpoints

| Method | Path               | Purpose                                  |
| ------ | ------------------ | ---------------------------------------- |
| `POST` | `/assistant`       | Main endpoint the frontend calls         |
| `POST` | `/`                | Alias                                    |
| `POST` | `/ask`             | Alias                                    |
| `GET`  | `/health`          | `{ ok, hasKey, uptime }` — `hasKey` is a boolean only |
| `OPTIONS` | any             | CORS preflight (`Content-Type`, `POST`)  |

### Request

`Content-Type: application/json`, body capped at **32KB** (larger → `413` with the error envelope):

```json
{
  "question": "Translation job stuck at 40% on page 3",
  "context": { "errorCode": "PDF_WORKER_TIMEOUT", "jobState": "running", "model": "gpt-4o-mini" },
  "lang": "en"
}
```

| Field     | Type            | Rules                                                        |
| --------- | --------------- | ------------------------------------------------------------ |
| `question` | string         | Required, non-empty after trim, at most 4000 characters. Else `400 BAD_REQUEST`. |
| `context` | object (optional) | Must serialize to at most 24KB. Else `400 BAD_REQUEST`.     |
| `lang`    | `'en' \| 'my'` (optional) | Defaults to `'en'`. `'my'` answers in Burmese (Myanmar script). |

### Success — `200`

```json
{
  "ok": true,
  "answer": {
    "title": "The PDF worker timed out",
    "explanation": "The PDF worker stopped responding while it was processing page 3, so the job cannot move past 40%. This usually happens when the file is very large or the browser ran out of memory.",
    "steps": ["Open the Jobs tab and cancel the stuck job.", "Reload the page to give the browser a fresh worker.", "Retry the translation with fewer pages per batch."],
    "actions": [{ "id": "retry-job", "label": "Retry the job", "kind": "retry" }]
  },
  "model": "meta-llama/llama-3.3-70b-instruct:free"
}
```

The model's JSON is normalized before it leaves the proxy: `title ≤ 120` chars,
`explanation ≤ 3000` chars, 1–6 `steps` each ≤ 400 chars, at most 5 `actions` with
`label ≤ 60` chars and `kind` forced into `retry | config | data | navigation`.

### Failure — always the same envelope

```json
{ "ok": false, "code": "RATE_LIMITED", "message": "human-readable, safe, ≤300 chars" }
```

| Code             | Status | When                                                        |
| ---------------- | ------ | ----------------------------------------------------------- |
| `BAD_REQUEST`    | 400    | Missing/too long `question`, bad `context`, malformed JSON, unknown route |
| `BAD_REQUEST`    | 413    | Body larger than 32KB                                       |
| `RATE_LIMITED`   | 429    | More than 20 requests per 15 minutes per IP, or OpenRouter returned 429 |
| `MISSING_KEY`    | 503    | `OPENROUTER_ASSISTANT_KEY` not set on the proxy             |
| `UPSTREAM_ERROR` | 502    | OpenRouter unreachable/failed, or the model returned an unreadable response (one automatic retry is attempted first) |
| `TIMEOUT`        | 504    | OpenRouter did not answer within 20 seconds                 |
| `INTERNAL`       | 500    | Unexpected proxy bug (details go to server logs, not the response) |

`message` is always a safe, human-readable string truncated to 300 characters — the API key is
never echoed and upstream bodies are never dumped verbatim.

### Example

```bash
curl -X POST http://127.0.0.1:8787/assistant \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"PDF export fails with error code 42\",\"lang\":\"en\"}"
```

## Deployment

### Render / Railway / Fly (Node)

- **Start command:** `node server.js` (or `npm start`), working directory `proxy/`.
- **Build command:** `npm install --no-audit --no-fund`.
- Set `OPENROUTER_ASSISTANT_KEY` (secret), `ALLOWED_ORIGIN` (the origin of your deployed
  frontend, comma-separated) and `TRUST_PROXY=1` in the platform's environment settings —
  `TRUST_PROXY=1` makes the per-IP rate limiter read the real client IP behind the platform
  load balancer.
- `PORT` is injected by the platform; `server.js` reads it automatically.
- No other files from this folder are needed at runtime.

### Cloudflare Workers

1. Create `wrangler.toml` from the snippet at the top of `cloudflare-worker.js`:
   `name`, `main = "cloudflare-worker.js"`, `compatibility_date`, optional `[vars]`.
2. `npx wrangler secret put OPENROUTER_ASSISTANT_KEY` (secret — never put it in `wrangler.toml`
   or in code).
3. Optional non-secret vars go in `[vars]`: `ALLOWED_ORIGIN`, `ASSISTANT_MODEL`.
4. `npx wrangler deploy`.
5. The same `POST /assistant|/|/ask` and `GET /health` contract applies, including the 32KB body
   cap, validation limits and error envelopes.

**Rate limiting on Workers:** implemented with an in-memory `Map` keyed by `CF-Connecting-IP`
(20 requests / 15 minutes). It is **per isolate** and **resets when Cloudflare restarts or
replaces an isolate**, so it is best-effort. For a hard limit, add Cloudflare's Rate Limiting
binding or a durable store in front.

## Security notes

- **Key stays server-side:** `OPENROUTER_ASSISTANT_KEY` lives only in `proxy/.env` (gitignored,
  see `proxy/.gitignore`) or a `wrangler secret`. It is never prefixed `VITE_`, never bundled,
  never logged, never echoed in a response (responses scrub it defensively if it ever appeared
  in an upstream error message).
- **Rate limit:** 20 requests / 15 minutes / IP (`express-rate-limit` with standard
  `RateLimit-*` headers, no legacy `X-RateLimit-*`), and the same window in the Worker.
- **Size limits:** 32KB raw body, `question ≤ 4000` chars, `context ≤ 24KB` serialized,
  prompt context truncated to 8000 chars, upstream messages truncated to 300 chars,
  `max_tokens: 700` and a 20s upstream timeout.
- **CORS allowlist:** only `http://localhost:5173`, `http://127.0.0.1:5173` and origins listed in
  `ALLOWED_ORIGIN` (comma-separated). Preflight allows `POST` and the `Content-Type` header;
  disallowed origins receive no CORS headers.
- **Minimal surface:** `x-powered-by` disabled, JSON body parsing mounted only on the assistant
  routes, stdout logs contain method/path/status/duration only — no bodies, no headers, no keys.
