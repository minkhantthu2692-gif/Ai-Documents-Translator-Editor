/* global AbortController, Buffer, URL, clearTimeout, console, fetch, process, setTimeout */

import { fileURLToPath } from 'node:url'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { rateLimit } from 'express-rate-limit'

// Load proxy/.env from next to this file (not from the process working directory),
// so `node server.js` works whether it is started inside proxy/ or from the repo root.
dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)) })

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const APP_REPO_URL = 'https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor'
const APP_TITLE = 'AI Documents Translator Assistant'
const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']
const ACTION_KINDS = ['retry', 'config', 'data', 'navigation']

const MAX_QUESTION_CHARS = 4000
const MAX_CONTEXT_BYTES = 24 * 1024
const MAX_PROMPT_CONTEXT_CHARS = 8000
const UPSTREAM_TIMEOUT_MS = 20 * 1000

const MODEL = (process.env.ASSISTANT_MODEL || '').trim() || DEFAULT_MODEL
const PORT = Number.parseInt(process.env.PORT || '8787', 10)

function getKey() {
  return (process.env.OPENROUTER_ASSISTANT_KEY || '').trim()
}

// ---------------------------------------------------------------------------
// Error envelope helpers
// ---------------------------------------------------------------------------

class UpstreamError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.code = code
  }
}

/**
 * Makes any outgoing message safe: collapses whitespace, removes the API key if it
 * somehow appears, and truncates to 300 characters so upstream bodies are never dumped.
 */
function safeMessage(raw, key) {
  let text = typeof raw === 'string' && raw ? raw : 'Unexpected error.'
  const secret = key || getKey()
  if (secret) text = text.split(secret).join('[redacted]')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > 300) text = `${text.slice(0, 297)}...`
  return text
}

function sendError(res, status, code, message, key) {
  return res.status(status).json({ ok: false, code, message: safeMessage(message, key) })
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(lang) {
  const languageInstruction =
    lang === 'my'
      ? 'Write the whole answer in Burmese using Myanmar script (မြန်မာဘာသာ).'
      : 'Write the whole answer in English.'
  return [
    'You are the built-in Troubleshooting Assistant of "AI Documents Translator & Editor", a local-first PDF translation web app.',
    'A non-programmer user sent a question plus diagnostic context such as an error code, stack trace, job state, provider/model, recent logs or browser info.',
    'Explain the most likely cause in plain language and give concrete fix steps.',
    languageInstruction,
    'Respond with ONLY one strict JSON object. No markdown, no code fences, no commentary before or after the JSON.',
    'Required shape: {"title": string, "explanation": string, "steps": string[], "actions": [{"id": string, "label": string, "kind": string}]}',
    'Rules:',
    '- "title": a short heading, at most 120 characters.',
    '- "explanation": 2 to 5 sentences of plain language that a non-programmer understands, at most 3000 characters.',
    '- "steps": 2 to 4 items. Each item is one concrete instruction sentence, at most 400 characters, that the user follows in order. The app renders the array as a numbered list, so do not include numbers or bullet markers inside the strings.',
    '- "actions": 0 to 3 items, at most 5. Each action has "id" (a short lowercase machine id using letters, digits or dashes), "label" (at most 60 characters) and "kind".',
    '- "kind" must be exactly one of: "retry" (try again or reload), "config" (change a setting), "data" (clear or reset data), "navigation" (open a screen or tab).',
    '- Base the answer on the provided context. If the context is empty, give generic safe next steps.',
    '- Never reveal, request or invent API keys, tokens or secrets.',
  ].join('\n')
}

const NO_FENCES_REMINDER =
  'Reminder: reply with the raw JSON object only. Do NOT wrap it in ``` code fences and do not add any text around it.'

function buildUserPrompt(question, lang, contextJson) {
  const context =
    contextJson.length > MAX_PROMPT_CONTEXT_CHARS
      ? `${contextJson.slice(0, MAX_PROMPT_CONTEXT_CHARS)}...[truncated]`
      : contextJson
  return [
    `Language code: ${lang} (${lang === 'my' ? 'Burmese, Myanmar script' : 'English'})`,
    `Question: ${question}`,
    `Diagnostic context (JSON): ${context}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// OpenRouter upstream call
// ---------------------------------------------------------------------------

function extractContent(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null
  const content = choice && choice.message ? choice.message.content : null
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

function upstreamErrorMessage(response, rawBody) {
  let detail = ''
  try {
    const payload = JSON.parse(rawBody)
    const candidate =
      payload && typeof payload === 'object' && payload.error ? payload.error.message : null
    if (typeof candidate === 'string') detail = candidate
  } catch {
    // Not a JSON body; fall back to the HTTP status only.
  }
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  return detail
    ? `Assistant service error (${status}): ${detail}`
    : `Assistant service error (${status}).`
}

async function requestCompletion(key, question, lang, contextJson, noFences) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const systemPrompt = buildSystemPrompt(lang) + (noFences ? `\n${NO_FENCES_REMINDER}` : '')
    const requestBody = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPrompt(question, lang, contextJson) },
      ],
      temperature: 0.2,
      // Headroom for Burmese (poorly tokenized) JSON, and reasoning disabled so
      // thinking tokens never eat the budget (they caused empty/truncated answers).
      max_tokens: 2000,
      reasoning: { enabled: false },
    }

    let response
    try {
      response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': APP_REPO_URL,
          'X-Title': APP_TITLE,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpstreamError(
          504,
          'TIMEOUT',
          'The assistant took too long to respond. Try again.',
        )
      }
      throw new UpstreamError(
        502,
        'UPSTREAM_ERROR',
        `Could not reach the assistant service: ${safeMessage(
          error instanceof Error ? error.message : String(error),
          key,
        )}`,
      )
    }

    let rawBody
    try {
      rawBody = await response.text()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpstreamError(
          504,
          'TIMEOUT',
          'The assistant took too long to respond. Try again.',
        )
      }
      throw new UpstreamError(
        502,
        'UPSTREAM_ERROR',
        `Could not read the assistant service response: ${safeMessage(
          error instanceof Error ? error.message : String(error),
          key,
        )}`,
      )
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new UpstreamError(
          429,
          'RATE_LIMITED',
          'The assistant service is rate-limiting the proxy. Wait a minute and try again.',
        )
      }
      throw new UpstreamError(502, 'UPSTREAM_ERROR', upstreamErrorMessage(response, rawBody))
    }

    let payload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      throw new UpstreamError(
        502,
        'UPSTREAM_ERROR',
        'The assistant service returned an unreadable response. Try again.',
      )
    }

    const content = extractContent(payload)
    if (!content) {
      throw new UpstreamError(
        502,
        'UPSTREAM_ERROR',
        'The assistant service returned an empty response. Try again.',
      )
    }
    return content
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Response parsing and normalization
// ---------------------------------------------------------------------------

function stripCodeFences(text) {
  return String(text)
    .replace(/```(?:json)?/gi, '')
    .trim()
}

function hasAnswerShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return (
    typeof value.title === 'string' ||
    typeof value.explanation === 'string' ||
    Array.isArray(value.steps) ||
    Array.isArray(value.actions)
  )
}

