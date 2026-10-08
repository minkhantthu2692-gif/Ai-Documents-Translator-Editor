/**
 * ============================================================================
 * AI Documents Translator & Editor — Cloud Sync Backend (Google Apps Script)
 * ============================================================================
 *
 * WHAT THIS IS
 *   A stateless JSON Web App backend that the local-first web app (src/sync/)
 *   calls to mirror its IndexedDB data into a Google Sheet. All data lives in
 *   the spreadsheet; the script never keeps state between requests beyond the
 *   sheets themselves.
 *
 * SHEETS (auto-created with fixed header rows)
 *   Projects, Pages, Blocks, Glossary, Settings, UsageStats, SyncLog.
 *   Canonical header layout for every syncable sheet:
 *     ['id', 'updatedAt', 'deviceId', 'version', 'deleted', ...entity fields]
 *   Complex / nested entity fields (block geometry, lines, run styling, etc.)
 *   are JSON-encoded into a single `data` column instead of one column per
 *   nested key — this keeps the header row fixed and the read/write code
 *   generic. Scalar columns are used for fields the backend must filter on
 *   (projectId, pageId, order, name, source/target, ...).
 *
 *   Deletions are TOMBSTONES: `op:'delete'` sets the `deleted` column to TRUE
 *   and bumps updatedAt/version; rows are never physically removed (except by
 *   the explicit `wipe` action). This is what makes deletions propagate to
 *   other devices through `pullChanges`.
 *
 * HOW TO DEPLOY
 *   1. Create (or open) a Google Sheet.
 *   2. Extensions → Apps Script. Delete any placeholder code, paste this file
 *      into `Code.gs`, and paste `appsscript.json` over the manifest
 *      (View → Show manifest file).
 *   3. Project Settings → Script Properties → add `TOKEN` = a long random
 *      string (e.g. 32+ chars from a password generator). This is the shared
 *      secret the web app sends in every request. Optional: `SPREADSHEET_ID`
 *      if you deploy the script standalone instead of bound to the Sheet.
 *   4. Deploy → New deployment → Type: Web app → Execute as: **Me** →
 *      Who has access: **Anyone** → Authorize (the spreadsheet scope only).
 *   5. Copy the displayed `/exec` URL into the web app's sync settings.
 *   6. To rotate the token: change the Script Property value only. Nothing in
 *      this file (or in the Sheet) ever contains it.
 *
 * SECURITY NOTES
 *   - Every request must carry `token`; it is compared against the `TOKEN`
 *     Script Property with a length check + XOR loop (constant-time-ish), so
 *     response timing does not leak the secret character by character.
 *   - The token is NEVER echoed back, never logged to SyncLog, never written
 *     to any sheet, and never included in an error message.
 *   - API keys are NEVER stored or synced. The `Settings` sheet refuses any
 *     record whose key name matches /key|token|secret|password|authorization/i
 *     and fails the whole request with `SECRET_NOT_ALLOWED`. Provider keys
 *     stay in the browser, encrypted with WebCrypto AES-GCM (see AGENT.md).
 *   - Apps Script web apps always answer HTTP 200, so failures are reported
 *     inside the JSON envelope as `{ ok:false, code, message }`.
 *   - All error paths return generic messages: no stack traces, no request
 *     bodies, no tokens.
 *
 * CORS / CLIENT REQUIREMENTS
 *   - The browser client MUST POST with `Content-Type: text/plain` (plain
 *     text body containing JSON). A `application/json` body would trigger a
 *     CORS preflight OPTIONS request, which Apps Script web apps do not
 *     handle, and the POST would fail in the browser.
 *   - Apps Script responds with `Access-Control-Allow-Origin: *` only for
 *     deployments set to "Execute as: Me / Anyone". The script itself cannot
 *     set response headers (no such API), so nothing to configure here.
 *   - `doGet` (health) and `doPost` (all actions) both return
 *     `ContentService` JSON output.
 *
 * EXECUTION LIMITS
 *   - Apps Script stops a web app run after 6 minutes. A shared budget
 *     (`EXEC_BUDGET_MS_` = 300s − 15s = 285s) is checked
 *     inside long loops; when it runs out the handler returns
 *     `{ ok:true, partial:true, nextCursor }` and the client simply calls the
 *     same action again with that cursor. Because every write is
 *     last-write-wins and idempotent, resuming is always safe.
 *   - All reads use one `getRange(...).getValues()` per sheet and all writes
 *     use `setValues(...)` in chunks of `CHUNK_ROWS_` (100) rows. There are
 *     no per-cell get/set loops anywhere.
 *   - Google Sheets caps a cell at 50,000 characters, so any string longer
 *     than `MAX_CELL_CHARS_` (45,000) is truncated before the write and the
 *     truncation is recorded in SyncLog instead of failing the request.
 * ============================================================================
 */

/* ==========================================================================
 * Constants
 * ========================================================================== */

/** Reject request bodies larger than ~5 MB (Apps Script POST payload cap). */
var MAX_BODY_CHARS_ = 5 * 1024 * 1024

/** Google Sheets caps a cell at 50,000 characters; stay safely below it. */
var MAX_CELL_CHARS_ = 45000

/** Rows per setValues() call. Keeps write calls small and predictable. */
var CHUNK_ROWS_ = 100

/**
 * Shared time budget: the 6-minute Apps Script execution limit (300s) minus
 * a 15s safety margin for response serialisation. Chunked actions stop when
 * it is exhausted and answer with partial:true + nextCursor.
 */
var EXEC_BUDGET_MS_ = 300000 - 15000

/** How long a mutating action waits for the script lock before failing. */
var LOCK_WAIT_MS_ = 30000

/** How long the SyncLog writer waits for the lock (never fails the request). */
var LOG_LOCK_WAIT_MS_ = 5000

/** pullChanges page size default / ceiling. */
var DEFAULT_PULL_LIMIT_ = 500
var MAX_PULL_LIMIT_ = 5000

/** getProject blocks page size default / ceiling (response-size guard). */
var DEFAULT_BLOCK_LIMIT_ = 500
var MAX_BLOCK_LIMIT_ = 2000

/** backup stops after this many rows and returns partial + nextCursor. */
var MAX_BACKUP_ROWS_ = 20000

/** Sanity caps for request arrays (the 5MB body cap is the real limit). */
var MAX_CHANGES_ = 50000
var MAX_BLOCKS_ = 50000

/** listProjects returns at most this many rows. */
var MAX_PROJECT_LIST_ = 1000

/** Script Property holding the shared secret (never stored in the sheet). */
var TOKEN_PROP_ = 'TOKEN'

/** Optional Script Property: spreadsheet id for standalone deployments. */
var SS_ID_PROP_ = 'SPREADSHEET_ID'

/**
 * Any Settings record whose KEY NAME matches this pattern is rejected with
 * SECRET_NOT_ALLOWED. API keys are never synced to the cloud.
 */
var SECRET_RE_ = /key|token|secret|password|authorization/i

/** Service identity returned by the health endpoint (no secrets). */
var SERVICE_NAME_ = 'ai-documents-translator-sync'
var SERVICE_VERSION_ = '1.0.0'

/* ==========================================================================
 * Sheet definitions — one canonical header array per sheet.
 * The first five columns are always the sync metadata columns; everything
 * after them is entity-specific. Nested/complex fields live JSON-encoded in
 * the trailing `data` column.
 * ========================================================================== */

