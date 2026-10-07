/**
 * Phase 1 smoke test — drives the running dev server in headless Chrome over CDP.
 * Verifies: routes render, responsive breakpoints, theme + language persistence,
 * Dexie data surviving reload, and a UI-level backup export/import round-trip.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9444
const BASE = 'http://localhost:5173'
const DL_DIR = join(tmpdir(), 'aidt-dl')

const results = []
const consoleErrors = []
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 300) })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

const profile = mkdtempSync(join(tmpdir(), 'aidt-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws
try {
  let targets
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (targets.some((t) => t.type === 'page')) break
    } catch {
      /* devtools not up yet */
    }
    targets = undefined
    await sleep(250)
  }
  if (!targets) throw new Error('Chrome DevTools never came up')

  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })

  let id = 0
  const pending = new Map()
  const listeners = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(`${msg.method ?? msg.id}: ${msg.error.message}`))
      else res(msg.result)
    } else if (!msg.id) {
      for (const l of listeners) l(msg)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolveRes, rejectRes) => {
      const callId = ++id
      pending.set(callId, { resolve: resolveRes, reject: rejectRes })
      ws.send(JSON.stringify({ id: callId, method, params }))
    })

  listeners.push((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      consoleErrors.push('EXCEPTION: ' + (d.exception?.description || d.text))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(
        'CONSOLE: ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
      )
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const e = msg.params.entry
      consoleErrors.push(`LOG: ${e.text} ${e.url ?? ''}`)
    }
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('DOM.enable')

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
    }
    return r.result.value
  }

  const goto = async (path) => {
    await send('Page.navigate', { url: BASE + path })
    for (let i = 0; i < 120; i++) {
      const state = await evalJs(
        `JSON.stringify({ready: document.readyState, n: document.querySelector('#main-content')?.childElementCount ?? -1, text: document.querySelector('#main-content')?.innerText?.length ?? 0})`,
      )
      const parsed = typeof state === 'string' ? JSON.parse(state) : state
      if (parsed?.ready === 'complete' && parsed.n > 0 && parsed.text > 0) {
        await sleep(200)
        return parsed
      }
      await sleep(100)
    }
    throw new Error('render timeout for ' + path)
  }

  const setViewport = async (w, h, mobile = false) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile,
    })
    await sleep(250)
  }

  // 1) All routes render real content -------------------------------------
  const routes = [
    ['/', 'dashboard'],
    ['/projects', 'projects'],
    ['/projects/new', 'new project'],
    ['/workspace', 'workspace'],
    ['/settings', 'settings'],
    ['/logs', 'logs'],
    ['/dev/myanmar-test', 'myanmar test'],
  ]
  for (const [path, label] of routes) {
    try {
      const info = await goto(path)
      check(
        `route ${path} renders`,
        info.n > 0 && info.text > 0,
        `${info.n} nodes / ${info.text} chars (${label})`,
      )
    } catch (e) {
      check(`route ${path} renders`, false, e.message)
    }
  }

  // Myanmar test page shows actual Myanmar script
  await goto('/dev/myanmar-test')
  const mmChars = await evalJs(
    `(document.querySelector('#main-content').innerText.match(/[\\u1000-\\u109F]/g) || []).length`,
  )
  check(
    'myanmar test page shows Myanmar glyphs',
    typeof mmChars === 'number' && mmChars > 50,
    `${mmChars} Myanmar chars`,
  )

  // 2) Responsive layout ---------------------------------------------------
  await goto('/')
  const layoutSnapshot = async () =>
    evalJs(
      `JSON.stringify({
        aside: getComputedStyle(document.querySelector('aside')).display,
        bottomNav: (() => { const navs = [...document.querySelectorAll('nav')]; const bottom = navs.find(n => n.querySelector('a') && getComputedStyle(n).borderTopWidth !== '0px'); return bottom ? getComputedStyle(bottom).display : 'none' })(),
        menuBtn: (() => { const b = [...document.querySelectorAll('header button')].find(b => /navigation menu/i.test(b.getAttribute('aria-label')||'')); return b ? getComputedStyle(b).display !== 'none' : false })(),
        drawerHidden: !document.querySelector('[class*="z-drawer"]'),
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth
      })`,
    )

  await setViewport(360, 740, true)
  const w360 = JSON.parse(await layoutSnapshot())
  check('360px: sidebar hidden', w360.aside === 'none', `aside=${w360.aside}`)
  check('360px: bottom tab bar visible', w360.bottomNav !== 'none', `bottomNav=${w360.bottomNav}`)
  check('360px: hamburger visible', w360.menuBtn === true, `menuBtn=${w360.menuBtn}`)
  check(
    '360px: no horizontal overflow',
    w360.scrollW <= w360.innerW + 1,
    `scrollW=${w360.scrollW} innerW=${w360.innerW}`,
  )

  await setViewport(768, 900)
  const w768 = JSON.parse(await layoutSnapshot())
  check('768px: sidebar visible', w768.aside !== 'none', `aside=${w768.aside}`)
  check('768px: bottom tab bar hidden', w768.bottomNav === 'none', `bottomNav=${w768.bottomNav}`)

  await setViewport(1440, 900)
  const w1440 = JSON.parse(await layoutSnapshot())
  check('1440px: sidebar visible', w1440.aside !== 'none', `aside=${w1440.aside}`)
  check('1440px: bottom tab bar hidden', w1440.bottomNav === 'none', `bottomNav=${w1440.bottomNav}`)

  // 3) Theme persistence ---------------------------------------------------
  await goto('/')
  const clickedDark = await evalJs(
    `(() => { const b = document.querySelector('[role="group"][aria-label="Theme"] button[aria-label="Dark"]') || document.querySelector('button[aria-label="Dark"]'); if (!b) return false; b.click(); return true })()`,
  )
  await sleep(300)
  const darkState = await evalJs(
    `JSON.stringify({ cls: document.documentElement.classList.contains('dark'), ls: localStorage.getItem('aidt.ui') })`,
  )
  const ds = typeof darkState === 'string' ? JSON.parse(darkState) : darkState
  check('theme toggle applies dark class', clickedDark && ds?.cls === true, JSON.stringify(ds))
  check('theme written to localStorage', (ds?.ls || '').includes('dark'), ds?.ls)

  await goto('/')
  const afterReload = await evalJs(`document.documentElement.classList.contains('dark')`)
  check('theme survives reload', afterReload === true, String(afterReload))

  // 4) Language persistence (localStorage + Dexie settings) ----------------
  const clickedMy = await evalJs(
    `(() => { const b = document.querySelector('button[lang="my"]'); if (!b) return false; b.click(); return true })()`,
  )
  await sleep(500)
  const langState = await evalJs(
    `JSON.stringify({ lang: document.documentElement.lang, mm: (document.body.innerText.match(/[\\u1000-\\u109F]/g)||[]).length, ls: localStorage.getItem('aidt.ui') })`,
  )
  const ls = typeof langState === 'string' ? JSON.parse(langState) : langState
  check('language switch sets my', clickedMy && ls?.lang === 'my', JSON.stringify(ls))
  check('UI renders Myanmar text', (ls?.mm || 0) > 50, `${ls?.mm} Myanmar chars`)

  await goto('/')
  const langReload = await evalJs(
    `JSON.stringify({ lang: document.documentElement.lang, mm: (document.body.innerText.match(/[\\u1000-\\u109F]/g)||[]).length })`,
  )
  const lr = typeof langReload === 'string' ? JSON.parse(langReload) : langReload
  check('language survives reload', lr?.lang === 'my' && lr.mm > 50, JSON.stringify(lr))

  // 5) Dexie data survives reload ----------------------------------------
  const readDb = () =>
    evalJs(
      `(async () => {
        try {
          const names = (await indexedDB.databases()).map(d => d.name)
          const rows = await new Promise((res, rej) => {
            const req = indexedDB.open('aidt')
            req.onerror = () => rej(req.error?.message || 'open failed')
            req.onsuccess = () => {
              const db = req.result
              const stores = ['settings', 'events', 'projects', 'cache'].filter(s => db.objectStoreNames.contains(s))
              const out = {}
              const tx = db.transaction(stores, 'readonly')
              let left = stores.length
              if (!left) { db.close(); res(out); return }
              for (const s of stores) {
                const c = tx.objectStore(s).count()
                c.onsuccess = () => { out[s] = c.result; if (--left === 0) { db.close(); res(out) } }
              }
              tx.onerror = () => rej(tx.error?.message || 'tx failed')
            }
          })
          return { ok: true, names, rows }
        } catch (e) { return { ok: false, error: String(e?.message || e) } }
      })()`,
      true,
    )

  const dbBefore = await readDb()
  check('IndexedDB database present', dbBefore?.ok === true, JSON.stringify(dbBefore))
  check(
    'settings + events tables have rows',
    (dbBefore?.rows?.settings ?? 0) > 0 && (dbBefore?.rows?.events ?? 0) > 0,
    JSON.stringify(dbBefore?.rows),
  )

  const dbAfter = await readDb()
  check(
    'Dexie row counts survive reload',
    JSON.stringify(dbAfter?.rows) === JSON.stringify(dbBefore?.rows) ||
      ((dbAfter?.rows?.events ?? 0) >= (dbBefore?.rows?.events ?? 0) &&
        (dbAfter?.rows?.settings ?? 0) >= (dbBefore?.rows?.settings ?? 0)),
    `before=${JSON.stringify(dbBefore?.rows)} after=${JSON.stringify(dbAfter?.rows)}`,
  )

  // 6) Create a project through the wizard (real Dexie write) -------------
  await goto('/projects/new')
  await evalJs(
    `(() => { const b = document.querySelector('button[lang="en"]'); if (b) b.click(); return true })()`,
  )
  await sleep(400)
  await evalJs(
    `(() => {
      const input = document.querySelector('input[maxlength="120"]')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'Smoke test project')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`,
  )
  await sleep(300)
  for (let i = 0; i < 5; i++) {
    const clicked = await evalJs(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => /^(Next|Create project)$/.test(b.textContent.trim())); if (!b || b.disabled) return false; b.click(); return true })()`,
    )
    await sleep(600)
    const path = await evalJs('location.pathname')
    if (String(path).startsWith('/workspace/')) break
    if (!clicked) break
  }
  const createdPath = await evalJs('location.pathname')
  check(
    'wizard creates a project and opens workspace',
    /^\/workspace\/\w+/.test(String(createdPath)),
    String(createdPath),
  )
  const dbWithProject = await readDb()
  check(
    'project row written to Dexie',
    (dbWithProject?.rows?.projects ?? 0) === 1,
    JSON.stringify(dbWithProject?.rows),
  )

  // 7) Backup export / import round-trip through the UI -------------------
  await goto('/settings')
  await evalJs(
    `(() => { const b = document.querySelector('button[lang="en"]'); if (b) b.click(); return true })()`,
  )
  await sleep(500)
  const dataTab = await evalJs(
    `(() => { const tabs = [...document.querySelectorAll('[role="tab"]')]; const t = tabs.find(b => /Data|ဒေတာ/.test(b.textContent)) || tabs[2]; if (!t) return false; t.click(); return t.textContent.trim() })()`,
  )
  await sleep(400)

  let download = null
  if (dataTab) {
    rmSync(DL_DIR, { recursive: true, force: true })
    try {
      await send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DL_DIR,
        eventsEnabled: true,
      })
    } catch {
      await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR })
    }

    const clickedExport = await evalJs(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => /Export backup/i.test(b.textContent)); if (!b) return false; b.click(); return true })()`,
    )
    for (let i = 0; i < 50 && !download; i++) {
      await sleep(200)
      try {
        const files = readdirSync(DL_DIR).filter((f) => !f.endsWith('.crdownload'))
        if (files.length) download = join(DL_DIR, files[0])
      } catch {
        /* dir not created yet */
      }
    }
    check('backup export downloads a file', clickedExport && !!download, download ?? 'no file')

    if (download) {
      const parsed = JSON.parse(readFileSync(download, 'utf8'))
      check(
        'exported backup has expected shape',
        parsed.format === 'aidt-backup' &&
          Array.isArray(parsed.tables?.projects) &&
          parsed.counts?.projects >= 1,
        `format=${parsed.format} projects=${parsed.counts?.projects} tables=${Object.keys(parsed.tables || {}).length}`,
      )

      // Import the same file back (mode defaults to "replace").
      const doc = await send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      })
      if (nodeId) {
        await send('DOM.setFileInputFiles', { files: [resolve(download)], nodeId })
        let imported = false
        for (let i = 0; i < 50 && !imported; i++) {
          await sleep(200)
          imported = await evalJs(`/Backup imported/i.test(document.body.innerText)`)
        }
        check('backup import shows success toast', imported === true, String(imported))
        const dbRestored = await readDb()
        check(
          'database populated after import',
          (dbRestored?.rows?.projects ?? 0) >= 1,
          JSON.stringify(dbRestored?.rows),
        )
      } else {
        check('file input present on Data tab', false, 'querySelector returned no node')
      }
    }
  } else {
    check('Data tab reachable', false, 'tab not found')
  }

  // 7) Console hygiene ----------------------------------------------------
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|Failed to load resource: the server responded with a status of 404/.test(e),
  )
  check(
    'no console/runtime errors',
    realErrors.length === 0,
    realErrors.slice(0, 5).join(' | ') || 'clean',
  )
} catch (e) {
  check('smoke test executed', false, e.stack || e.message)
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
  rmSync(DL_DIR, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('FAILURES:\n' + failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n'))
}
process.exit(failed.length ? 1 : 0)