function parseModelJson(content) {
  const text = stripCodeFences(content)
  if (!text) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return hasAnswerShape(parsed) ? parsed : null
}

function asText(value, max) {
  if (typeof value === 'string') return value.trim().slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, max)
  return ''
}

function asSlug(value) {
  return asText(value, 60)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeAnswer(raw) {
  const explanation = asText(raw.explanation, 3000)
  const title = asText(raw.title, 120) || asText(explanation, 120) || 'Troubleshooting assistant'
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((step) => asText(step, 400))
    .filter((step) => step.length > 0)
    .slice(0, 6)
  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .filter((action) => action && typeof action === 'object')
    .slice(0, 5)
    .map((action, index) => ({
      id: asSlug(action.id) || `action-${index + 1}`,
      label: asText(action.label, 60) || 'Try this fix',
      kind:
        typeof action.kind === 'string' && ACTION_KINDS.includes(action.kind)
          ? action.kind
          : 'retry',
    }))
  return { title, explanation, steps, actions }
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function buildAllowedOrigins() {
  const allowed = new Set(DEFAULT_ORIGINS)
  for (const entry of (process.env.ALLOWED_ORIGIN || '').split(',')) {
    const origin = entry.trim().replace(/\/+$/, '')
    if (origin) allowed.add(origin)
  }
  return allowed
}

const allowedOrigins = buildAllowedOrigins()

const corsOptions = {
  // Non-browser clients (curl, tests) send no Origin header; allow them.
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  optionsSuccessStatus: 204,
  maxAge: 600,
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express()
app.disable('x-powered-by')

// Tiny stdout request log: method, path, status, duration. No bodies, headers or keys.
// Mounted first so even CORS preflights are logged.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint()
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    const path = (req.originalUrl || req.url || '/').split('?')[0]
    console.log(`${req.method} ${path} ${res.statusCode} ${durationMs.toFixed(1)}ms`)
  })
  next()
})

