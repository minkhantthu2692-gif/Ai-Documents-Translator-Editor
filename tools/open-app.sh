#!/usr/bin/env bash
# Opens the AI Documents Translator & Editor for local development.
#   - checks Node >= 18
#   - installs dependencies when node_modules is missing
#   - copies .env.example -> .env (once)
#   - starts the Vite dev server and opens http://localhost:5173
set -euo pipefail
cd "$(dirname "$0")/.."

APP_URL="http://localhost:5173"

info() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. Node.js >= 18 ------------------------------------------------------
command -v node >/dev/null 2>&1 ||
  fail "Node.js is not installed. Install Node 18+ from https://nodejs.org and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] ||
  fail "Node $NODE_MAJOR is too old. Version 18 or newer is required (found $(node -v))."
info "Node $(node -v) OK"

# --- 2. Dependencies -------------------------------------------------------
if [ ! -d node_modules ]; then
  info "Installing dependencies (npm install)…"
  npm install
else
  info "Dependencies already installed"
fi

# --- 3. Environment file ---------------------------------------------------
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  info "Created .env from .env.example (edit it to add optional keys)"
fi

# --- 4. Dev server + browser ----------------------------------------------
probe() {
  node -e "
    const http = require('http');
    const req = http.get('$APP_URL', () => process.exit(0));
    req.on('error', () => process.exit(1));
    req.setTimeout(1500, () => { req.destroy(); process.exit(1); });
  " >/dev/null 2>&1
}

npm run dev &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' INT TERM EXIT

opened=0
for _ in $(seq 1 60); do
  if probe; then
    opened=1
    break
  fi
  kill -0 "$DEV_PID" 2>/dev/null || break
  sleep 0.5
done

if [ "$opened" -eq 1 ]; then
  info "Dev server is up — opening $APP_URL"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$APP_URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$APP_URL" || true
  fi
else
  info "Dev server did not answer on $APP_URL yet — check the output above."
fi

# Keep the script in the foreground until Ctrl+C stops the dev server.
wait "$DEV_PID"
