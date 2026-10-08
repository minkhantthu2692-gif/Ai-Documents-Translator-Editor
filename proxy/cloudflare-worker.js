/* global AbortController, Response, TextDecoder, TextEncoder, URL, clearTimeout, fetch, setTimeout */

/**
 * aidt-assistant-proxy — Cloudflare Worker implementation of the same contract as server.js.
 *
 * Dependency-free ES module Worker. Secrets are set with `wrangler secret put`, not in this file.
 *
 * wrangler.toml (create this next to the file if you deploy with wrangler; it is intentionally
 * not checked in — the snippet below is all you need):
 *
 *   name = "aidt-assistant-proxy"
 *   main = "cloudflare-worker.js"
 *   compatibility_date = "2026-10-01"
 *   [vars]
 *   ALLOWED_ORIGIN = "http://localhost:5173"
 *   ASSISTANT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
 *
 * Deploy:
 *   npx wrangler secret put OPENROUTER_ASSISTANT_KEY   # server-side only, never in the browser
 *   npx wrangler deploy
 *
 * Rate limiting is kept in an isolate-local in-memory Map: it resets whenever Cloudflare
 * restarts or replaces an isolate, and each isolate counts separately. Treat it as a
 * best-effort shield, not a billing guarantee. For a hard guarantee use Cloudflare's own
 * Rate Limiting binding or a durable store.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const APP_REPO_URL = 'https://github.com/minkhantthu2692-gif/Ai-Documents-Translator-Editor'
const APP_TITLE = 'AI Documents Translator Assistant'
const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']
const ACTION_KINDS = ['retry', 'config', 'data', 'navigation']
const ASSISTANT_PATHS = ['/', '/assistant', '/ask']

const MAX_BODY_BYTES = 32 * 1024
const MAX_QUESTION_CHARS = 4000
const MAX_CONTEXT_BYTES = 24 * 1024
const MAX_PROMPT_CONTEXT_CHARS = 8000
const UPSTREAM_TIMEOUT_MS = 20 * 1000
const RATE_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT = 20

const ISOLATE_STARTED_AT = Date.now()
/** @type {Map<string, { count: number, resetAt: number }>} isolate-local; resets on isolate restart. */
const rateBuckets = new Map()

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getAssistantKey(env) {
  return (env.OPENROUTER_ASSISTANT_KEY || '').trim()
}

function getModel(env) {
  return (env.ASSISTANT_MODEL || '').trim() || DEFAULT_MODEL
}

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function safeMessage(raw, key) {
  let text = typeof raw === 'string' && raw ? raw : 'Unexpected error.'
  if (key) text = text.split(key).join('[redacted]')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > 300) text = `${text.slice(0, 297)}...`
  return text
}

function json(data, status, headers) {
  const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) }
  return new Response(JSON.stringify(data), { status, headers: responseHeaders })
}

function errorBody(status, code, message, key) {
  return { ok: false, code, message: safeMessage(message, key) }
}

// ---------------------------------------------------------------------------
// CORS (same allowlist as server.js)
// ---------------------------------------------------------------------------

function buildAllowedOrigins(env) {
  const allowed = new Set(DEFAULT_ORIGINS)
  for (const entry of String(env.ALLOWED_ORIGIN || '').split(',')) {
    const origin = entry.trim().replace(/\/+$/, '')
    if (origin) allowed.add(origin)
  }
  return allowed
}

function corsHeaders(origin, env) {
  // No Origin header (curl, tests) is treated as same-origin and allowed through.
  if (!origin) return {}
  if (!buildAllowedOrigins(env).has(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

function handlePreflight(cors) {
  if (!cors) {
    return json(
      errorBody(403, 'BAD_REQUEST', 'Origin is not allowed to call this proxy.'),
      403,
      undefined,
    )
  }
  return new Response(null, { status: 204, headers: cors })
}

// ---------------------------------------------------------------------------
// Per-IP fixed-window rate limit (in-memory; see header note about isolate restarts)
// ---------------------------------------------------------------------------

function pruneRateBuckets(now) {
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(ip)
  }
  if (rateBuckets.size > 10000) rateBuckets.clear()
}

function checkRateLimit(ip, now = Date.now()) {
  let bucket = rateBuckets.get(ip)
  if (!bucket || bucket.resetAt <= now) {
    pruneRateBuckets(now)
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS }
    rateBuckets.set(ip, bucket)
  }
  bucket.count += 1
  return {
    allowed: bucket.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - bucket.count),
    resetSeconds: Math.max(0, Math.ceil((bucket.resetAt - now) / 1000)),
  }
}

function rateLimitHeaders(result) {
  return {
    'RateLimit-Limit': String(RATE_LIMIT),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(result.resetSeconds),
  }
}

// ---------------------------------------------------------------------------
// Prompt building (identical wording to server.js)
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
// Response parsing and normalization (identical rules to server.js)
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
// Upstream call
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

