@echo off
setlocal enabledelayedexpansion
rem Guided "commit + push" for this repository.
rem   - verifies git (initialises the repo on first run)
rem   - forces branch main and remote origin -> the project GitHub repo
rem   - sets a *local-only* identity (never touches --global config)
rem   - verifies .gitignore covers .env / node_modules / dist
rem   - prompts for a commit message, commits, pushes
rem
rem SECURITY: this script never stores or hardcodes credentials. Push uses
rem whatever credential helper git already has. Never paste tokens into
rem scripts or the repository.
cd /d "%~dp0\.."

set "REPO_URL=https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor.git"
set "LOCAL_NAME=minkhantthu2692-gif"
set "LOCAL_EMAIL=minkhantthu2692@gmail.com"

where git >nul 2>nul
if errorlevel 1 (
  echo ERROR: git is not installed. Install it from https://git-scm.com/downloads and re-run.
  exit /b 1
)

if not exist .git (
  echo No git repository yet - initialising one
  git init
  if errorlevel 1 exit /b 1
)
git checkout -B main >nul 2>nul

git config user.name >nul 2>nul
if errorlevel 1 (
  git config user.name "%LOCAL_NAME%"
  echo Set local git user.name ^(%LOCAL_NAME%^)
)
git config user.email >nul 2>nul
if errorlevel 1 (
  git config user.email "%LOCAL_EMAIL%"
  echo Set local git user.email ^(%LOCAL_EMAIL%^)
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "%REPO_URL%"
  echo Added origin -^> %REPO_URL%
) else (
  for /f "delims=" %%u in ('git remote get-url origin') do set "CURRENT_URL=%%u"
  if not "!CURRENT_URL!"=="%REPO_URL%" (
    git remote set-url origin "%REPO_URL%"
    echo Updated origin -^> %REPO_URL%
  )
)

git check-ignore .env >nul 2>nul
if errorlevel 1 (
  echo. >> .gitignore
  echo # Added by tools/push-to-github.bat >> .gitignore
  echo .env >> .gitignore
  echo node_modules >> .gitignore
  echo dist >> .gitignore
  echo Appended .env, node_modules and dist to .gitignore
)
git check-ignore .env >nul 2>nul
if errorlevel 1 (
  echo ERROR: .gitignore still does not cover .env - refusing to continue.
  exit /b 1
)

git add -A

for /f "delims=" %%s in ('git status --porcelain') do set "HAS_CHANGES=1"
if not defined HAS_CHANGES (
  echo Nothing to commit - working tree is clean.
  exit /b 0
)

echo Files to be committed:
git status --short

set "MESSAGE="
set /p "MESSAGE=Commit message (Enter for default): "
if not defined MESSAGE set "MESSAGE=Update from local dev"

git commit -m "%MESSAGE%"
if errorlevel 1 exit /b 1

echo Pushing to origin/main...
git push -u origin main
if errorlevel 1 (
  echo Push failed. This script never stores credentials - authenticate with one of:
  echo   * GitHub CLI:  gh auth login ^(https://cli.github.com^)
  echo   * Git prompt:  git push will ask for a username + Personal Access Token
  echo   * SSH:         add a key and use an ssh:// remote
  echo Then re-run: tools\push-to-github.bat
  exit /b 1
)

echo Done - pushed to %REPO_URL% ^(branch main^).
exit /b 0
