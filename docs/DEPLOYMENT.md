# Deployment

There are three deployables, and only the first one is required:

| Piece | Required? | Where it runs |
| --- | --- | --- |
| Frontend (static `dist/`) | Yes | GitHub Pages, or any static web server |
| Sync backend (`apps-script/Code.gs`) | Only if you use cloud sync | Your Google account (Apps Script web app + Sheet) |
| Assistant proxy (`proxy/`) | Only if you want proxy mode | Anywhere Node ≥ 18 runs, or Cloudflare Workers |

## Local build

```bash
npm ci                      # or: npm install
cp .env.example .env        # Windows: copy .env.example .env  — optional values only
npm run build               # tsc --noEmit && vite build  → dist/
npm run preview             # sanity-check the build at http://localhost:4173
```

`dist/` contains the hashed bundles, `index.html`, `sw.js`, `manifest.webmanifest`, the icons
and a `pdfjs-assets/` folder (pdf.js cMaps and standard fonts, copied by a Vite plugin).
Serve that folder as-is.

## GitHub Pages

The repository ships [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

1. **Trigger:** a push to `main` (or a manual `workflow_dispatch`).
2. **Build job:** checkout → Node 20 with npm cache → `npm ci` → `npx tsc --noEmit` →
   `npx vitest run` → `npm run build`.
3. **Base path:** `VITE_BASE` = the repository variable `VITE_BASE` if set, otherwise
   `/<repository-name>/` — what a GitHub Pages *project* site needs. A repository named
   `<user>.github.io` must set the variable to `/`.
4. **SPA fallback:** `cp dist/index.html dist/404.html`, so unknown paths serve the app shell
   and client-side routes (`/workspace`, `/logs`, …) survive a hard reload.
5. **Deploy job:** uploads the Pages artifact and publishes it with `actions/deploy-pages`.

**One-time setup:** repository **Settings → Pages → Build and deployment → Source** =
**GitHub Actions**. Optional: **Settings → Secrets and variables → Actions → Variables** →
add `VITE_BASE` (e.g. `/my-fork/`) if your repo name is not what you serve under.

Environment variables for a Pages deployment go through the workflow, not a `.env` file —
`VITE_APPS_SCRIPT_URL`, `VITE_APPS_SCRIPT_TOKEN` and `VITE_ASSISTANT_PROXY_URL` are read from
the build environment. See the warning below: they are baked into the bundle.

> A deployed build is public. Anything `VITE_`-prefixed in it is readable by anyone with the
> URL, which is why the assistant key must never be there — see [SECURITY.md](SECURITY.md).

## Self-hosting `dist/`

Any static server works. Two things must be right: the **base path** you built with, and an
**SPA rewrite** so deep links resolve to `index.html`.

```bash
VITE_BASE=/ npm run build
```

**nginx** (root deployment):

```nginx
server {
  listen 80;
  server_name example.com;
  root /var/www/aidt/dist;
  index index.html;

  # SPA fallback — unknown paths get the app shell.
  location / {
    try_files $uri $uri/ /index.html;
  }

  # pdf.js data files copied into dist/ by the build.
  location /pdfjs-assets/ {
    expires 7d;
    add_header Cache-Control "public";
  }

  # Optional hardening — start here and loosen only what you must:
  # connect-src needs your provider hosts, the Apps Script endpoint and the proxy.
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
    font-src 'self'; worker-src 'self' blob:; \
    connect-src 'self' https://script.google.com https://script.googleapis.com \
    https://*.googleapis.com; object-src 'none'; base-uri 'self';" always;
}
```

The app does not ship a CSP itself, so a header like the one above is the place to add one.
Verify it against your own build: translation calls go to whichever provider you configure,
OCR language data may be fetched from a CDN on first use, and your assistant proxy origin must
be in `connect-src` if you use it.

**Hosts without rewrite rules** (S3, basic shared hosting): copy `dist/index.html` to
`dist/404.html` before uploading — exactly what the Pages workflow does.

**Sub-path hosting:** build with `VITE_BASE=/sub-path/`. The router uses that as its
`basename` and the service worker resolves its scope from its own location, so both line up
automatically.

## Sync backend (Apps Script)

The backend is not part of `dist/` — it lives in your Google account:

1. Create a Google Sheet → **Extensions → Apps Script**.
2. Paste `apps-script/Code.gs` and `apps-script/appsscript.json`.
3. Set the `TOKEN` Script Property (a long random string you generate yourself).
4. **Deploy → New deployment → Web app**, execute as *Me*, access = *Anyone*.
5. Copy the `/exec` URL into `VITE_APPS_SCRIPT_URL` (or Settings → Data → Cloud sync) and the
   token into the app's Access token field.

Full click-by-click walkthrough, tabs, CORS notes and error codes:
**[GOOGLE_APPS_SCRIPT_SETUP.md](GOOGLE_APPS_SCRIPT_SETUP.md)**.

## Assistant proxy (optional)

- **Node ≥ 18** (Express): `cd proxy && npm install`, copy `proxy/.env.example` to
  `proxy/.env`, set `OPENROUTER_ASSISTANT_KEY`, then `npm start`. For a PaaS, the start
  command is `node server.js` from `proxy/`, the platform injects `PORT`, and `TRUST_PROXY=1`
  keeps per-IP rate limiting accurate behind its load balancer.
- **Cloudflare Worker:** `proxy/cloudflare-worker.js` is a dependency-free ES module —
  `npx wrangler secret put OPENROUTER_ASSISTANT_KEY`, optional `[vars]`, `npx wrangler deploy`.
- Point the frontend at it with `VITE_ASSISTANT_PROXY_URL` (e.g.
  `https://assistant.example.workers.dev`). Without it, the app falls back to the built-in
  offline rule engine — nothing breaks.

Contract, limits, CORS allowlist and error envelopes: **[../proxy/README.md](../proxy/README.md)**.

## Environment variables

Copy `.env.example` → `.env` for local work; for CI, export them in the build step.

| Variable | Used by | Required | Purpose |
| --- | --- | --- | --- |
| `VITE_APPS_SCRIPT_URL` | Frontend build | For sync | Apps Script endpoint ending in `/exec` |
| `VITE_APPS_SCRIPT_TOKEN` | Frontend build | For sync | Fallback sync token; the sealed value in Settings wins |
| `VITE_ASSISTANT_PROXY_URL` | Frontend build | No | Proxy base URL; empty = offline assistant |
| `VITE_PDF_SIDECAR_URL` | Frontend build | No | Local sidecar base URL; unset = `http://localhost:8790`, empty = sidecar off (browser OCR only) |
| `VITE_BASE` | Frontend build | No | Base path, default `/`; GitHub Pages sets it automatically |
| `OPENROUTER_ASSISTANT_KEY` | **Proxy only** | For proxy mode | Server-side secret — never `VITE_`-prefixed, never committed |
| `PORT`, `ALLOWED_ORIGIN`, `ASSISTANT_MODEL`, `TRUST_PROXY` | Proxy only | No | See [../proxy/README.md](../proxy/README.md) |
| `PORT`, `HOST`, `ALLOWED_ORIGIN` | **Sidecar only** | No | Listen address and CORS origin of `sidecar/server.py` — set `ALLOWED_ORIGIN` to the deployed origin or the browser will refuse the response. See [../sidecar/README.md](../sidecar/README.md) |

> **Build-time warning.** All `VITE_` values are inlined when `vite build` runs. Changing
> `.env` afterwards changes nothing until you rebuild, and every value in the deployed bundle
> is public. Configuration belongs in `.env`; secrets belong in Settings (sealed) or on the
> proxy server.

## Post-deploy checklist

1. Open the site — the shell loads and the service worker registers (`sw.js` in production only).
2. Settings → Data → **Cloud sync test connection** returns `ping` OK (if sync is configured).
3. Start a small translation and confirm a Logs row appears with no `NO_API_KEY`.
4. Ask the assistant one question (or accept the offline rule answer).
5. Reload on a deep link (e.g. `/logs`) to confirm the SPA fallback works.
6. Hard-reload once after a redeploy so clients pick up the new `CACHE_VERSION`.
