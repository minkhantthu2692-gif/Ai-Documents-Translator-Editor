/**
 * Live workspace probe — imports a real PDF, translates it with a real key,
 * screenshots the page and exports the result.
 *
 * Two questions it answers that unit tests cannot:
 *
 *  1. "The page shows square blocks at full size." The workspace composes a
 *     pdf.js raster with a DOM text layer on top; they fail differently, so
 *     each pane is screenshotted on its own after a real Burmese translation
 *     puts Myanmar glyphs through the actual font stack.
 *  2. "Can I get a translated file to test the result?" — the run ends with a
 *     real export and prints its path.
 *
 * Requires: `npm run dev` on :5173 and `GROQ_KEY1` in the environment.
 *
 * Usage: node scripts/diagnose-render.mjs [path/to.pdf]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9445
const BASE = 'http://localhost:5173'
const PDF = resolve(
  process.argv[2] ?? 'C:\\Users\\minkh\\Downloads\\Telegram Desktop\\HSS_Exam_Study_Notes.pdf',
)
const GROQ_KEY = process.env.GROQ_KEY1 ?? ''
/**
 * Groq's free tier parks a run when the daily window is spent. The queue
 * auto-resumes, so the default wait is long enough to ride one out — raise it
 * (ms) with TRANSLATE_WAIT_MS for a document that has to cross a reset.
 */
const TRANSLATE_WAIT_MS = Number(process.env.TRANSLATE_WAIT_MS ?? 2700000)
/** `RENDER_ONLY=1` stops after the original-pane screenshot (no API spend). */
const RENDER_ONLY = process.env.RENDER_ONLY === '1'
const OUT = join(tmpdir(), 'aidt-render')
const DL_DIR = join(tmpdir(), 'aidt-render-dl')
mkdirSync(OUT, { recursive: true })

const log = (line) => console.log(line)

let ws = null
const profile = join(tmpdir(), `aidt-chrome-render-${Date.now()}`)
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
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=1440,1200',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