/** @type {Array<{name:string, entity:string, aliases:Array<string>, headers:Array<string>}>} */
var SHEET_DEFS_ = [
  {
    name: 'Projects',
    entity: 'projects',
    aliases: ['project'],
    headers: [
      'id',
      'updatedAt',
      'deviceId',
      'version',
      'deleted',
      'name',
      'sourceLang',
      'targetLang',
      'status',
      'createdAt',
      'pageCount',
      'data',
    ],
  },
  {
    name: 'Pages',
    entity: 'pages',
    aliases: ['page'],
    headers: [
      'id',
      'updatedAt',
      'deviceId',
      'version',
      'deleted',
      'projectId',
      'index',
      'width',
      'height',
      'data',
    ],
  },
  {
    name: 'Blocks',
    entity: 'blocks',
    aliases: ['block'],
    headers: [
      'id',
      'updatedAt',
      'deviceId',
      'version',
      'deleted',
      'projectId',
      'pageId',
      'order',
      'type',
      'data',
    ],
  },
  {
    name: 'Glossary',
    entity: 'glossary',
    aliases: ['glossaries', 'term', 'terms'],
    headers: [
      'id',
      'updatedAt',
      'deviceId',
      'version',
      'deleted',
      'source',
      'target',
      'note',
      'locale',
      'data',
    ],
  },
  {
    name: 'Settings',
    entity: 'settings',
    aliases: ['setting'],
    headers: ['id', 'updatedAt', 'deviceId', 'version', 'deleted', 'value', 'data'],
  },
  {
    name: 'UsageStats',
    entity: 'usageStats',
    aliases: ['usagestats', 'usage', 'stats', 'stat'],
    headers: [
      'id',
      'updatedAt',
      'deviceId',
      'version',
      'deleted',
      'metric',
      'value',
      'projectId',
      'data',
    ],
  },
]

/** SyncLog header (not a syncable entity — an append-only audit trail). */
var LOG_SHEET_ = 'SyncLog'
var LOG_HEADERS_ = ['timestamp', 'deviceId', 'action', 'rowsIn', 'rowsOut', 'status', 'message']

/** Maps every entity name/alias (lower-case) to its sheet definition. */
var ENTITY_MAP_ = {}
;(function buildEntityMap_() {
  for (var i = 0; i < SHEET_DEFS_.length; i++) {
    var def = SHEET_DEFS_[i]
    ENTITY_MAP_[def.name.toLowerCase()] = def
    ENTITY_MAP_[def.entity.toLowerCase()] = def
    for (var a = 0; a < def.aliases.length; a++) {
      ENTITY_MAP_[String(def.aliases[a]).toLowerCase()] = def
    }
  }
})()

/* ==========================================================================
 * Action registry — `lock:true` means the handler runs under LockService.
 * ========================================================================== */

/** @type {Object<string, {handler:Function, lock:boolean}>} */
var ACTIONS_ = {
  ping: { handler: actionPing_, lock: false },
  pushChanges: { handler: actionPushChanges_, lock: true },
  pullChanges: { handler: actionPullChanges_, lock: false },
  listProjects: { handler: actionListProjects_, lock: false },
  getProject: { handler: actionGetProject_, lock: false },
  upsertBlocks: { handler: actionUpsertBlocks_, lock: true },
  deleteProject: { handler: actionDeleteProject_, lock: true },
  backup: { handler: actionBackup_, lock: false },
  wipe: { handler: actionWipe_, lock: true },
}

/* ==========================================================================
 * Entry points
 * ========================================================================== */

/**
 * Health / connectivity endpoint (GET). Returns a small JSON document with no
 * secrets so the web app can verify the deployment URL before syncing.
 * Health checks are deliberately NOT written to SyncLog to avoid spam.
 *
 * @param {Object} e     Apps Script event (unused).
 * @return {ContentService.TextOutput} JSON response.
 */
function doGet(e) {
  try {
    ensureSheets_()
    return jsonOut_({
      ok: true,
      code: 'OK',
      service: SERVICE_NAME_,
      version: SERVICE_VERSION_,
      serverTime: Date.now(),
      sheetNames: allSheetNames_(),
    })
  } catch (err) {
    // Never leak internals from the health path either.
    return jsonOut_({
      ok: false,
      code: err && err.code ? String(err.code) : 'INTERNAL',
      message: 'Sync backend is not ready.',
      service: SERVICE_NAME_,
      serverTime: Date.now(),
    })
  }
}

/**
 * Main JSON endpoint (POST). Every action of the sync protocol is dispatched
 * here from the request body: { token, action, ...payload }.
 *
 * The whole handler is wrapped in try/catch: unexpected failures return
 * `{ ok:false, code:'INTERNAL', message:'Internal error.' }` with no stack
 * trace and no request data. Every response — success or failure — is JSON.
 *
 * @param {Object} e     Apps Script event; e.postData.contents is the body.
 * @return {ContentService.TextOutput} JSON response.
 */
function doPost(e) {
  var ctx = {
    start: Date.now(),
    deviceId: 'unknown',
    action: '',
    rowsIn: 0,
    rowsOut: 0,
    status: 'OK',
    message: '',
  }
  var res = null

  try {
    var req = parseRequest_(e)
    ctx.action = typeof req.action === 'string' ? req.action : ''

    if (!Object.prototype.hasOwnProperty.call(ACTIONS_, ctx.action)) {
      if (typeof req.action !== 'string' || !req.action) {
        throwCoded_('BAD_REQUEST', 'Missing "action" field.')
      }
      throwCoded_('UNKNOWN_ACTION', 'Unknown action.')
    }

    // Shared-secret check happens before any sheet is touched.
    if (!tokensMatch_(req.token, getToken_())) {
      throwCoded_('UNAUTHORIZED', 'Invalid or missing token.')
    }

    if (typeof req.deviceId === 'string' && req.deviceId) {
      ctx.deviceId = req.deviceId.slice(0, 128)
    }

    var entry = ACTIONS_[ctx.action]
    if (entry.lock) {
      res = runWithLock_(function () {
        return entry.handler(req, ctx)
      })
    } else {
      res = entry.handler(req, ctx)
    }

    ctx.status = 'OK'
    ctx.message = summarise_(res)
  } catch (err) {
    var code = err && err.code ? String(err.code) : 'INTERNAL'
    ctx.status = 'ERROR'
    // codedError_ messages are authored above (no user data, no token);
    // anything else gets a generic message so nothing internal escapes.
    ctx.message = err && err.code ? code + ': ' + safeText_(err.message, 300) : code
    res = {
      ok: false,
      code: code,
      message: err && err.code ? safeText_(err.message, 300) : 'Internal error.',
    }
  }

  // Audit trail. Logging must never break a response, so it is fully guarded.
  try {
    writeSyncLog_(ctx)
  } catch (logErr) {
    // Intentionally ignored — see comment in writeSyncLog_.
  }

  return jsonOut_(res)
}

/* ==========================================================================
 * Request parsing, auth, locking
 * ========================================================================== */

/**
 * Parses and structurally validates the POST body.
 *
 * @param {Object} e Apps Script event.
 * @return {Object} Parsed request object.
 * @private
 */
function parseRequest_(e) {
  var raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : ''
  if (!raw) {
    throwCoded_('BAD_REQUEST', 'Missing request body.')
  }
  if (raw.length > MAX_BODY_CHARS_) {
    throwCoded_('BAD_REQUEST', 'Request body exceeds the 5MB limit.')
  }
  var req
  try {
    req = JSON.parse(raw)
  } catch (parseErr) {
    throwCoded_('BAD_REQUEST', 'Request body must be valid JSON.')
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    throwCoded_('BAD_REQUEST', 'Request body must be a JSON object.')
  }
  return req
}

/**
 * Reads the shared secret from Script Properties. A deployment without a
 * TOKEN property rejects every request (fail closed).
 *
 * @return {string|null} The configured token or null.
 * @private
 */
function getToken_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(TOKEN_PROP_)
  } catch (propErr) {
    return null
  }
}

/**
 * Constant-time-ish token comparison: length check first, then a XOR walk
 * over both strings that always runs max(len) iterations. The result depends
 * only on equality, not on where the first differing character is.
 *
 * @param {*} actual   Candidate token from the request.
 * @param {?string} expected Token from Script Properties.
 * @return {boolean} True when they match.
 * @private
 */
function tokensMatch_(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') {
    return false
  }
  if (expected.length === 0) {
    return false
  }
  var diff = actual.length === expected.length ? 0 : 1
  var n = Math.max(actual.length, expected.length)
  for (var i = 0; i < n; i++) {
    var ca = i < actual.length ? actual.charCodeAt(i) : 0
    var cb = i < expected.length ? expected.charCodeAt(i) : 0
    diff |= ca ^ cb
  }
  return diff === 0
}

