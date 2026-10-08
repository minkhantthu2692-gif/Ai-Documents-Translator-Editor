#!/usr/bin/env bash
# Guided "commit + push" for this repository.
#   - verifies git exists (initialises the repo on first run)
#   - forces branch `main` and remote `origin` -> the project GitHub repo
#   - sets a *local-only* identity (never touches --global config)
#   - verifies .gitignore covers .env / node_modules / dist
#   - prompts for a commit message, commits, pushes
#
# SECURITY: this script never stores or hardcodes credentials. Push uses
# whatever credential helper git already has (gh auth, credential manager,
# ssh key). Never paste tokens into scripts or the repository.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_URL="https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor.git"
LOCAL_NAME="minkhantthu2692-gif"
LOCAL_EMAIL="minkhantthu2692@gmail.com"

info() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. git available? -----------------------------------------------------
command -v git >/dev/null 2>&1 ||
  fail "git is not installed. Install it from https://git-scm.com/downloads and re-run."

# --- 2. repository + branch ------------------------------------------------
if [ ! -d .git ]; then
  info "No git repository yet — initialising one"
  git init
fi
git checkout -B main >/dev/null 2>&1 || true
info "Branch: $(git branch --show-current 2>/dev/null || echo main)"

# --- 3. local-only identity ------------------------------------------------
if ! git config user.name >/dev/null 2>&1; then
  git config user.name "$LOCAL_NAME"
  info "Set local git user.name ($LOCAL_NAME)"
fi
if ! git config user.email >/dev/null 2>&1; then
  git config user.email "$LOCAL_EMAIL"
  info "Set local git user.email ($LOCAL_EMAIL)"
fi

# --- 4. remote origin ------------------------------------------------------
if git remote get-url origin >/dev/null 2>&1; then
  current="$(git remote get-url origin)"
  if [ "$current" != "$REPO_URL" ]; then
    git remote set-url origin "$REPO_URL"
    info "Updated origin -> $REPO_URL"
  fi
else
  git remote add origin "$REPO_URL"
  info "Added origin -> $REPO_URL"
fi

# --- 5. .gitignore must cover secrets + build output ----------------------
missing=""
for path in .env node_modules dist; do
  git check-ignore -q "$path" || missing="$missing $path"
done
if [ -n "$missing" ]; then
  info "Appending to .gitignore:$missing"
  {
    printf '\n# Added by tools/push-to-github.sh\n'
    for path in $missing; do printf '%s\n' "$path"; done
  } >>.gitignore
fi
if git check-ignore -q .env; then
  info ".gitignore covers .env, node_modules and dist"
else
  fail ".gitignore does not cover .env — refusing to continue (secrets could be committed)."
fi

# --- 6. stage, prompt, commit ---------------------------------------------
git add -A

if [ -z "$(git status --porcelain)" ]; then
  info "Nothing to commit — working tree is clean."
  exit 0
fi

info "Files to be committed:"
git status --short

printf 'Commit message (Enter for default): '
read -r MESSAGE || MESSAGE=""
[ -n "$MESSAGE" ] || MESSAGE="Update from local dev"

git commit -m "$MESSAGE"

# --- 7. push ---------------------------------------------------------------
info "Pushing to origin/main…"
if ! git push -u origin main; then
  cat >&2 <<'HINT'
Push failed. This script never stores credentials — authenticate with one of:
  * GitHub CLI:   gh auth login      (https://cli.github.com)
  * Git prompt:   git push will ask for a username + Personal Access Token
  * SSH:          add a key and use an ssh:// remote
Then re-run: tools/push-to-github.sh
HINT
  exit 1
fi

info "Done — pushed to $REPO_URL (branch main)."