async function requestCompletion(env, key, question, lang, contextJson, noFences) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const systemPrompt = buildSystemPrompt(lang) + (noFences ? `\n${NO_FENCES_REMINDER}` : '')
    const requestBody = {
      model: getModel(env),
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
        throw new HttpError(504, 'TIMEOUT', 'The assistant took too long to respond. Try again.')
      }
      throw new HttpError(
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
        throw new HttpError(504, 'TIMEOUT', 'The assistant took too long to respond. Try again.')
      }
      throw new HttpError(
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
        throw new HttpError(
          429,
          'RATE_LIMITED',
          'The assistant service is rate-limiting the proxy. Wait a minute and try again.',
        )
      }
      throw new HttpError(502, 'UPSTREAM_ERROR', upstreamErrorMessage(response, rawBody))
    }

    let payload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      throw new HttpError(
        502,
        'UPSTREAM_ERROR',
        'The assistant service returned an unreadable response. Try again.',
      )
    }

    const content = extractContent(payload)
    if (!content) {
      throw new HttpError(
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
// Request body reading with the 32KB cap
// ---------------------------------------------------------------------------

async function readBodyWithLimit(request) {
  const declared = Number(request.headers.get('content-length') || '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { tooLarge: true, text: '' }
  }
  if (!request.body) return { tooLarge: false, text: '' }
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // The stream is already gone; nothing to clean up.
      }
      return { tooLarge: true, text: '' }
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return { tooLarge: false, text }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function healthResponse(env, cors) {
  return json(
    {
      ok: true,
      hasKey: Boolean(getAssistantKey(env)),
      uptime: (Date.now() - ISOLATE_STARTED_AT) / 1000,
    },
    200,
    cors,
  )
}

async function assistantResponse(request, env, cors) {
  const key = getAssistantKey(env)

  const bodyRead = await readBodyWithLimit(request)
  if (bodyRead.tooLarge) {
    return json(errorBody(413, 'BAD_REQUEST', 'Request body too large (32KB max).', key), 413, cors)
  }

  let body = {}
  if (bodyRead.text.trim()) {
    try {
      body = JSON.parse(bodyRead.text)
    } catch {
      return json(errorBody(400, 'BAD_REQUEST', 'Request body must be valid JSON.', key), 400, cors)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(
        errorBody(400, 'BAD_REQUEST', 'Request body must be a JSON object.', key),
        400,
        cors,
      )
    }
  }

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) {
    return json(
      errorBody(
        400,
        'BAD_REQUEST',
        'Field "question" is required and must be a non-empty string.',
        key,
      ),
      400,
      cors,
    )
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json(
      errorBody(
        400,
        'BAD_REQUEST',
        `Field "question" must be at most ${MAX_QUESTION_CHARS} characters.`,
        key,
      ),
      400,
      cors,
    )
  }

  let contextJson = '{}'
  if (body.context !== undefined && body.context !== null) {
    if (typeof body.context !== 'object') {
      return json(
        errorBody(400, 'BAD_REQUEST', 'Field "context" must be a JSON object.', key),
        400,
        cors,
      )
    }
    try {
      contextJson = JSON.stringify(body.context)
    } catch {
      return json(
        errorBody(400, 'BAD_REQUEST', 'Field "context" must be JSON-serializable.', key),
        400,
        cors,
      )
    }
    if (byteLength(contextJson) > MAX_CONTEXT_BYTES) {
      return json(
        errorBody(400, 'BAD_REQUEST', 'Field "context" must serialize to at most 24KB.', key),
        400,
        cors,
      )
    }
  }

  const lang = body.lang === 'my' ? 'my' : 'en'

  if (!key) {
    return json(
      errorBody(
        503,
        'MISSING_KEY',
        'Assistant key not configured on the proxy. Set OPENROUTER_ASSISTANT_KEY in proxy/.env.',
        key,
      ),
      503,
      cors,
    )
  }

  try {
    const content = await requestCompletion(env, key, question, lang, contextJson, false)
    let answer = parseModelJson(content)
    if (!answer) {
      const retryContent = await requestCompletion(env, key, question, lang, contextJson, true)
      answer = parseModelJson(retryContent)
    }
    if (!answer) {
      return json(
        errorBody(
          502,
          'UPSTREAM_ERROR',
          'The assistant returned an unreadable response. Try again.',
          key,
        ),
        502,
        cors,
      )
    }
    return json({ ok: true, answer: normalizeAnswer(answer), model: getModel(env) }, 200, cors)
  } catch (error) {
    if (error instanceof HttpError) {
      return json(errorBody(error.status, error.code, error.message, key), error.status, cors)
    }
    return json(
      errorBody(500, 'INTERNAL', 'Unexpected proxy error. Check the worker logs.', key),
      500,
      cors,
    )
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    const cors = corsHeaders(origin, env)

    if (request.method === 'OPTIONS') return handlePreflight(cors)

    if (request.method === 'GET' && url.pathname === '/health') {
      return healthResponse(env, cors)
    }

    if (request.method === 'POST' && ASSISTANT_PATHS.includes(url.pathname)) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      const rate = checkRateLimit(ip)
      const headers = rateLimitHeaders(rate)
      if (!rate.allowed) {
        return json(
          errorBody(
            429,
            'RATE_LIMITED',
            'Too many assistant requests from this IP. Wait up to 15 minutes and try again.',
          ),
          429,
          { ...cors, ...headers },
        )
      }
      return assistantResponse(request, env, { ...cors, ...headers })
    }

    return json(
      errorBody(
        404,
        'BAD_REQUEST',
        'Unknown route. Use POST /assistant (aliases: POST /, POST /ask) or GET /health.',
      ),
      404,
      cors,
    )
  },
}