/**
 * Runs a mutating action under the script lock. waitLock() throws when the
 * 30s wait expires; the lock is always released in `finally`, so two browsers
 * syncing through one spreadsheet can never interleave a write.
 *
 * @param {Function} fn Action to run while holding the lock.
 * @return {*} The action result.
 * @private
 */
function runWithLock_(fn) {
  var lock = LockService.getScriptLock()
  try {
    lock.waitLock(LOCK_WAIT_MS_)
  } catch (lockErr) {
    throwCoded_('LOCK_TIMEOUT', 'Sync is busy in another session; retry shortly.')
  }
  try {
    return fn()
  } finally {
    lock.releaseLock()
  }
}

/* ==========================================================================
 * Actions
 * ========================================================================== */

/**
 * ping — lightweight round-trip check: proves the token works, the sheets
 * exist and reports server time + the sheet inventory. No data is returned.
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionPing_(req, ctx) {
  ensureSheets_()
  ctx.rowsIn = 0
  ctx.rowsOut = 0
  return {
    ok: true,
    pong: true,
    serverTime: Date.now(),
    sheetNames: allSheetNames_(),
  }
}

/**
 * pushChanges — applies a batch of local edits/deletions to the sheets using
 * last-write-wins conflict resolution. An incoming record wins only when:
 *   1. its updatedAt is greater than the stored updatedAt, or
 *   2. timestamps are equal and its version is greater, or
 *   3. both are equal and its deviceId is greater (string comparison).
 * Otherwise the change is skipped and counted in `skipped`.
 *
 * Deletes are written as tombstones (`deleted` = TRUE), never removed.
 *
 * Request: { token, deviceId, changes: [{ entity, id, op, record, updatedAt,
 *           version, deviceId }] }
 * Response: { ok, applied, skipped, deferred, truncated, chunks, partial,
 *           nextCursor }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionPushChanges_(req, ctx) {
  var changes = validateChanges_(req.changes)
  ctx.rowsIn = changes.length

  var ss = ensureSheets_()
  var budget = makeBudget_(ctx.start)
  var stats = { truncated: 0, chunks: 0 }

  // Group by sheet while remembering each change's original index so a
  // partial run can point the client at the first deferred change.
  var groups = []
  var groupByName = {}
  for (var i = 0; i < changes.length; i++) {
    var def = defForEntity_(changes[i].entity)
    var name = def.name
    if (!groupByName[name]) {
      groupByName[name] = { def: def, items: [] }
      groups.push(groupByName[name])
    }
    groupByName[name].items.push({ index: i, change: changes[i] })
  }

  var applied = 0
  var skipped = 0
  var deferred = 0
  var firstDeferred = -1

  for (var g = 0; g < groups.length; g++) {
    var group = groups[g]
    if (budget.expired()) {
      // Sheet writes are only started when there is time left, so a sheet is
      // always written completely or not at all (safe resume point).
      for (var d = 0; d < group.items.length; d++) {
        deferred++
        if (firstDeferred < 0 || group.items[d].index < firstDeferred) {
          firstDeferred = group.items[d].index
        }
      }
      for (var g2 = g + 1; g2 < groups.length; g2++) {
        var rest = groups[g2].items
        for (var d2 = 0; d2 < rest.length; d2++) {
          deferred++
          if (firstDeferred < 0 || rest[d2].index < firstDeferred) {
            firstDeferred = rest[d2].index
          }
        }
      }
      break
    }

    var data = readSheet_(ss, group.def)
    var index = indexRows_(data.rows)
    var modified = []

    for (var c = 0; c < group.items.length; c++) {
      var entry = normalizeChangeEntry_(group.def, group.items[c].change)
      var result = stageApply_(data, index, group.def, entry, stats)
      if (result.status === 'applied') {
        applied++
        modified.push({ row: result.row, values: result.values })
      } else {
        skipped++
      }
    }

    stats.chunks += writeModified_(data.sheet, data.cols, modified)
  }

  ctx.rowsOut = applied
  return {
    ok: true,
    applied: applied,
    skipped: skipped,
    deferred: deferred,
    truncated: stats.truncated,
    chunks: stats.chunks,
    partial: deferred > 0,
    nextCursor: deferred > 0 ? firstDeferred : null,
  }
}

/**
 * pullChanges — returns every row across the syncable sheets whose updatedAt
 * is strictly greater than `since`, including tombstones (deleted = true),
 * so deletions propagate to other devices.
 *
 * Paging: rows are sorted ascending by updatedAt and the first `limit` rows
 * are returned; when the page boundary falls inside a group of rows sharing
 * the same timestamp, the whole group is included so that `nextCursor`
 * (the last returned updatedAt, compared exclusively) never skips a row.
 * Call again with { since: nextCursor } until hasMore is false. Applying the
 * same change twice is harmless because every write is last-write-wins.
 *
 * Request: { token, since:number, limit?:number }
 * Response: { ok, changes, count, hasMore, nextCursor, serverTime }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionPullChanges_(req, ctx) {
  var since = 0
  if (req.since !== undefined && req.since !== null) {
    since = requireFiniteNumber_(req.since, 'since')
  }
  var limit = DEFAULT_PULL_LIMIT_
  if (req.limit !== undefined && req.limit !== null) {
    limit = requireInt_(req.limit, 'limit', 1, MAX_PULL_LIMIT_)
  }

  var ss = ensureSheets_()
  var candidates = []

  for (var s = 0; s < SHEET_DEFS_.length; s++) {
    var def = SHEET_DEFS_[s]
    var data = readSheet_(ss, def)
    for (var r = 0; r < data.rows.length; r++) {
      var rec = rowToRecord_(def, data.rows[r])
      var updatedAt = Number(rec.updatedAt) || 0
      if (updatedAt > since) {
        candidates.push({
          sheetOrder: s,
          rowOrder: r,
          entity: def.entity,
          updatedAt: updatedAt,
          record: rec,
        })
      }
    }
  }

  candidates.sort(function (a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt
    if (a.sheetOrder !== b.sheetOrder) return a.sheetOrder - b.sheetOrder
    return a.rowOrder - b.rowOrder
  })

  var total = candidates.length
  var take = Math.min(limit, total)
  if (take < total) {
    var boundary = candidates[take - 1].updatedAt
    while (take < total && candidates[take].updatedAt === boundary) {
      take++
    }
  }
  var hasMore = take < total

  var changes = []
  for (var k = 0; k < take; k++) {
    var item = candidates[k]
    changes.push({
      entity: item.entity,
      id: String(item.record.id),
      op: item.record.deleted ? 'delete' : 'upsert',
      updatedAt: item.updatedAt,
      version: Number(item.record.version) || 0,
      deviceId: String(item.record.deviceId || ''),
      record: item.record,
    })
  }

  ctx.rowsIn = 0
  ctx.rowsOut = changes.length
  return {
    ok: true,
    changes: changes,
    count: changes.length,
    hasMore: hasMore,
    nextCursor: take > 0 ? candidates[take - 1].updatedAt : since,
    since: since,
    serverTime: Date.now(),
  }
}

/**
 * listProjects — lightweight project picker payload (no pages/blocks), so
 * the dashboard can list projects without downloading the whole document.
 *
 * Request: { token }
 * Response: { ok, projects:[{id,name,updatedAt,...}], count, serverTime }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionListProjects_(req, ctx) {
  var ss = ensureSheets_()
  var def = defForEntity_('projects')
  var data = readSheet_(ss, def)
  var projects = []

  for (var r = 0; r < data.rows.length && projects.length < MAX_PROJECT_LIST_; r++) {
    var rec = rowToRecord_(def, data.rows[r])
    if (rec.deleted) continue
    projects.push(rec)
  }

  projects.sort(function (a, b) {
    return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
  })

  ctx.rowsIn = 0
  ctx.rowsOut = projects.length
  return {
    ok: true,
    projects: projects,
    count: projects.length,
    truncated: data.rows.length > projects.length,
    serverTime: Date.now(),
  }
}

/**
 * getProject — returns one project row plus its pages and its blocks.
 *
 * Blocks are paged with `offset`/`limit` (default 500, max 2000) because a
 * 300-page document can hold tens of thousands of blocks and a single
 * response must stay well inside Apps Script's ~50MB response ceiling.
 * The client walks `hasMoreBlocks` with offset += blocks.length.
 *
 * Request: { token, projectId, offset?:number, limit?:number }
 * Response: { ok, project, pages, blocks, blockTotal, blockOffset,
 *           hasMoreBlocks, serverTime }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionGetProject_(req, ctx) {
  var projectId = requireString_(req.projectId, 'projectId')
  var offset = 0
  if (req.offset !== undefined && req.offset !== null) {
    offset = requireInt_(req.offset, 'offset', 0, 100000000)
  }
  var limit = DEFAULT_BLOCK_LIMIT_
  if (req.limit !== undefined && req.limit !== null) {
    limit = requireInt_(req.limit, 'limit', 1, MAX_BLOCK_LIMIT_)
  }

  var ss = ensureSheets_()
  var projectDef = defForEntity_('projects')
  var projectData = readSheet_(ss, projectDef)
  var project = null
  for (var p = 0; p < projectData.rows.length; p++) {
    var rec = rowToRecord_(projectDef, projectData.rows[p])
    if (String(rec.id) === projectId) {
      project = rec
      break
    }
  }
  if (!project) {
    throwCoded_('NOT_FOUND', 'Project not found.')
  }

  var pages = readByField_(ss, defForEntity_('pages'), 'projectId', projectId)
  var allBlocks = readByField_(ss, defForEntity_('blocks'), 'projectId', projectId)
  var blockTotal = allBlocks.length
  var blocks = allBlocks.slice(offset, offset + limit)

  ctx.rowsIn = 0
  ctx.rowsOut = 1 + pages.length + blocks.length
  return {
    ok: true,
    project: project,
    pages: pages,
    blocks: blocks,
    blockTotal: blockTotal,
    blockOffset: offset,
    blockLimit: limit,
    hasMoreBlocks: offset + blocks.length < blockTotal,
    serverTime: Date.now(),
  }
}

/**
 * upsertBlocks — bulk-writes a project's blocks in batches of CHUNK_ROWS_
 * (100) rows per setValues() call so a 300-page document with thousands of
 * blocks finishes well inside the 6-minute execution limit.
 *
 * Each batch is fully written before the time budget is checked, so a
 * partial result is always a consistent resume point: the client re-calls
 * with { offset: nextCursor } (LWW makes the overlap idempotent).
 *
 * Request: { token, projectId, blocks:[record|{id,record,updatedAt,...}],
 *           offset?:number }
 * Response: { ok, applied, skipped, truncated, chunks, processed, total,
 *           progress:[{offset, processed, applied, skipped}], partial,
 *           nextCursor }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionUpsertBlocks_(req, ctx) {
  var projectId = requireString_(req.projectId, 'projectId')
  var blocks = req.blocks
  if (!Array.isArray(blocks)) {
    throwCoded_('BAD_REQUEST', 'blocks must be an array.')
  }
  if (blocks.length > MAX_BLOCKS_) {
    throwCoded_('BAD_REQUEST', 'blocks array is too large.')
  }
  var offset = 0
  if (req.offset !== undefined && req.offset !== null) {
    offset = requireInt_(req.offset, 'offset', 0, blocks.length)
  }
  for (var v = 0; v < blocks.length; v++) {
    var probe = blocks[v]
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
      throwCoded_('BAD_REQUEST', 'blocks[' + v + '] must be an object.')
    }
  }

  ctx.rowsIn = blocks.length

  var ss = ensureSheets_()
  var def = defForEntity_('blocks')
  var data = readSheet_(ss, def)
  var index = indexRows_(data.rows)
  var budget = makeBudget_(ctx.start)
  var stats = { truncated: 0, chunks: 0 }

  var applied = 0
  var skipped = 0
  var processed = offset
  var progress = []

  while (processed < blocks.length) {
    var batchStart = processed
    var batchEnd = Math.min(processed + CHUNK_ROWS_, blocks.length)
    var modified = []

    for (var i = processed; i < batchEnd; i++) {
      var entry = normalizeBlockEntry_(blocks[i], projectId, i)
      var result = stageApply_(data, index, def, entry, stats)
      if (result.status === 'applied') {
        applied++
        modified.push({ row: result.row, values: result.values })
      } else {
        skipped++
      }
    }

    stats.chunks += writeModified_(data.sheet, data.cols, modified)
    processed = batchEnd
    // Per-chunk progress so the client can show a live counter while a large
    // document uploads: cumulative counts as of the end of this chunk.
    progress.push({
      offset: batchStart,
      processed: processed,
      applied: applied,
      skipped: skipped,
    })

    if (processed < blocks.length && budget.expired()) {
      break
    }
  }

  var partial = processed < blocks.length
  ctx.rowsOut = applied
  return {
    ok: true,
    applied: applied,
    skipped: skipped,
    truncated: stats.truncated,
    chunks: stats.chunks,
    processed: processed,
    total: blocks.length,
    chunkRows: CHUNK_ROWS_,
    progress: progress,
    partial: partial,
    nextCursor: partial ? processed : null,
  }
}

/**
 * deleteProject — tombstones a project and every page and block that belongs
 * to it (deleted = TRUE, updatedAt = now, version bumped). Rows are not
 * physically removed so the deletion propagates through pullChanges and can
 * be undone from another device's cache.
 *
 * Request: { token, projectId }
 * Response: { ok, project, pages, blocks }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionDeleteProject_(req, ctx) {
  var projectId = requireString_(req.projectId, 'projectId')
  var ss = ensureSheets_()
  var now = Date.now()
  var deviceId = ctx.deviceId || 'server'
  var stats = { truncated: 0, chunks: 0 }

  var projectDef = defForEntity_('projects')
  var projectData = readSheet_(ss, projectDef)
  var projectIndex = indexRows_(projectData.rows)
  if (projectIndex[projectId] === undefined) {
    throwCoded_('NOT_FOUND', 'Project not found.')
  }

  var tombstoned = { project: 0, pages: 0, blocks: 0 }
  var plan = [
    { def: projectDef, data: projectData, byId: true, key: 'project' },
    { def: defForEntity_('pages'), data: null, byId: false, key: 'pages' },
    { def: defForEntity_('blocks'), data: null, byId: false, key: 'blocks' },
  ]

  for (var t = 0; t < plan.length; t++) {
    var step = plan[t]
    var data = step.data || readSheet_(ss, step.def)
    var fieldCol = step.byId ? -1 : step.def.headers.indexOf('projectId')
    var modified = []

    for (var r = 0; r < data.rows.length; r++) {
      var rec = rowToRecord_(step.def, data.rows[r])
      var match = step.byId ? String(rec.id) === projectId : String(rec.projectId) === projectId
      if (!match) continue
      if (rec.deleted === true && step.byId === false) {
        // Already a tombstone — skip rewriting identical rows.
        continue
      }
      rec.deleted = true
      rec.updatedAt = now
      rec.deviceId = deviceId
      rec.version = (Number(rec.version) || 0) + 1
      var values = recordToRow_(step.def, rec, stats)
      data.rows[r] = values
      modified.push({ row: r + 2, values: values })
      tombstoned[step.key]++
    }

    // fieldCol is only used to document intent: rows are matched on the
    // projectId column, which rowToRecord_ already surfaced as rec.projectId.
    if (!step.byId && fieldCol < 0) {
      throwCoded_('INTERNAL', 'Sheet ' + step.def.name + ' has no projectId column.')
    }

    stats.chunks += writeModified_(data.sheet, data.cols, modified)
  }

  ctx.rowsIn = 1
  ctx.rowsOut = tombstoned.project + tombstoned.pages + tombstoned.blocks
  return {
    ok: true,
    project: tombstoned.project,
    pages: tombstoned.pages,
    blocks: tombstoned.blocks,
  }
}

/**
 * backup — full JSON snapshot of every syncable sheet, useful for the UI's
 * "download cloud backup" action.
 *
 * Limits (documented): rows are converted in a loop that checks the shared
 * time budget every 500 rows and stops after MAX_BACKUP_ROWS_ (20,000) rows.
 * When either limit is hit the response carries partial:true and a
 * nextCursor { sheetIndex, sheet, offset }; re-call backup with
 * { cursor: nextCursor } to continue. Large documents therefore come back as
 * several snapshots the client concatenates.
 *
 * Request: { token, cursor?:{sheetIndex, offset} }
 * Response: { ok, snapshot:{SheetName:{headers,rows}}, counts, total,
 *           partial, nextCursor, serverTime }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionBackup_(req, ctx) {
  var startIdx = 0
  var startOffset = 0
  if (req.cursor && typeof req.cursor === 'object' && !Array.isArray(req.cursor)) {
    if (req.cursor.sheetIndex !== undefined && req.cursor.sheetIndex !== null) {
      startIdx = requireInt_(req.cursor.sheetIndex, 'cursor.sheetIndex', 0, SHEET_DEFS_.length - 1)
    }
    if (req.cursor.offset !== undefined && req.cursor.offset !== null) {
      startOffset = requireInt_(req.cursor.offset, 'cursor.offset', 0, 100000000)
    }
  }

  var ss = ensureSheets_()
  var budget = makeBudget_(ctx.start)
  var snapshot = {}
  var counts = {}
  var total = 0
  var partial = false
  var nextCursor = null

  for (var s = startIdx; s < SHEET_DEFS_.length; s++) {
    var def = SHEET_DEFS_[s]
    var data = readSheet_(ss, def)
    var fromRow = s === startIdx ? startOffset : 0
    var rows = []

    for (var r = fromRow; r < data.rows.length; r++) {
      rows.push(rowToRecord_(def, data.rows[r]))
      total++
      if (total >= MAX_BACKUP_ROWS_) {
        partial = true
        nextCursor = { sheetIndex: s, sheet: def.name, offset: r + 1 }
        break
      }
      if ((r - fromRow) % 500 === 0 && budget.expired()) {
        partial = true
        nextCursor = { sheetIndex: s, sheet: def.name, offset: r }
        break
      }
    }

    snapshot[def.name] = { headers: def.headers.slice(), rows: rows }
    counts[def.name] = rows.length

    if (partial) break
  }

  ctx.rowsIn = 0
  ctx.rowsOut = total
  return {
    ok: true,
    snapshot: snapshot,
    counts: counts,
    total: total,
    partial: partial,
    nextCursor: nextCursor,
    serverTime: Date.now(),
  }
}

/**
 * wipe — deletes ALL cloud data (the UI's "delete all cloud data" button).
 * Requires BOTH a valid token and `confirm: 'WIPE'`. Clears every data row in
 * Projects/Pages/Blocks/Glossary/Settings/UsageStats with one clearContent()
 * call per sheet (headers are kept) and records the event in SyncLog.
 * SyncLog itself is never wiped so the audit trail survives.
 *
 * Request: { token, confirm: 'WIPE' }
 * Response: { ok, cleared:{SheetName:rows}, total }
 *
 * @param {Object} req Parsed request.
 * @param {Object} ctx Per-request logging context (mutated).
 * @return {Object} Response payload.
 * @private
 */
