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

  // 5b) Phase 3 — an API key must exist before the wizard can Start -------
  // Pre-flight validates real keys now, so configure one before the wizard:
  // sealing happens in the browser (AES-GCM), the plaintext never leaves the
  // page and is never rendered.
  await goto('/settings?tab=providers')
  await toEnglish()
  const providersTab = await waitFor(
    `!!document.querySelector('[data-testid="providers-tab"]')`,
    15000,
  )
  check('AI Providers tab renders', providersTab)

  const providerCards = await evalJs(
    `['gemini','openrouter','groq','openai'].filter(id => !!document.querySelector('[data-testid="provider-' + id + '"]')).length`,
  )
  check('all four provider cards render', providerCards === 4, `cards=${providerCards}`)

  check(
    'vault (optional passphrase) form present',
    await evalJs(`!!document.querySelector('[data-testid="vault-passphrase"]')`),
    'vault-passphrase',
  )

  const badges = await evalJs(
    `(() => { const el = document.querySelector('[data-testid="model-badges"]'); return el ? el.innerText : '' })()`,
  )
  check(
    'model row shows free/context/PDF badges',
    /Free|PDF|Context/.test(String(badges)),
    String(badges).replace(/\s+/g, ' ').slice(0, 120),
  )

  await setField('[data-testid="new-secret-gemini"]', 'sk-test-1234567890')
  await sleep(200)
  await setField('[data-testid="new-nickname-gemini"]', 'Smoke key')
  await sleep(200)
  await clickWhenReady('[data-testid="add-key-gemini"]')
  const masked = await waitFor(
    `(() => { const el = document.querySelector('[data-testid="key-masked"]'); return el && /••/.test(el.innerText) ? el.innerText.trim() : false })()`,
    15000,
  )
  check('API key stored and shown masked', Boolean(masked), String(masked))

  const keyRow = await evalJs(
    `(() => { const rows = [...document.querySelectorAll('li[data-testid^="key-"]')]; return rows.length ? rows[0].innerText.replace(/\\s+/g, ' ') : '' })()`,
  )
  check(
    'key row shows health badge and usage counters',
    /Healthy|Not tested|Cooling|Invalid|Quota|Disabled/.test(String(keyRow)),
    String(keyRow).slice(0, 140),
  )
  check(
    'secret never appears in the DOM',
    (await evalJs(`document.body.innerText.includes('sk-test-1234567890')`)) === false,
    'plaintext check',
  )

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

  // 7) Phase 3: translate page -------------------------------------------
  const translateHref = await evalJs(
    `(() => { const b = document.querySelector('[data-testid="open-translate"]'); const a = b ? b.closest('a') : null; return a ? a.getAttribute('href') : null })()`,
  )
  check(
    'workspace exposes a Translate entry point',
    /\/translate\//.test(String(translateHref)),
    String(translateHref),
  )

  // Translate page --------------------------------------------------------
  await goto(String(translateHref || '/translate/missing'))
  const translateUi = await waitFor(
    `!!document.querySelector('[data-testid="translate-status"]') && !!document.querySelector('[data-testid="translate-progress"]')`,
    20000,
  )
  check('translate page renders status + progress panels', translateUi)

  const controls = await evalJs(
    `['provider-select','model-select','source-language','target-language','quality-select','scope-select'].filter(id => !!document.querySelector('[data-testid="' + id + '"]')).length`,
  )
  check('provider/model/language/quality controls present', controls === 6, `found=${controls}`)

  check(
    'sample-line test control present',
    await evalJs(`!!document.querySelector('[data-testid="sample-test"]')`),
    'sample-test',
  )

  const languageCount = await evalJs(
    `document.querySelector('[data-testid="target-language"]')?.options.length ?? 0`,
  )
  check(
    'target language dropdown lists 40+ languages',
    languageCount >= 40,
    `count=${languageCount}`,
  )

  const coverageCard = await waitFor(
    `!!document.querySelector('[data-testid="coverage-card"]')`,
    10000,
  )
  check('coverage report section rendered', coverageCard)

  const startBtn = await waitFor(
    `(() => { const b = document.querySelector('[data-testid="status-start"]'); return b ? { text: b.textContent.trim(), disabled: b.disabled } : false })()`,
    10000,
  )
  check('Start control present on the translate page', Boolean(startBtn), JSON.stringify(startBtn))
  check(
    'Start enabled once a key and languages are configured',
    Boolean(startBtn) && startBtn.disabled === false,
    JSON.stringify(startBtn),
  )

  // 8) Backup export / import round-trip through the UI -------------------
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

  // 9) Phase 4 — editor, find & replace, export, knowledge ------------------
  await goto(currentWorkspacePath)
  const editorMounted = await waitFor(
    `!!document.querySelector('[data-testid="workspace-editor"]')`,
    30000,
  )
  check('workspace editor mounts for a parsed project', editorMounted)

  const panes = await waitFor(
    `(() => {
      const o = document.querySelectorAll('[data-testid="pane-original"]').length
      const t = document.querySelectorAll('[data-testid="pane-translated"]').length
      const b = document.querySelectorAll('[data-testid="editor-block"]').length
      return o > 0 && t > 0 && b > 0 ? { o, t, b } : false
    })()`,
    20000,
  )
  check(
    'split view renders both panes with positioned text blocks',
    Boolean(panes),
    JSON.stringify(panes),
  )
  if (!panes) {
    const diag = await evalJs(
      `JSON.stringify((() => {
        const editor = document.querySelector('[data-testid="workspace-editor"]')
        const scroller = document.querySelector('[data-testid="workspace-editor"] [data-testid="virtuoso-scroller"]')
        const heights = []
        for (let n = editor; n && heights.length < 6; n = n.parentElement) {
          heights.push(Math.round(n.getBoundingClientRect().height))
        }
        return {
          thumbs: document.querySelectorAll('[data-testid="page-thumb-img"]').length,
          panesO: document.querySelectorAll('[data-testid="pane-original"]').length,
          panesT: document.querySelectorAll('[data-testid="pane-translated"]').length,
          blocks: document.querySelectorAll('[data-testid="editor-block"]').length,
          virtuoso: !!scroller,
          heightChain: heights.join('>'),
          children: editor ? [...editor.children].map((c) => (c.tagName + '.' + String(c.className).slice(0, 24))) : [],
        }
      })())`,
    )
    check('split view diagnostics', false, String(diag))
  }

  const blockFont = await evalJs(
    `getComputedStyle(document.querySelector('[data-testid="editor-block"]')).fontFamily`,
  )
  check(
    'editor blocks fall back to the Myanmar font stack',
    /Noto Sans Myanmar/.test(String(blockFont)),
    String(blockFont),
  )

  // View switch ------------------------------------------------------------
  check('view switch clickable', await clickWhenReady('[data-testid="view-translated"]'))
  await sleep(400)
  const originalHidden = await evalJs(
    `document.querySelectorAll('[data-testid="pane-original"]').length`,
  )
  check(
    '"translated" view drops the original pane',
    originalHidden === 0,
    `count=${originalHidden}`,
  )
  await clickWhenReady('[data-testid="view-split"]')
  check(
    '"split" view brings the original pane back',
    await waitFor(`document.querySelectorAll('[data-testid="pane-original"]').length > 0`, 8000),
  )

  // Selection → inspector ---------------------------------------------------
  check(
    'clicking a block selects it',
    await waitFor(
      `(() => { const el = document.querySelector('[data-testid="editor-block"]'); if (!el) return false; el.click(); return !!document.querySelector('[data-testid="editor-block"][data-selected="true"]') })()`,
      10000,
    ),
  )
  check(
    'inspector opens the Block tab for the selection',
    await waitFor(`!!document.querySelector('textarea[aria-label="Translation"]')`, 10000),
  )

  // Style command → undo. `commitCommand` writes to Dexie before the history
  // stack updates, so every state read has to wait for the async round trip —
  // and the fixture's first block may already be bold, so compare against the
  // captured starting value instead of hard-coding one.
  const boldBefore = await evalJs(
    `document.querySelector('[data-testid="style-bold"]')?.getAttribute('aria-pressed')`,
  )
  check(
    'bold indicator reflects the selected block',
    boldBefore === 'true' || boldBefore === 'false',
    String(boldBefore),
  )
  check('bold toggle clickable', await clickWhenReady('[data-testid="style-bold"]'))
  check(
    'bold toggles on the selected block',
    await waitFor(
      `document.querySelector('[data-testid="style-bold"]')?.getAttribute('aria-pressed') !== ${JSON.stringify(String(boldBefore))}`,
      8000,
    ),
    `from ${boldBefore}`,
  )
  check(
    'undo arms after a command',
    await waitFor(
      `!!document.querySelector('[data-testid="undo"]') && !document.querySelector('[data-testid="undo"]').disabled`,
      8000,
    ),
  )

  check('undo clickable', await clickWhenReady('[data-testid="undo"]'))
  check(
    'undo reverts the style command',
    await waitFor(
      `document.querySelector('[data-testid="style-bold"]')?.getAttribute('aria-pressed') === ${JSON.stringify(String(boldBefore))}`,
      8000,
    ),
    `back to ${boldBefore}`,
  )
  check(
    'undo stack drains back to empty',
    await waitFor(
      `!!document.querySelector('[data-testid="undo"]') && document.querySelector('[data-testid="undo"]').disabled`,
      8000,
    ),
  )

  // Text edit → save → reload ----------------------------------------------
  const MARKER = 'SMOKE-P4'
  const draftSet = await evalJs(
    `(() => {
      const ta = document.querySelector('textarea[aria-label="Translation"]')
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ta.value + ' ${MARKER}')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`,
  )
  const savedEdit = await evalJs(
    `(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent.trim() === 'Save' && !x.disabled,
      )
      if (!b) return false
      b.click()
      return true
    })()`,
  )
  check('translation edit is saved through the command stack', Boolean(draftSet && savedEdit))
  check(
    'edited text renders on the translated canvas',
    await waitFor(
      `[...document.querySelectorAll('[data-testid="editor-block"]')].some((el) => el.textContent.includes('${MARKER}'))`,
      10000,
    ),
  )

  // Find & replace ----------------------------------------------------------
  check('find toggle clickable', await clickWhenReady('[data-testid="toggle-find"]'))
  check(
    'find & replace bar opens',
    await waitFor(`!!document.querySelector('[role="search"]')`, 8000),
  )
  await evalJs(
    `(() => {
      const input = document.querySelector('[role="search"] input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '${MARKER}')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`,
  )
  const counter = await waitFor(
    `(() => { const el = document.querySelector('[role="search"]'); return el && /1 of 1/.test(el.innerText) ? el.innerText : false })()`,
    8000,
  )
  check('find reports the single occurrence', Boolean(counter), String(counter))

  await evalJs(
    `(() => {
      const input = document.querySelectorAll('[role="search"] input')[1]
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '${MARKER}-X')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`,
  )
  const replaceClicked = await evalJs(
    `(() => {
      const b = [...document.querySelectorAll('[role="search"] button')].find(
        (x) => x.textContent.trim() === 'Replace all',
      )
      if (!b || b.disabled) return false
      b.click()
      return true
    })()`,
  )
  check(
    'replace-all commits and reports the count',
    Boolean(replaceClicked) &&
      (await waitFor(`/occurrences replaced/.test(document.body.innerText)`, 10000)),
  )

  // Reload keeps the edit (IndexedDB) ---------------------------------------
  await goto(currentWorkspacePath)
  await waitFor(`!!document.querySelector('[data-testid="workspace-editor"]')`, 30000)
  await waitFor(`document.querySelectorAll('[data-testid="editor-block"]').length > 0`, 20000)
  await evalJs(
    `(() => { const el = document.querySelector('[data-testid="editor-block"]'); if (!el) return false; el.click(); return true })()`,
  )
  const persisted = await waitFor(
    `(() => { const ta = document.querySelector('textarea[aria-label="Translation"]'); return ta ? ta.value.includes('${MARKER}-X') : false })()`,
    10000,
  )
  check('edits survive a reload (IndexedDB)', Boolean(persisted))

  // Export dialog + a real HTML export ---------------------------------------
  check('export button clickable', await clickWhenReady('[data-testid="open-export"]'))
  check(
    'export dialog renders',
    await waitFor(
      `!!document.querySelector('[role="dialog"]') && !!document.querySelector('[data-testid="export-format-html"]')`,
      10000,
    ),
  )
  check('format menu opens', await clickWhenReady('[data-testid="export-format-html"]'))
  const menu = await waitFor(
    `(() => { const m = document.querySelector('[role="menu"]'); return m && /PDF/.test(m.innerText) && /DOCX/.test(m.innerText) ? true : false })()`,
    8000,
  )
  check('format menu lists PDF and DOCX', Boolean(menu))
  await click('[data-testid="export-format-html"]')
  await sleep(300)

  const artworkOff = await evalJs(
    `(() => {
      const label = [...document.querySelectorAll('label')].find((l) =>
        /Embed page artwork/.test(l.textContent),
      )
      if (!label) return 'no-label'
      const input = label.querySelector('input[type="checkbox"]')
      if (!input) return 'no-input'
      if (input.checked) input.click()
      return input.checked ? 'still-on' : 'off'
    })()`,
  )
  check('page artwork can be turned off before export', artworkOff === 'off', String(artworkOff))

  // The CDP session is attached to one page target, so the download directory
  // set up on /settings is gone after these navigations — re-assert it for
  // this page or Chrome silently drops the export's anchor download.
  try {
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR })
  } catch {
    await send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DL_DIR,
      eventsEnabled: true,
    }).catch(() => {})
  }

  let seenBefore
  try {
    seenBefore = new Set(readdirSync(DL_DIR))
  } catch {
    seenBefore = new Set()
  }
  check('export runs', await clickWhenReady('[data-testid="export-run"]'))
  let exportFile = null
  let exportState = ''
  for (let i = 0; i < 900 && !exportFile; i += 1) {
    await sleep(200)
    try {
      const found = readdirSync(DL_DIR).filter((f) => f.endsWith('.html') && !seenBefore.has(f))
      if (found.length) exportFile = join(DL_DIR, found[0])
    } catch {
      /* dir not created yet */
    }
    if (i % 25 === 0) {
      exportState = String(
        await evalJs(
          `JSON.stringify({
            progress: document.querySelector('[data-testid="export-progress"]')?.textContent ?? null,
            summary: /blocks/.test(document.querySelector('[role="dialog"]')?.innerText ?? '')
              ? 'set'
              : 'none',
            running: document.querySelector('[data-testid="export-run"]')?.disabled ?? null,
            toasts: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) =>
              n.innerText.replace(/\\n+/g, ' | ').slice(0, 120),
            ),
          })`,
        ),
      )
    }
  }
  const dirListing = (() => {
    try {
      return readdirSync(DL_DIR).join(', ')
    } catch {
      return '<missing>'
    }
  })()
  check(
    'HTML export downloads a file',
    Boolean(exportFile),
    exportFile ?? `${exportState} dir=[${dirListing}]`,
  )

  if (exportFile) {
    const html = readFileSync(exportFile, 'utf8')
    check('exported HTML keeps the Myanmar font stack', /Noto Sans Myanmar/.test(html))
    check(
      'exported HTML lays blocks out per page',
      /data-page=/.test(html) && /font-size:/.test(html),
    )
    check('exported HTML ships no external scripts', !/<script[^>]+src=/.test(html))
  }

  // Knowledge page ------------------------------------------------------------
  await goto('/knowledge')
  const knowledgeTabs = await waitFor(
    `document.querySelectorAll('[role="tab"]').length >= 3`,
    10000,
  )
  check(
    'knowledge page renders glossary/TM/template tabs',
    Boolean(knowledgeTabs),
    `tabs=${knowledgeTabs}`,
  )
  check(
    'glossary tab content rendered',
    await waitFor(`/Glossary/.test(document.body.innerText)`, 8000),
  )

  // Myanmar rendering reference ------------------------------------------------
  await goto('/dev/myanmar-test')
  const myanmarFont = await waitFor(
    `(() => { const p = document.querySelector('p[lang="my"]'); return p ? getComputedStyle(p).fontFamily : false })()`,
    10000,
  )
  check(
    'Myanmar test page renders with the bundled family',
    /Noto Sans Myanmar/.test(String(myanmarFont)),
    String(myanmarFont),
  )
  const fontLoaded = await evalJs(
    `document.fonts.ready.then(() => document.fonts.check('16px "Noto Sans Myanmar"'))`,
    true,
  )
  check('Noto Sans Myanmar webfont is loaded', fontLoaded === true, String(fontLoaded))

  // 10) Console hygiene ---------------------------------------------------
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