try {
  if (!GROQ_KEY) throw new Error('set GROQ_KEY1 first')

  let targets
  for (let i = 0; i < 60; i += 1) {
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
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(`${msg.method ?? msg.id}: ${msg.error.message}`))
      else res(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const callId = ++id
      pending.set(callId, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: callId, method, params }))
    })

  for (const domain of ['Page', 'Runtime', 'Log', 'DOM']) await send(`${domain}.enable`)

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
    }
    return r.result.value
  }

  const goto = async (path) => {
    await send('Page.navigate', { url: BASE + path })
    for (let i = 0; i < 180; i += 1) {
      const state = await evalJs(
        `JSON.stringify({ready: document.readyState, welcome: !!document.querySelector('[data-testid="welcome-get-started"]'), n: document.querySelector('#main-content')?.childElementCount ?? -1})`,
      )
      const parsed = typeof state === 'string' ? JSON.parse(state) : state
      if (parsed?.welcome) {
        await evalJs(`document.querySelector('[data-testid="welcome-get-started"]')?.click()`)
        await sleep(400)
        await send('Page.navigate', { url: BASE + path })
        continue
      }
      if (parsed?.ready === 'complete' && parsed.n > 0) {
        await sleep(200)
        return
      }
      await sleep(100)
    }
    throw new Error('render timeout for ' + path)
  }

  const waitFor = async (expression, timeoutMs = 60000) => {
    for (let waited = 0; waited < timeoutMs; waited += 150) {
      let value = null
      try {
        value = await evalJs(expression)
      } catch {
        /* navigating */
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

  const setNative = (selector, value, tag = 'HTMLInputElement') =>
    evalJs(
      `(() => {
        const el = document.querySelector('${selector}')
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(window.${tag}.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`,
    )

  const attachFile = async (path) => {
    const doc = await send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[data-testid="file-input"]',
    })
    if (!nodeId) throw new Error('file input not found')
    await send('DOM.setFileInputFiles', { files: [path], nodeId })
  }

  /** Screenshot one element (or the viewport) to `OUT/<name>.png`. */
  const shoot = async (name, selector = null) => {
    let clip
    if (selector) {
      await evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: 'start', inline: 'start' }); return !!el })()`,
      )
      await sleep(400)
      const doc = await send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      })
      if (!nodeId) {
        log(`MISSING ELEMENT ${selector}`)
        return null
      }
      const { model } = await send('DOM.getBoxModel', { nodeId })
      const quad = model.border
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      clip = {
        x: Math.max(0, Math.min(...xs)),
        y: Math.max(0, Math.min(...ys)),
        width: Math.max(1, Math.max(...xs) - Math.max(0, Math.min(...xs))),
        height: Math.max(1, Math.max(...ys) - Math.max(0, Math.min(...ys))),
        scale: 1,
      }
    }
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    })
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    log(`shot  ${file}${clip ? ` (${Math.round(clip.width)}x${Math.round(clip.height)})` : ''}`)
    return file
  }

  const zoomIn = async (times) => {
    for (let i = 0; i < times; i += 1) {
      await evalJs(
        `(() => {
          const el = [...document.querySelectorAll('button[aria-label]')].find(b => /^zoom in/i.test(b.getAttribute('aria-label')))
          if (!el) return false
          el.click(); return true
        })()`,
      )
      await sleep(150)
    }
  }

  /**
   * Font + block dump: what the DOM text layer is really painting with.
   *
   * `document.fonts.check` reports false whenever a family is split by
   * unicode-range and any subset is still unloaded, so it cannot answer "did
   * the Myanmar face actually load". The canvas widths do: if measuring the
   * sample under `Noto Sans Myanmar` gives a different width than bare
   * `sans-serif` (and than a deliberately missing family), a webfont really did
   * load and is what paints the glyphs — equal widths mean the browser fell
   * back to a system font, which is squares wherever it has no Myanmar glyphs.
   */
  const probeText = async (label) => {
    const info = await evalJs(
      `(() => {
        const pane = document.querySelector('[data-testid="pane-translated"]')
        const els = pane ? [...pane.querySelectorAll('[style*="font-family"]')] : []
        const sample = els.slice(0, 3).map(el => {
          const cs = getComputedStyle(el)
          return { family: cs.fontFamily.slice(0, 90), weight: cs.fontWeight, text: (el.textContent || '').slice(0, 45), mm: (el.textContent || '').match(/[\\u1000-\\u109F]/g)?.length ?? 0 }
        })
        const mmSample = els.find(el => /[\\u1000-\\u109F]/.test(el.textContent || ''))
        const check = mmSample
          ? {
              myanmar: document.fonts.check('16px "Noto Sans Myanmar"', 'မ င တ က'),
              padauk: document.fonts.check('16px "Padauk"', 'မ င တ က'),
              families: getComputedStyle(mmSample).fontFamily.slice(0, 120),
              widths: (() => {
                const ctx = document.createElement('canvas').getContext('2d')
                const text = 'မမမမ မင်တကောင် ၁၂၃'
                const measure = (family) => {
                  ctx.font = '40px ' + family
                  return Math.round(ctx.measureText(text).width)
                }
                return {
                  stack: measure('"Noto Sans Myanmar", sans-serif'),
                  noto: measure('"Noto Sans Myanmar"'),
                  padauk: measure('"Padauk"'),
                  bare: measure('sans-serif'),
                  missing: measure('"No Such Family 123"'),
                }
              })(),
            }
          : null
        return { blocks: els.length, sample, check, mmTextBlocks: els.filter(el => /[\\u1000-\\u109F]/.test(el.textContent || '')).length }
      })()`,
    )
    log(`${label} ` + JSON.stringify(info, null, 2))
    return info
  }

  log(`PDF   ${PDF}`)

  // --- 1. a real key unblocks Start and lets translation actually run ------
  await goto('/settings?tab=providers')
  await evalJs(
    `(() => { const el = [...document.querySelectorAll('button')].find(b => /english/i.test(b.textContent || '')); if (el) el.click(); return true })()`,
  )
  await sleep(300)
  await waitFor(`!!document.querySelector('[data-testid="new-secret-groq"]')`, 20000)
  await setNative('[data-testid="new-secret-groq"]', GROQ_KEY)
  await sleep(200)
  await setNative('[data-testid="new-nickname-groq"]', 'Live probe key')
  await sleep(200)
  await click('[data-testid="add-key-groq"]')
  log(
    `groq key stored: ${await waitFor(`!!document.querySelector('[data-testid="key-masked"]')`, 20000)}`,
  )

  // --- 2. import + analyse + start ----------------------------------------
  await goto('/projects/new')
  await attachFile(PDF)
  await waitFor(`document.querySelectorAll('[data-testid="file-row"]').length`, 20000)
  await waitFor(
    `(() => { const el = document.querySelector('[data-testid="wizard-next"]:not([disabled])'); return !!el })()`,
    30000,
  )
  await click('[data-testid="wizard-next"]')
  const analyzed = await waitFor(
    `!!document.querySelector('[data-testid="metadata-table"]') && !!document.querySelector('[data-testid="check-integrity"]')`,
    180000,
  )
  log(`analyzed: ${analyzed}`)
  for (let step = 0; step < 4; step += 1) {
    const started = await waitFor(
      `!!(document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])'))`,
      2000,
    )
    if (started) break
    const ready = await waitFor(
      `!!document.querySelector('[data-testid="wizard-next"]:not([disabled])')`,
      4000,
    )
    if (!ready) break
    await click('[data-testid="wizard-next"]')
    await sleep(500)
  }
  const startReady = await waitFor(
    `!!(document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])'))`,
    20000,
  )
  if (!startReady) {
    // A big book trips the free-tier quota estimate. Its fix action narrows
    // the scope, which is all this render probe needs.
    const fixed = await waitFor(
      `(() => { const el = [...document.querySelectorAll('button,a')].find(b => /smaller batches/i.test(b.textContent || '')); if (!el) return false; el.click(); return true })()`,
      8000,
    )
    log(`applied reduce-scope fix: ${Boolean(fixed)}`)
    await sleep(2500)
  }
  const startReadyAfterFix = await waitFor(
    `!!(document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])'))`,
    20000,
  )
  if (!startReadyAfterFix) {
    log(
      'START STATE ' +
        JSON.stringify(
          await evalJs(
            `(() => ({
              hasWizardStart: !!document.querySelector('[data-testid="wizard-start"]'),
              hasStatusStart: !!document.querySelector('[data-testid="status-start"]'),
              disabled: [...document.querySelectorAll('[data-testid="wizard-start"],[data-testid="status-start"]')].map(e => e.disabled),
              blocked: [...document.querySelectorAll('[data-testid^="check-"]')].map(e => ({ id: e.getAttribute('data-testid'), text: (e.innerText || '').slice(0, 80) })),
              text: document.querySelector('#main-content')?.innerText?.slice(0, 1500),
            }))()`,
          ),
        ),
    )
    throw new Error('Start never enabled')
  }
  await evalJs(
    `(() => {
      const el = document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])')
      if (!el) return false
      el.click(); return true
    })()`,
  )
  const workspacePath = await waitFor(`/\\/workspace\\//.test(location.pathname)`, 30000)
  log(`workspace: ${workspacePath} ${await evalJs('location.pathname')}`)

  // --- 3. wait for the parse to finish, then look at the original pane -----
  await waitFor(`!!document.querySelector('[data-testid="pane-original"]')`, 30000)
  const parsed = await waitFor(
    `(() => {
      const el = document.querySelector('[data-testid="page-parse-progress"]')
      if (!el) return false
      const m = el.innerText.match(/(\\d+)\\s*\\/\\s*(\\d+)/)
      return m && Number(m[1]) === Number(m[2]) ? m[0] : false
    })()`,
    180000,
  )
  log(`parse: ${parsed}`)
  log(
    'panel ' +
      JSON.stringify(
        await evalJs(
          `(() => ({
            progress: document.querySelector('[data-testid="page-parse-progress"]')?.innerText ?? null,
            pause: !!document.querySelector('[data-testid="page-thumbs"] button') && [...document.querySelectorAll('[data-testid="page-thumbs"] header button')].map(b => b.textContent.trim()),
            complete: !!document.querySelector('[data-testid="page-parse-complete"]'),
          }))()`,
        ),
      ),
  )
  await waitFor(
    `(() => { const img = document.querySelector('[data-testid="pane-original"] img'); return !!img && img.complete && img.naturalWidth > 0 })()`,
    60000,
  )
  await click('[data-testid="view-original"]')
  await zoomIn(3)
  await sleep(1000)
  await shoot('original', '[data-testid="pane-original"]')

  // --- 4. translate for real (Groq) ---------------------------------------
  let translateHref = null
  if (!RENDER_ONLY) {
    translateHref = await evalJs(
      `(() => { const b = document.querySelector('[data-testid="open-translate"]'); const a = b ? b.closest('a') : null; return a ? a.getAttribute('href') : null })()`,
    )
    await goto(String(translateHref || '/translate/missing'))
    await waitFor(`!!document.querySelector('[data-testid="provider-select"]')`, 30000)
    await setNative('[data-testid="provider-select"]', 'groq', 'HTMLSelectElement')
    await sleep(600)
    await setNative('[data-testid="model-select"]', 'openai/gpt-oss-120b', 'HTMLSelectElement')
    await sleep(600)
    log(
      'config ' +
        JSON.stringify(
          await evalJs(
            `(() => ({
            provider: document.querySelector('[data-testid="provider-select"]')?.value,
            model: document.querySelector('[data-testid="model-select"]')?.value,
            source: document.querySelector('[data-testid="source-language"]')?.value,
            target: document.querySelector('[data-testid="target-language"]')?.value,
          }))()`,
          ),
        ),
    )
    const runStart = Date.now()
    await click('[data-testid="status-start"]')
    const done = await waitFor(
      `!!document.querySelector('[data-testid="translate-done-banner"]')`,
      TRANSLATE_WAIT_MS,
    )
    const failure = await evalJs(
      `document.querySelector('[data-testid="failure-banner"]')?.innerText ?? null`,
    )
    log(
      `translate done=${Boolean(done)} in ${Math.round((Date.now() - runStart) / 1000)}s failure=${failure}`,
    )
    if (!done) {
      log(
        'STATUS ' +
          String(
            await evalJs(`document.querySelector('[data-testid="translate-status"]')?.innerText`),
          ),
      )
      log(
        'PROGRESS ' +
          String(
            await evalJs(`document.querySelector('[data-testid="translate-progress"]')?.innerText`),
          ),
      )
    }

    // --- 5. back to the workspace: the Burmese text layer -------------------
    await goto(String(translateHref).replace('/translate/', '/workspace/'))
    await waitFor(`!!document.querySelector('[data-testid="pane-translated"]')`, 30000)
    await waitFor(`!!document.querySelector('[data-testid="pane-translated"] img')`, 60000)
    await sleep(1500)
    await click('[data-testid="view-translated"]')
    await zoomIn(3)
    await sleep(1200)
    const textInfo = await probeText('TEXT')
    await shoot('translated', '[data-testid="pane-translated"]')
    await shoot('viewport')

    // --- 6. export a file ----------------------------------------------------
    const file = await (async () => {
      try {
        mkdirSync(DL_DIR, { recursive: true })
      } catch {
        /* exists */
      }
      try {
        await send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: DL_DIR,
          eventsEnabled: true,
        })
      } catch {
        await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR })
      }
      await goto('/translate/' + String(translateHref).split('/translate/')[1])
      const exportOpen = await waitFor(
        `(() => { const el = document.querySelector('[data-testid="translate-export"]'); if (!el || el.disabled) return false; el.click(); return true })()`,
        20000,
      )
      if (!exportOpen) return null
      if (!(await waitFor(`!!document.querySelector('[data-testid="export-run"]')`, 20000)))
        return null
      log(
        'format ' +
          String(
            await evalJs(
              `document.querySelector('[data-testid^="export-format-"]')?.getAttribute('data-testid')`,
            ),
          ),
      )
      await click('[data-testid="export-run"]')
      for (let i = 0; i < 300; i += 1) {
        await sleep(200)
        try {
          const files = readdirSync(DL_DIR).filter((f) => !f.endsWith('.crdownload'))
          if (files.length) return join(DL_DIR, files[0])
        } catch {
          /* dir not created yet */
        }
      }
      return null
    })()
    log('EXPORT ' + (file ?? 'no file'))
    if (textInfo?.check) log('FONT CHECK ' + JSON.stringify(textInfo.check))
  } else {
    log('RENDER_ONLY: skipped translate/export')
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill()
}