function actionWipe_(req, ctx) {
  if (req.confirm !== 'WIPE') {
    throwCoded_('BAD_REQUEST', 'wipe requires confirm: "WIPE".')
  }

  var ss = ensureSheets_()
  var cleared = {}
  var total = 0
  var chunks = 0

  for (var i = 0; i < SHEET_DEFS_.length; i++) {
    var def = SHEET_DEFS_[i]
    var sh = ss.getSheetByName(def.name)
    if (!sh) {
      cleared[def.name] = 0
      continue
    }
    var lastRow = sh.getLastRow()
    var dataRows = lastRow > 1 ? lastRow - 1 : 0
    if (dataRows > 0) {
      sh.getRange(2, 1, dataRows, def.headers.length).clearContent()
      chunks++
    }
    cleared[def.name] = dataRows
    total += dataRows
  }

  ctx.rowsIn = 1
  ctx.rowsOut = total
  return { ok: true, cleared: cleared, total: total, chunks: chunks }
}

/* ==========================================================================
 * Sheet plumbing (batched reads / writes, header guarantees)
 * ========================================================================== */

/**
 * Returns the spreadsheet to sync with. Uses the optional SPREADSHEET_ID
 * Script Property when present (standalone deployment), otherwise the
 * spreadsheet the script is bound to (Extensions → Apps Script).
 *
 * @return {Spreadsheet} The target spreadsheet.
 * @private
 */
