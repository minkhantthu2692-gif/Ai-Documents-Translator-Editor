@echo off
setlocal
rem Opens the AI Documents Translator ^& Editor for local development.
rem   - checks Node.js >= 18
rem   - installs dependencies when node_modules is missing
rem   - copies .env.example -^> .env (once)
rem   - starts the Vite dev server and opens http://localhost:5173
cd /d "%~dp0\.."

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed. Install Node 18+ from https://nodejs.org and re-run.
  exit /b 1
)

set NODE_MAJOR=
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo ERROR: Could not determine the Node.js version.
  exit /b 1
)
if %NODE_MAJOR% LSS 18 (
  echo ERROR: Node %NODE_MAJOR% is too old. Version 18 or newer is required.
  exit /b 1
)
echo Node OK

if not exist node_modules (
  echo Installing dependencies (npm install^)...
  call npm install
  if errorlevel 1 exit /b 1
) else (
  echo Dependencies already installed
)

if not exist .env (
  if exist .env.example (
    copy /y .env.example .env >nul
    echo Created .env from .env.example ^(edit it to add optional keys^)
  )
)

rem Dev server in its own window so this one can wait for it and open the browser.
start "Doc Translator dev server" cmd /k "cd /d "%~dp0\.." && npm run dev"

set TRIES=0
:wait_loop
timeout /t 1 /nobreak >nul
node -e "require('http').get('http://localhost:5173', function(){process.exit(0)}).on('error', function(){process.exit(1)})" >nul 2>nul
if not errorlevel 1 goto up
set /a TRIES+=1
if %TRIES% LSS 40 goto wait_loop
echo Dev server has not answered on http://localhost:5173 yet - check its window.
exit /b 0

:up
echo Dev server is up - opening http://localhost:5173
start "" "http://localhost:5173"
exit /b 0