// Trust proxy only when explicitly configured (set TRUST_PROXY=1 behind Render/Railway/Fly)
// so per-IP rate limiting uses the real client IP without allowing header spoofing locally.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY || '0', 10)
app.set(
  'trust proxy',
  Number.isFinite(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : false,
)

app.use(cors(corsOptions))

// The cors middleware passes preflights from non-allowlisted origins through;
// answer them with the JSON envelope and no CORS headers so the browser blocks them.
app.options(['/assistant', '/', '/ask'], (req, res) => {
  sendError(res, 403, 'BAD_REQUEST', 'Origin is not allowed to call this proxy.')
})

app.get('/health', (req, res) => {
  res.json({ ok: true, hasKey: Boolean(getKey()), uptime: process.uptime() })
})

const assistantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    sendError(
      res,
      429,
      'RATE_LIMITED',
      'Too many assistant requests from this IP. Wait up to 15 minutes and try again.',
    )
  },
})

async function handleAssistant(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) {
    return sendError(
      res,
      400,
      'BAD_REQUEST',
      'Field "question" is required and must be a non-empty string.',
    )
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return sendError(
      res,
      400,
      'BAD_REQUEST',
      `Field "question" must be at most ${MAX_QUESTION_CHARS} characters.`,
    )
  }

  let contextJson = '{}'
  if (body.context !== undefined && body.context !== null) {
    if (typeof body.context !== 'object') {
      return sendError(res, 400, 'BAD_REQUEST', 'Field "context" must be a JSON object.')
    }
    try {
      contextJson = JSON.stringify(body.context)
    } catch {
      return sendError(res, 400, 'BAD_REQUEST', 'Field "context" must be JSON-serializable.')
    }
    if (Buffer.byteLength(contextJson, 'utf8') > MAX_CONTEXT_BYTES) {
      return sendError(res, 400, 'BAD_REQUEST', 'Field "context" must serialize to at most 24KB.')
    }
  }

  const lang = body.lang === 'my' ? 'my' : 'en'

  const key = getKey()
  if (!key) {
    return sendError(
      res,
      503,
      'MISSING_KEY',
      'Assistant key not configured on the proxy. Set OPENROUTER_ASSISTANT_KEY in proxy/.env.',
    )
  }

  try {
    const content = await requestCompletion(key, question, lang, contextJson, false)
    let answer = parseModelJson(content)
    if (!answer) {
      const retryContent = await requestCompletion(key, question, lang, contextJson, true)
      answer = parseModelJson(retryContent)
    }
    if (!answer) {
      return sendError(
        res,
        502,
        'UPSTREAM_ERROR',
        'The assistant returned an unreadable response. Try again.',
        key,
      )
    }
    return res.json({ ok: true, answer: normalizeAnswer(answer), model: MODEL })
  } catch (error) {
    if (error instanceof UpstreamError) {
      return sendError(res, error.status, error.code, error.message, key)
    }
    console.error(
      '[assistant-proxy] unexpected error:',
      error instanceof Error ? error.message : String(error),
    )
    return sendError(res, 500, 'INTERNAL', 'Unexpected proxy error. Check the proxy logs.', key)
  }
}

// JSON body parsing is mounted only on the assistant routes (32KB hard cap).
app.post(
  ['/assistant', '/', '/ask'],
  assistantLimiter,
  express.json({ limit: '32kb' }),
  handleAssistant,
)

app.use((req, res) => {
  sendError(
    res,
    404,
    'BAD_REQUEST',
    'Unknown route. Use POST /assistant (aliases: POST /, POST /ask) or GET /health.',
  )
})

// JSON error handler: preserves the envelope for oversized (413) and malformed (400) bodies.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  if ((err && err.type === 'entity.too.large') || (err && err.status === 413)) {
    return sendError(res, 413, 'BAD_REQUEST', 'Request body too large (32KB max).')
  }
  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'BAD_REQUEST', 'Request body must be valid JSON.')
  }
  console.error(
    '[assistant-proxy] handler error:',
    err instanceof Error ? err.message : String(err),
  )
  return sendError(res, 500, 'INTERNAL', 'Unexpected proxy error. Check the proxy logs.')
})

app.listen(PORT, () => {
  console.log(`[assistant-proxy] listening on http://127.0.0.1:${PORT}`)
  if (!getKey()) {
    console.warn(
      '[assistant-proxy] OPENROUTER_ASSISTANT_KEY is missing - POST /assistant will return 503 MISSING_KEY.',
    )
  }
})