function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(SS_ID_PROP_)
  if (id) {
    return SpreadsheetApp.openById(id)
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  if (!ss) {
    throwCoded_(
      'INTERNAL',
      'No spreadsheet bound. Attach the script to a Sheet or set the SPREADSHEET_ID script property.',
    )
  }
  return ss
}

/**
 * Creates any missing sheet with its canonical header row and verifies the
 * headers of existing sheets. Takes the script lock only when work is
 * needed, so read-only actions do not contend on it.
 *
 * Header mismatch (e.g. a hand-edited column order) is a hard INTERNAL error:
 * silently rewriting headers could misalign data written by older clients.
 *
 * @return {Spreadsheet} The target spreadsheet.
 * @private
 */
function ensureSheets_() {
  var ss = getSpreadsheet_()
  if (sheetsReady_(ss)) {
    return ss
  }
  var lock = LockService.getScriptLock()
  try {
    lock.waitLock(LOCK_WAIT_MS_)
  } catch (lockErr) {
    throwCoded_('LOCK_TIMEOUT', 'Sync is busy in another session; retry shortly.')
  }
  try {
    createMissingSheets_(ss)
    return ss
  } finally {
    lock.releaseLock()
  }
}

/**
 * Read-only readiness check: every sheet exists with the expected headers.
 *
 * @param {Spreadsheet} ss Target spreadsheet.
 * @return {boolean} True when nothing has to be created.
 * @private
 */
function sheetsReady_(ss) {
  var defs = allSheetDefs_()
  for (var i = 0; i < defs.length; i++) {
    var def = defs[i]
    var sh = ss.getSheetByName(def.name)
    if (!sh) return false
    if (sh.getLastRow() < 1 || sh.getLastColumn() < def.headers.length) return false
    var head = sh.getRange(1, 1, 1, def.headers.length).getValues()[0]
    for (var c = 0; c < def.headers.length; c++) {
      if (String(head[c]) !== def.headers[c]) return false
    }
  }
  return true
}

/**
 * Creates missing sheets with header rows and verifies existing ones.
 *
 * @param {Spreadsheet} ss Target spreadsheet.
 * @private
 */
function createMissingSheets_(ss) {
  var defs = allSheetDefs_()
  for (var i = 0; i < defs.length; i++) {
    var def = defs[i]
    var sh = ss.getSheetByName(def.name)
    if (!sh) {
      sh = ss.insertSheet(def.name)
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers.slice()])
      continue
    }
    var lastRow = sh.getLastRow()
    if (lastRow < 1) {
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers.slice()])
      continue
    }
    if (sh.getLastColumn() < def.headers.length) {
      throwCoded_(
        'INTERNAL',
        'Sheet "' + def.name + '" has too few columns; repair its header row.',
      )
    }
    var head = sh.getRange(1, 1, 1, def.headers.length).getValues()[0]
    for (var c = 0; c < def.headers.length; c++) {
      if (String(head[c]) !== def.headers[c]) {
        throwCoded_(
          'INTERNAL',
          'Sheet "' + def.name + '" header row does not match the expected layout.',
        )
      }
    }
  }
}

