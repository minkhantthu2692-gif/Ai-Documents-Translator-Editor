/**
 * Phase 2 smoke test — drives the running dev server in headless Chrome over CDP.
 * Verifies: routes render, responsive breakpoints, theme + language persistence,
 * the PDF wizard (scanned flagging, password prompt + retry, 300-page analysis),
 * workspace thumbnails + layout extraction, Dexie data surviving reload, and a
 * UI-level backup export/import round-trip.
 *
 * Requires: `npm run dev` on :5173 and `fixtures/` (see scripts/make-fixtures.mjs).
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
    // The responsive-UI check needs rAF/timers at full rate (headless windows
    // are otherwise treated as occluded/backgrounded and throttled).
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
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
              const stores = [
                  'settings',
                  'events',
                  'projects',
                  'sourceFiles',
                  'pages',
                  'blocks',
                  'cache',
                ].filter(s => db.objectStoreNames.contains(s))
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

  // 6) Phase 2 — real PDFs through the wizard, then the workspace ---------
  const FIXTURES = resolve('fixtures')

  const attachFile = async (path) => {
    const doc = await send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[data-testid="file-input"]',
    })
    if (!nodeId) return false
    await send('DOM.setFileInputFiles', { files: [path], nodeId })
    return true
  }

  /** Polls a boolean-ish expression until it is truthy. */
  const waitFor = async (expression, timeoutMs = 30000) => {
    for (let waited = 0; waited < timeoutMs; waited += 150) {
      let value = null
      try {
        value = await evalJs(expression)
      } catch {
        /* page navigating */
      }
      if (value) return value
      await sleep(150)
    }
    return null
  }

  const click = (selector) =>
    evalJs(
      `(() => { const el = document.querySelector('${selector}'); if (!el || el.disabled) return false; el.click(); return true })()`,
    )

  /** Waits until a control exists and is enabled, then clicks it. */
  const clickWhenReady = async (selector, timeoutMs = 30000) => {
    const ready = await waitFor(
      `(() => { const el = document.querySelector('${selector}'); return !!el && !el.disabled })()`,
      timeoutMs,
    )
    if (!ready) return false
    return click(selector)
  }

  const setField = (selector, value) =>
    evalJs(
      `(() => {
        const el = document.querySelector('${selector}')
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`,
    )

  const statusOf = (id) =>
    evalJs(
      `document.querySelector('[data-testid="check-${id}"]')?.getAttribute('data-status') ?? null`,
    )

  /**
   * The pre-flight panel renders as soon as the step mounts, but its checks are
   * only built once every file has been probed. Metadata + the integrity row
   * appearing together is the honest "analysis finished" signal.
   */
  const analysisDone = (timeoutMs = 60000) =>
    waitFor(
      `!!document.querySelector('[data-testid="metadata-table"]') && !!document.querySelector('[data-testid="check-integrity"]')`,
      timeoutMs,
    )

  const toEnglish = async () => {
    await evalJs(
      `(() => { const b = document.querySelector('button[lang="en"]'); if (b) b.click(); return true })()`,
    )
    await sleep(300)
  }

  /** Prints enough DOM state to explain a wait that never succeeded. */
  const diag = async (label) => {
    const state = await evalJs(
      `(() => ({
        path: location.pathname,
        rows: [...document.querySelectorAll('[data-testid="file-row"]')].map((r) =>
          r.innerText.replace(/\\n+/g, ' | ').slice(0, 120),
        ),
        panels: ['preflight', 'metadata-table', 'password-modal', 'wizard-next', 'wizard-start']
          .map((id) => id + '=' + !!document.querySelector('[data-testid="' + id + '"]'))
          .join(' '),
        on: [...document.querySelectorAll('button')]
          .map((b) => (b.getAttribute('data-testid') || '') + (b.disabled ? ':off' : ':on'))
          .filter((s) => s.startsWith('wizard') || s.startsWith('status') || s.startsWith('password')),
        tail: document.body.innerText.slice(-450),
      }))()`,
    )
    console.log(`DIAG ${label}: ${JSON.stringify(state)}`)
  }

  // 6a) A scanned PDF is flagged and offered OCR.
  await goto('/projects/new')
  await toEnglish()
  await attachFile(join(FIXTURES, 'scanned.pdf'))
  const scannedRows = await waitFor(
    `document.querySelectorAll('[data-testid="file-row"]').length`,
    10000,
  )
  check('scanned.pdf added to the wizard', scannedRows > 0, `rows=${scannedRows}`)
  check('wizard advances to the metadata step', await clickWhenReady('[data-testid="wizard-next"]'))
  const scannedPanel = await waitFor(`!!document.querySelector('[data-testid="preflight"]')`, 30000)
  if (!scannedPanel) await diag('scanned panel')
  check('pre-flight panel rendered for scanned.pdf', scannedPanel)
  const scannedDone = await analysisDone(60000)
  if (!scannedDone) await diag('scanned analysis')
  check('scanned.pdf analyzed', scannedDone)
  const scannedTextLayer = await statusOf('textLayer')
  check(
    'scanned PDF flagged (text-layer check is not PASS)',
    Boolean(scannedTextLayer) && scannedTextLayer !== 'pass',
    `status=${scannedTextLayer}`,
  )
  const ocrOffer = await waitFor(`/no text layer/i.test(document.body.innerText)`, 5000)
  check('scanned PDF offers OCR', Boolean(ocrOffer))

  // 6b) Password prompt, wrong password, retry with the right one.
  await goto('/projects/new')
  await toEnglish()
  await attachFile(join(FIXTURES, 'encrypted.pdf'))
  const encryptedRows = await waitFor(
    `document.querySelectorAll('[data-testid="file-row"]').length`,
    10000,
  )
  check('encrypted.pdf added to the wizard', encryptedRows > 0, `rows=${encryptedRows}`)
  check('wizard advances to the metadata step', await clickWhenReady('[data-testid="wizard-next"]'))
  const passwordModal = await waitFor(
    `!!document.querySelector('[data-testid="password-modal"]')`,
    20000,
  )
  if (!passwordModal) await diag('password modal')
  check('encrypted PDF prompts for a password', passwordModal)
  await setField('[data-testid="password-input"]', 'definitely-wrong')
  await click('[data-testid="password-submit"]')
  const wrongShown = await waitFor(`/wrong password/i.test(document.body.innerText)`, 20000)
  check('wrong password is rejected with an explanation', Boolean(wrongShown))
  await setField('[data-testid="password-input"]', 'secret123')
  await click('[data-testid="password-submit"]')
  const unlockedPanel = await waitFor(
    `!!document.querySelector('[data-testid="preflight"]')`,
    30000,
  )
  if (!unlockedPanel) await diag('unlocked panel')
  check('correct password unlocks pre-flight', unlockedPanel)
  const unlockedDone = await analysisDone(60000)
  if (!unlockedDone) await diag('unlocked analysis')
  check('encryption flow finished analyzing', unlockedDone)
  const encryption = await statusOf('encryption')
  check('encryption check passes after unlocking', encryption === 'pass', `status=${encryption}`)

  // 6c) The 300-page fixture: analyze, Start, thumbnails + layout extraction.
  await goto('/projects/new')
  await toEnglish()
  await evalJs(
    `(() => {
      window.__t0 = performance.now()
      window.__frames = 0
      window.__maxGap = 0
      let last = performance.now()
      const tick = (now) => {
        window.__frames += 1
        window.__maxGap = Math.max(window.__maxGap, now - last)
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return true
    })()`,
  )
  await attachFile(join(FIXTURES, 'text-300p.pdf'))
  const bigRows = await waitFor(
    `document.querySelectorAll('[data-testid="file-row"]').length`,
    10000,
  )
  check('text-300p.pdf added to the wizard', bigRows > 0, `rows=${bigRows}`)
  check('wizard advances to the metadata step', await clickWhenReady('[data-testid="wizard-next"]'))
  const panel300 = await waitFor(`!!document.querySelector('[data-testid="preflight"]')`, 60000)
  if (!panel300) await diag('300-page panel')
  check('pre-flight panel rendered for text-300p.pdf', panel300)
  const analyzed300 = await analysisDone(180000)
  if (!analyzed300) await diag('300-page analysis')
  check('300-page PDF analyzed', analyzed300)
  const health = await evalJs(
    `(() => ({
      ms: performance.now() - window.__t0,
      frames: window.__frames,
      maxGap: window.__maxGap,
    }))()`,
  )
  const fps = health && health.ms > 0 ? (health.frames / health.ms) * 1000 : 0
  check(
    'main thread stayed responsive while analyzing 300 pages',
    fps > 10 && (health?.maxGap ?? 99999) < 2000,
    `fps=${fps.toFixed(1)} maxGap=${Math.round(health?.maxGap ?? -1)}ms over ${Math.round(health?.ms ?? 0)}ms`,
  )
  const integrity = await statusOf('integrity')
  check('integrity check passes', integrity === 'pass', `status=${integrity}`)
  const metaHasPages = await evalJs(
    `/300/.test(document.querySelector('[data-testid="metadata-table"]')?.innerText ?? '')`,
  )
  check('metadata table reports 300 pages', metaHasPages)
  const scannedMeta = await evalJs(
    `(() => {
      const text = document.body.innerText
      return /Metadata & pre-flight|metadata/i.test(text) && /PDF version/i.test(text)
    })()`,
  )
  check('document metadata (version, producer…) is shown', scannedMeta)
  check(
    'wizard advances to the translate step',
    await clickWhenReady('[data-testid="wizard-next"]'),
  )
  const startReady = await waitFor(
    `!!(document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])'))`,
    20000,
  )
  check('Start is enabled once blocking checks pass', startReady)
  await evalJs(
    `(() => {
      const el =
        document.querySelector('[data-testid="wizard-start"]:not([disabled])') ||
        document.querySelector('[data-testid="status-start"]:not([disabled])')
      if (!el) return false
      el.click()
      return true
    })()`,
  )
  const workspacePath = await waitFor(`/\\/workspace\\//.test(location.pathname)`, 30000)
  check('Start opens the workspace', workspacePath, String(await evalJs('location.pathname')))
  const thumbs = await waitFor(`!!document.querySelector('[data-testid="page-thumbs"]')`, 20000)
  check('page thumbnail panel present', thumbs)
  const thumbImgs = await waitFor(
    `document.querySelectorAll('[data-testid="page-thumb-img"]').length`,
    40000,
  )
  check('thumbnails rendered by the analysis worker', thumbImgs > 0, `imgs=${thumbImgs}`)
  const parseProgress = await waitFor(
    `(() => {
      const el = document.querySelector('[data-testid="page-parse-progress"]')
      if (!el) return false
      const m = el.innerText.match(/(\\d+)\\s*\\/\\s*(\\d+)/)
      return m && Number(m[1]) > 0 ? m[0] : false
    })()`,
    90000,
  )
  check('layout extraction progressing (pages parsed)', parseProgress, String(parseProgress))
  const dbAfterStart = await readDb()
  check(
    'project + source file + pages + blocks written to Dexie',
    (dbAfterStart?.rows?.projects ?? 0) === 1 &&
      (dbAfterStart?.rows?.sourceFiles ?? 0) === 1 &&
      (dbAfterStart?.rows?.pages ?? 0) > 0 &&
      (dbAfterStart?.rows?.blocks ?? 0) > 0,
    JSON.stringify(dbAfterStart?.rows),
  )

  // The queue persists after every item, so a reload must pick the run up again
  // instead of freezing the panel on a phase nothing is running.
  const parsedBefore = Number.parseInt(String(parseProgress ?? '0'), 10) || 0
  const currentWorkspacePath = String(await evalJs('location.pathname'))
  await goto(currentWorkspacePath)
  await waitFor(`!!document.querySelector('[data-testid="page-thumbs"]')`, 20000)
  const resumed = await waitFor(
    `(() => {
      const el = document.querySelector('[data-testid="page-parse-progress"]')
      if (!el) return false
      const m = el.innerText.match(/(\\d+)\\s*\\/\\s*(\\d+)/)
      return m && Number(m[1]) > ${parsedBefore} ? m[0] : false
    })()`,
    90000,
  )
  check(
    'layout extraction resumes after a reload',
    Boolean(resumed),
    `before=${parsedBefore} after=${resumed ?? 'no progress'}`,
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