/**
 * Syncable sheet definitions plus SyncLog (used by ensureSheets_).
 *
 * @return {Array<Object>} Sheet definitions with headers.
 * @private
 */
function allSheetDefs_() {
  var defs = SHEET_DEFS_.slice()
  defs.push({ name: LOG_SHEET_, entity: 'syncLog', aliases: [], headers: LOG_HEADERS_ })
  return defs
}

/**
 * Every sheet name this backend knows about.
 *
 * @return {Array<string>} Sheet names.
 * @private
 */
function allSheetNames_() {
  var names = []
  for (var i = 0; i < SHEET_DEFS_.length; i++) names.push(SHEET_DEFS_[i].name)
  names.push(LOG_SHEET_)
  return names
}

/**
 * Reads one whole sheet in a single getValues() call and checks that its
 * header row matches the canonical layout.
 *
 * @param {Spreadsheet} ss   Target spreadsheet.
 * @param {Object} def       Sheet definition ({name, headers}).
 * @return {{sheet:Object, headers:Array<string>, rows:Array<*>, cols:number}}
 *         Sheet handle, headers and the data rows (sheet row = index + 2).
 * @private
 */
function readSheet_(ss, def) {
  var sh = ss.getSheetByName(def.name)
  if (!sh) {
    throwCoded_('INTERNAL', 'Sheet "' + def.name + '" is missing.')
  }
  var cols = def.headers.length
  var lastRow = sh.getLastRow()
  var lastCol = sh.getLastColumn()

  if (lastCol < cols) {
    throwCoded_(
      'INTERNAL',
      'Sheet "' + def.name + '" has ' + lastCol + ' columns, expected ' + cols + '.',
    )
  }
  if (lastRow < 1) {
    sh.getRange(1, 1, 1, cols).setValues([def.headers.slice()])
    return { sheet: sh, headers: def.headers.slice(), rows: [], cols: cols }
  }

  var values = sh.getRange(1, 1, lastRow, cols).getValues()
  var head = values[0]
  for (var c = 0; c < cols; c++) {
    if (String(head[c]) !== def.headers[c]) {
      throwCoded_(
        'INTERNAL',
        'Sheet "' + def.name + '" header row does not match the expected layout.',
      )
    }
  }

  return { sheet: sh, headers: def.headers.slice(), rows: values.slice(1), cols: cols }
}

/**
 * Builds an id → row-index map from one already-read 2D array.
 * Duplicate ids resolve to the last occurrence (later rows win).
 *
 * @param {Array<Array<*>>} rows Data rows (sheet row = index + 2).
 * @return {Object} Map of id → row index into `rows`.
 * @private
 */
function indexRows_(rows) {
  var map = {}
  for (var i = 0; i < rows.length; i++) {
    var id = rows[i][0]
    if (id === null || id === undefined || id === '') continue
    map[String(id)] = i
  }
  return map
}

/**
 * Writes changed rows with setValues() in chunks of CHUNK_ROWS_ rows.
 * Modified rows are grouped into contiguous runs first, so untouched rows in
 * between are never written. Never does per-cell writes.
 *
 * @param {Object} sh       Sheet handle.
 * @param {number} cols     Column count.
 * @param {Array<{row:number, values:Array<*>}>} modified Sheet rows to write.
 * @return {number} Number of setValues() calls performed.
 * @private
 */
function writeModified_(sh, cols, modified) {
  if (!modified.length) return 0
  modified.sort(function (a, b) {
    return a.row - b.row
  })

  var chunks = 0
  var run = [modified[0]]
  for (var i = 1; i < modified.length; i++) {
    if (modified[i].row === run[run.length - 1].row + 1) {
      run.push(modified[i])
    } else {
      chunks += flushRun_(sh, cols, run)
      run = [modified[i]]
    }
  }
  chunks += flushRun_(sh, cols, run)
  return chunks
}

/**
 * Writes one contiguous run of rows, chunked by CHUNK_ROWS_.
 *
 * @param {Object} sh   Sheet handle.
 * @param {number} cols Column count.
 * @param {Array<{row:number, values:Array<*>}>} run Contiguous sheet rows.
 * @return {number} Number of setValues() calls performed.
 * @private
 */
function flushRun_(sh, cols, run) {
  var chunks = 0
  for (var i = 0; i < run.length; i += CHUNK_ROWS_) {
    var part = run.slice(i, i + CHUNK_ROWS_)
    var values = []
    for (var p = 0; p < part.length; p++) values.push(part[p].values)
    sh.getRange(run[i].row, 1, values.length, cols).setValues(values)
    chunks++
  }
  return chunks
}

/**
 * Reads every row of a sheet whose given field equals `value`.
 *
 * @param {Spreadsheet} ss  Target spreadsheet.
 * @param {Object} def      Sheet definition.
 * @param {string} field    Column name to match.
 * @param {string} value    Value to match.
 * @return {Array<Object>} Matching records.
 * @private
 */
function readByField_(ss, def, field, value) {
  var data = readSheet_(ss, def)
  var out = []
  for (var i = 0; i < data.rows.length; i++) {
    var rec = rowToRecord_(def, data.rows[i])
    if (String(rec[field]) === value) out.push(rec)
  }
  return out
}

/* ==========================================================================
 * Record ↔ row conversion (cell limits, JSON `data` column)
 * ========================================================================== */

/**
 * Converts a record into a sheet row following the canonical header order.
 * Keys of the record that are not declared columns are JSON-encoded into the
 * `data` column (nested block geometry/lines live there). Every string is
 * truncated to MAX_CELL_CHARS_ so the write never exceeds the 50,000-char
 * Sheets cell limit; truncations are counted into `stats.truncated`.
 *
 * @param {Object} def   Sheet definition.
 * @param {Object} rec   Record.
 * @param {Object} stats {truncated} counter (mutated).
 * @return {Array<*>} Row values in header order.
 * @private
 */
function recordToRow_(def, rec, stats) {
  var row = []
  var extras = {}
  var i
  var k

  for (k in rec) {
    if (!Object.prototype.hasOwnProperty.call(rec, k)) continue
    if (def.headers.indexOf(k) === -1 && k !== 'data') extras[k] = rec[k]
  }

  for (i = 0; i < def.headers.length; i++) {
    var h = def.headers[i]
    if (h === 'data') {
      var json = Object.keys(extras).length ? JSON.stringify(extras) : ''
      row.push(sanitizeCell_(json, stats))
      continue
    }
    if (h === 'deleted') {
      row.push(rec.deleted === true || rec.deleted === 1 || rec.deleted === 'true')
      continue
    }
    if (h === 'updatedAt' || h === 'version') {
      var num = Number(rec[h])
      row.push(isFinite(num) ? num : 0)
      continue
    }
    row.push(sanitizeCell_(rec[h], stats))
  }
  return row
}

/**
 * Converts a sheet row back into a record: the `data` JSON column is parsed
 * and merged first so the declared scalar columns always win.
 *
 * @param {Object} def Sheet definition.
 * @param {Array<*>} row Row values in header order.
 * @return {Object} Record.
 * @private
 */
function rowToRecord_(def, row) {
  var rec = {}
  var dataIdx = def.headers.indexOf('data')
  if (dataIdx >= 0) {
    var raw = row[dataIdx]
    if (typeof raw === 'string' && raw) {
      try {
        var parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rec = parsed
        }
      } catch (jsonErr) {
        // A cell truncated by the 50k Sheets limit can produce invalid JSON;
        // the row itself is still usable, so the extras are simply dropped.
      }
    }
  }

  for (var i = 0; i < def.headers.length; i++) {
    var h = def.headers[i]
    if (h === 'data') continue
    var v = row[i]
    if (h === 'deleted') {
      rec.deleted = v === true || v === 1 || v === 'TRUE' || v === 'true'
    } else if (h === 'updatedAt' || h === 'version') {
      var n = Number(v)
      rec[h] = isFinite(n) ? n : 0
    } else {
      rec[h] = v
    }
  }
  return rec
}

/**
 * Coerces a value into something Sheets accepts and keeps it under the cell
 * limit. Objects/arrays are JSON-encoded (they only arrive here when they
 * are declared scalar columns, so this is a safety net).
 *
 * @param {*} value       Value to sanitise.
 * @param {Object} stats   Optional {truncated} counter (mutated).
 * @return {string|number|boolean} Safe cell value.
 * @private
 */
function sanitizeCell_(value, stats) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_CELL_CHARS_) {
      if (stats) stats.truncated++
      return value.slice(0, MAX_CELL_CHARS_)
    }
    return value
  }
  var json
  try {
    json = JSON.stringify(value)
  } catch (cycleErr) {
    return ''
  }
  if (typeof json !== 'string') return ''
  if (json.length > MAX_CELL_CHARS_) {
    if (stats) stats.truncated++
    return json.slice(0, MAX_CELL_CHARS_)
  }
  return json
}

/* ==========================================================================
 * Change normalisation + last-write-wins
 * ========================================================================== */

/**
 * Maps a change's entity name (any casing/alias) to its sheet definition.
 *
 * @param {*} entity Entity name from the request.
 * @return {Object|null} Sheet definition or null when unknown.
 * @private
 */
function defForEntity_(entity) {
  if (typeof entity !== 'string') return null
  var key = entity.toLowerCase()
  return Object.prototype.hasOwnProperty.call(ENTITY_MAP_, key) ? ENTITY_MAP_[key] : null
}

/**
 * Validates the `changes` array of pushChanges: array of objects with string
 * entity/id, known entity, valid op and finite updatedAt/version timestamps.
 * Also enforces the Settings secret policy before anything is written, so a
 * single bad record fails the request with SECRET_NOT_ALLOWED and no row is
 * persisted.
 *
 * @param {*} changes Raw request field.
 * @return {Array<Object>} The validated array.
 * @private
 */
function validateChanges_(changes) {
  if (!Array.isArray(changes)) {
    throwCoded_('BAD_REQUEST', 'changes must be an array.')
  }
  if (changes.length > MAX_CHANGES_) {
    throwCoded_('BAD_REQUEST', 'changes array is too large.')
  }

  for (var i = 0; i < changes.length; i++) {
    var ch = changes[i]
    if (!ch || typeof ch !== 'object' || Array.isArray(ch)) {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '] must be an object.')
    }
    if (typeof ch.entity !== 'string' || !ch.entity) {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '].entity must be a non-empty string.')
    }
    if (!defForEntity_(ch.entity)) {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '].entity is not a syncable entity.')
    }
    if (typeof ch.id !== 'string' || !ch.id) {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '].id must be a non-empty string.')
    }
    if (ch.op !== undefined && ch.op !== 'upsert' && ch.op !== 'delete') {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '].op must be "upsert" or "delete".')
    }
    if (!isFiniteNumber_(ch.updatedAt)) {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '].updatedAt must be a finite number.')
    }
    if (ch.version !== undefined && !isFiniteNumber_(ch.version)) {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '].version must be a finite number.')
    }
    if (
      ch.record !== undefined &&
      (!ch.record || typeof ch.record !== 'object' || Array.isArray(ch.record))
    ) {
      throwCoded_('BAD_REQUEST', 'changes[' + i + '].record must be an object.')
    }
  }

  // Whole-array validation happens before any sheet is written.
  for (var s = 0; s < changes.length; s++) {
    var def = defForEntity_(changes[s].entity)
    var probe = normalizeChangeEntry_(def, changes[s])
    assertNotSecretSetting_(def, probe.record)
  }

  return changes
}

/**
 * Turns a pushChanges item into { id, record } with all metadata columns
 * populated, applying `op:'delete'` as a tombstone flag.
 *
 * @param {Object} def    Sheet definition.
 * @param {Object} change Change item.
 * @return {{id:string, record:Object}} Normalised entry.
 * @private
 */
function normalizeChangeEntry_(def, change) {
  var rec =
    change.record && typeof change.record === 'object' && !Array.isArray(change.record)
      ? change.record
      : {}
  var out = {}
  for (var k in rec) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k]
  }

  out.id = change.id
  out.updatedAt = isFiniteNumber_(change.updatedAt) ? change.updatedAt : 0
  out.version = isFiniteNumber_(change.version) ? change.version : 0
  out.deviceId = typeof change.deviceId === 'string' && change.deviceId ? change.deviceId : 'server'
  out.deleted =
    change.op === 'delete'
      ? true
      : rec.deleted === true ||
        rec.deleted === 1 ||
        rec.deleted === 'true' ||
        rec.deleted === 'TRUE'

  return { id: change.id, record: out }
}

/**
 * Turns an upsertBlocks item (either a bare record or a
 * { id, record, updatedAt, version, deviceId } wrapper) into { id, record }.
 * `projectId` is always forced to the request's projectId so blocks cannot
 * leak into another project.
 *
 * @param {*} item        Raw block entry.
 * @param {string} projectId Owning project.
 * @param {number} i      Index (for error messages).
 * @return {{id:string, record:Object}} Normalised entry.
 * @private
 */
function normalizeBlockEntry_(item, projectId, i) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throwCoded_('BAD_REQUEST', 'blocks[' + i + '] must be an object.')
  }
  var wrapped = item.record && typeof item.record === 'object' && !Array.isArray(item.record)
  var rec = wrapped ? item.record : item
  var id =
    typeof item.id === 'string' && item.id
      ? item.id
      : typeof rec.id === 'string' && rec.id
        ? rec.id
        : ''
  if (!id) {
    throwCoded_('BAD_REQUEST', 'blocks[' + i + '] is missing a string id.')
  }

  var updatedAt = item.updatedAt !== undefined ? item.updatedAt : rec.updatedAt
  if (updatedAt === undefined || updatedAt === null) updatedAt = Date.now()
  if (!isFiniteNumber_(updatedAt)) {
    throwCoded_('BAD_REQUEST', 'blocks[' + i + '].updatedAt must be a finite number.')
  }

  var version = item.version !== undefined ? item.version : rec.version
  if (version === undefined || version === null) version = 0
  if (!isFiniteNumber_(version)) {
    throwCoded_('BAD_REQUEST', 'blocks[' + i + '].version must be a finite number.')
  }

  var out = {}
  for (var k in rec) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k]
  }
  out.id = id
  out.updatedAt = updatedAt
  out.version = version
  out.deviceId =
    typeof item.deviceId === 'string' && item.deviceId
      ? item.deviceId
      : typeof rec.deviceId === 'string' && rec.deviceId
        ? rec.deviceId
        : 'server'
  out.deleted = rec.deleted === true || rec.deleted === 1 || rec.deleted === 'true'
  out.projectId = projectId

  assertNotSecretSetting_(defForEntity_('blocks'), out)
  return { id: id, record: out }
}

/**
 * Last-write-wins core: the incoming record wins only when its updatedAt is
 * strictly greater, or timestamps tie and its version is strictly greater,
 * or both tie and its deviceId is strictly greater. Equal records are
 * reported as `skipped`, which makes retried pushes idempotent.
 *
 * @param {Object} incoming Normalised incoming record.
 * @param {Object} existing Record currently in the sheet.
 * @return {boolean} True when the incoming record should be written.
 * @private
 */
function incomingWins_(incoming, existing) {
  var inUpdated = Number(incoming.updatedAt) || 0
  var exUpdated = Number(existing.updatedAt) || 0
  if (inUpdated !== exUpdated) return inUpdated > exUpdated

  var inVersion = Number(incoming.version) || 0
  var exVersion = Number(existing.version) || 0
  if (inVersion !== exVersion) return inVersion > exVersion

  return String(incoming.deviceId || '') > String(existing.deviceId || '')
}

/**
 * Applies one normalised entry to an in-memory sheet copy (append when the
 * id is new, otherwise LWW against the stored row).
 *
 * @param {Object} data  readSheet_ result (rows mutated in place).
 * @param {Object} index id → row index map (updated on append).
 * @param {Object} def   Sheet definition.
 * @param {{id:string, record:Object}} entry Normalised entry.
 * @param {Object} stats {truncated} counter (mutated).
 * @return {{status:string, row?:number, values?:Array<*>}} applied|skipped.
 * @private
 */
function stageApply_(data, index, def, entry, stats) {
  var existingIdx = index[entry.id]
  if (existingIdx === undefined) {
    var newRow = recordToRow_(def, entry.record, stats)
    data.rows.push(newRow)
    var newIdx = data.rows.length - 1
    index[entry.id] = newIdx
    return { status: 'applied', row: newIdx + 2, values: newRow }
  }

  var existing = rowToRecord_(def, data.rows[existingIdx])
  if (!incomingWins_(entry.record, existing)) {
    return { status: 'skipped' }
  }

  var values = recordToRow_(def, entry.record, stats)
  data.rows[existingIdx] = values
  return { status: 'applied', row: existingIdx + 2, values: values }
}

/**
 * Refuses to persist a Settings record whose key name (or any field name)
 * looks like a credential. API keys are never synced to the cloud — they
 * live only in the browser, encrypted with WebCrypto AES-GCM.
 *
 * @param {Object} def  Sheet definition.
 * @param {Object} rec  Record about to be written.
 * @throws {Error} codedError_('SECRET_NOT_ALLOWED') when a secret is detected.
 * @private
 */
function assertNotSecretSetting_(def, rec) {
  if (!def || def.name !== 'Settings') return

  var names = [rec.id]
  for (var k in rec) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) names.push(k)
  }
  for (var i = 0; i < names.length; i++) {
    var name = String(names[i])
    if (SECRET_RE_.test(name)) {
      throwCoded_(
        'SECRET_NOT_ALLOWED',
        'Refusing to sync "' + name + '": API keys and secrets are never stored in the cloud.',
      )
    }
  }
}

/* ==========================================================================
 * Validation helpers (all failures are coded BAD_REQUEST errors)
 * ========================================================================== */

/**
 * Creates an Error carrying a machine-readable `code`.
 *
 * @param {string} code    One of the documented error codes.
 * @param {string} message Safe, non-sensitive message.
 * @return {Error} Coded error.
 * @private
 */
function codedError_(code, message) {
  var err = new Error(message)
  err.code = code
  return err
}

/**
 * Throws a coded error (never includes request payloads or the token).
 *
 * @param {string} code    One of the documented error codes.
 * @param {string} message Safe, non-sensitive message.
 * @throws {Error} Always.
 * @private
 */
function throwCoded_(code, message) {
  throw codedError_(code, message)
}

/**
 * @param {*} v            Candidate value.
 * @return {boolean} True when v is a finite JS number.
 * @private
 */
function isFiniteNumber_(v) {
  return typeof v === 'number' && isFinite(v)
}

/**
 * Requires a finite number.
 *
 * @param {*} v       Candidate value.
 * @param {string} name Field name for the error message.
 * @return {number} The validated number.
 * @private
 */
function requireFiniteNumber_(v, name) {
  if (!isFiniteNumber_(v)) {
    throwCoded_('BAD_REQUEST', name + ' must be a finite number.')
  }
  return v
}

/**
 * Requires a non-empty string of bounded length.
 *
 * @param {*} v       Candidate value.
 * @param {string} name Field name for the error message.
 * @return {string} The validated string.
 * @private
 */
function requireString_(v, name) {
  if (typeof v !== 'string' || v.length === 0) {
    throwCoded_('BAD_REQUEST', name + ' must be a non-empty string.')
  }
  if (v.length > 512) {
    throwCoded_('BAD_REQUEST', name + ' is too long.')
  }
  return v
}

/**
 * Requires an integer inside [min, max].
 *
 * @param {*} v       Candidate value.
 * @param {string} name Field name for the error message.
 * @param {number} min Inclusive minimum.
 * @param {number} max Inclusive maximum.
 * @return {number} The validated integer.
 * @private
 */
function requireInt_(v, name, min, max) {
  if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v) {
    throwCoded_('BAD_REQUEST', name + ' must be an integer.')
  }
  if (v < min || v > max) {
    throwCoded_('BAD_REQUEST', name + ' must be between ' + min + ' and ' + max + '.')
  }
  return v
}

/**
 * Shared execution-time budget for chunked actions.
 *
 * @param {number} start Request start time (ms).
 * @return {{start:number, expired:function():boolean}} Budget probe.
 * @private
 */
function makeBudget_(start) {
  return {
    start: start,
    expired: function () {
      return Date.now() - start > EXEC_BUDGET_MS_
    },
  }
}

/* ==========================================================================
 * SyncLog (audit trail) + response helpers
 * ========================================================================== */

/**
 * Appends one audit row: { timestamp, deviceId, action, rowsIn, rowsOut,
 * status, message }. Takes the script lock briefly so two concurrent runs
 * cannot overwrite each other's row; if the lock is busy the log line is
 * dropped — losing an audit row must never break a sync response.
 *
 * Cost note: this is a single setValues() of one row per action (one write
 * call, not one per cell). Buffering many actions is possible but would lose
 * the entry whenever the script is killed at the 6-minute limit, so one
 * small write per request is the deliberate trade-off.
 *
 * @param {Object} ctx {deviceId, action, rowsIn, rowsOut, status, message}.
 * @private
 */
function writeSyncLog_(ctx) {
  var lock = LockService.getScriptLock()
  try {
    lock.waitLock(LOG_LOCK_WAIT_MS_)
  } catch (lockErr) {
    return // Lock busy — skip this audit row rather than fail the request.
  }
  try {
    var ss = getSpreadsheet_()
    var sh = ss.getSheetByName(LOG_SHEET_)
    if (!sh) {
      createMissingSheets_(ss)
      sh = ss.getSheetByName(LOG_SHEET_)
      if (!sh) return
    }
    var lastRow = sh.getLastRow()
    if (lastRow < 1) {
      sh.getRange(1, 1, 1, LOG_HEADERS_.length).setValues([LOG_HEADERS_.slice()])
      lastRow = 1
    }
    var row = [
      [
        new Date().toISOString(),
        safeText_(ctx.deviceId, 128),
        safeText_(ctx.action, 64),
        Number(ctx.rowsIn) || 0,
        Number(ctx.rowsOut) || 0,
        safeText_(ctx.status, 16),
        safeText_(ctx.message, 400),
      ],
    ]
    sh.getRange(lastRow + 1, 1, 1, LOG_HEADERS_.length).setValues(row)
  } catch (logErr) {
    // Audit logging must never propagate into the response path.
  } finally {
    lock.releaseLock()
  }
}

/**
 * Builds a one-line summary of a successful response for SyncLog.message.
 *
 * @param {Object} res Response payload.
 * @return {string} Compact summary (no secrets).
 * @private
 */
function summarise_(res) {
  if (!res || typeof res !== 'object') return 'OK'
  var parts = []
  var keys = [
    'applied',
    'skipped',
    'deferred',
    'truncated',
    'count',
    'processed',
    'total',
    'partial',
  ]
  for (var i = 0; i < keys.length; i++) {
    if (res[keys[i]] !== undefined && res[keys[i]] !== null && res[keys[i]] !== false) {
      parts.push(keys[i] + '=' + res[keys[i]])
    }
  }
  if (res.ok === true && parts.length === 0) parts.push('pong')
  return safeText_(parts.join(' '), 400)
}

/**
 * Collapses whitespace and caps length so log cells and messages stay small
 * and single-line (never includes the token — callers pass authored text).
 *
 * @param {*} v Raw value.
 * @param {number} max Max characters.
 * @return {string} Safe text.
 * @private
 */
function safeText_(v, max) {
  if (v === null || v === undefined) return ''
  var s = String(v)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Wraps a payload in the standard JSON envelope used by every path,
 * including all errors.
 *
 * @param {Object} payload Response object.
 * @return {ContentService.TextOutput} JSON output.
 * @private
 */
function jsonOut_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  )
}
