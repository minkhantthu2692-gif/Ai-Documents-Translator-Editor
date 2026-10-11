/**
 * An in-memory Google Apps Script runtime — enough of `SpreadsheetApp`,
 * `LockService`, `PropertiesService` and `ContentService` for the REAL
 * `apps-script/Code.gs` to run unchanged inside a vitest file.
 *
 * Why execute the file at all: Code.gs is the half of the sync protocol that
 * actually holds the user's data, and until now it had only a hand-written
 * twin in the tests. A twin can agree with the client by accident. Evaluating
 * the shipped file proves the wire contract, the schema mapping, the
 * last-write-wins rules and the formula-injection guard against the code a
 * user pastes into their Sheet.
 *
 * Fidelity notes (each one exists because the backend relies on it):
 *  - `setValues` PARSES a string on the way in unless the destination is
 *    formatted Plain Text (`@`): an `=`-prefixed value becomes a formula, a
 *    numeric-looking one becomes a number, a date-looking one becomes a date.
 *    That is the behaviour `writePlain_` exists to defeat, so the mock
 *    reproduces it and counts every formula it had to create.
 *  - `getLastRow` / `getLastColumn` are content-based (blank cells do not
 *    count), which is what makes `wipe` shrink a sheet back to its header.
 *  - `getProperty` answers `null` for a missing Script Property, and
 *    `waitLock` can be made to throw so LOCK_TIMEOUT is reachable.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Cell = string | number | boolean | Date | null

const PLAIN_TEXT_FORMAT = '@'
const GENERAL_FORMAT = 'General'

function isBlank(value: Cell): boolean {
  return value === '' || value === null || value === undefined
}

/** Numbers, TRUE/FALSE, dates and formulas are what Sheets re-parses on write. */
function looksNumeric(value: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())
}

function looksLikeDate(value: string): boolean {
  const text = value.trim()
  if (!/^\d{4}-\d{1,2}-\d{1,2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text)) {
    return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)
  }
  return Number.isFinite(Date.parse(text))
}

export interface RuntimeStats {
  /** Cells that became live formulas — must stay at 0 for synced content. */
  formulaWrites: number
  /** Cells coerced to a number / boolean / date on write. */
  coercedWrites: number
  /** setValues() calls performed (write amplification probes). */
  setValuesCalls: number
  /** Rows deleted from SyncLog by the trimmer. */
  logRowsPruned: number
}

export interface RuntimeHooks {
  /**
   * Fired after every `setValues()`. The backend checks its 5-minute budget
   * between sheets, so a test that moves the clock from here can expire it
   * mid-push deterministically — without guessing how often vitest itself
   * calls `Date.now`.
   */
  onSheetWrite?: (sheet: string) => void
}

class MockRange {
  constructor(
    private readonly sheet: MockSheet,
    private readonly row: number,
    private readonly col: number,
    private readonly rows: number,
    private readonly cols: number,
  ) {}

  getValues(): Cell[][] {
    const out: Cell[][] = []
    for (let i = 0; i < this.rows; i += 1) {
      const line: Cell[] = []
      for (let j = 0; j < this.cols; j += 1) line.push(this.sheet.cell(this.row + i, this.col + j))
      out.push(line)
    }
    return out
  }

  setValues(values: Cell[][]): this {
    this.sheet.stats.setValuesCalls += 1
    for (let i = 0; i < values.length; i += 1) {
      for (let j = 0; j < values[i].length; j += 1) {
        this.sheet.writeCell(this.row + i, this.col + j, values[i][j])
      }
    }
    this.sheet.notifyWrite()
    return this
  }

  setNumberFormat(format: string): this {
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1)
        this.sheet.setFormat(this.row + i, this.col + j, format)
    }
    return this
  }

  getNumberFormat(): string {
    return this.sheet.format(this.row, this.col)
  }

  clearContent(): this {
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) this.sheet.writeCell(this.row + i, this.col + j, '')
    }
    return this
  }
}

class MockSheet {
  private readonly values: Cell[][] = []
  private readonly formats: string[][] = []

  constructor(
    readonly name: string,
    /** Shared across every tab — the runtime reports one set of counters. */
    readonly stats: RuntimeStats,
    private readonly hooks: RuntimeHooks,
  ) {}

  notifyWrite(): void {
    this.hooks.onSheetWrite?.(this.name)
  }

  /** 1-based cell access; anything outside the used range reads as ''. */
  cell(row: number, col: number): Cell {
    return this.values[row - 1]?.[col - 1] ?? ''
  }

  format(row: number, col: number): string {
    return this.formats[row - 1]?.[col - 1] ?? GENERAL_FORMAT
  }

  setFormat(row: number, col: number, format: string): void {
    this.grow(row, col)
    this.formats[row - 1][col - 1] = format
  }

  writeCell(row: number, col: number, value: Cell): void {
    this.grow(row, col)
    this.values[row - 1][col - 1] = this.parse(value, this.format(row, col))
  }

  /** Sheets parses on the way in — unless the cell is Plain Text. */
  private parse(value: Cell, format: string): Cell {
    if (format === PLAIN_TEXT_FORMAT || typeof value !== 'string' || value === '') return value
    // Google Sheets turns a leading '=', '+' or '@' into a formula, so a
    // phone number and a spreadsheet function are equally dangerous here.
    if (value.startsWith('=') || value.startsWith('+') || value.startsWith('@')) {
      this.stats.formulaWrites += 1
      return `#FORMULA:${value}`
    }
    if (value === 'TRUE' || value === 'FALSE') {
      this.stats.coercedWrites += 1
      return value === 'TRUE'
    }
    if (looksNumeric(value)) {
      this.stats.coercedWrites += 1
      return Number(value)
    }
    if (looksLikeDate(value)) {
      this.stats.coercedWrites += 1
      return new Date(value)
    }
    return value
  }

  private grow(row: number, col: number): void {
    while (this.values.length < row) {
      this.values.push([])
      this.formats.push([])
    }
    const index = row - 1
    while (this.values[index].length < col) {
      this.values[index].push('')
      this.formats[index].push(GENERAL_FORMAT)
    }
  }

  getRange(row: number, col: number, rows: number, cols: number): MockRange {
    if (rows < 1 || cols < 1) throw new Error(`invalid range ${rows}x${cols}`)
    return new MockRange(this, row, col, rows, cols)
  }

  getLastRow(): number {
    for (let r = this.values.length - 1; r >= 0; r -= 1) {
      if (this.values[r].some((value) => !isBlank(value))) return r + 1
    }
    return 0
  }

  getLastColumn(): number {
    let widest = 0
    for (const row of this.values) {
      for (let c = row.length - 1; c >= 0; c -= 1) {
        if (!isBlank(row[c])) {
          widest = Math.max(widest, c + 1)
          break
        }
      }
    }
    return widest
  }

  deleteRows(row: number, numRows: number): void {
    this.stats.logRowsPruned += Math.max(0, numRows)
    this.values.splice(row - 1, numRows)
    this.formats.splice(row - 1, numRows)
  }

  /** Raw grid (header included) — test assertions read the sheet through it. */
  grid(): Cell[][] {
    return this.values.map((row) => row.slice())
  }

  header(): string[] {
    return (this.values[0] ?? []).map((value) => String(value))
  }

  /** Values of one data row, keyed by column name. */
  rowById(id: string): Record<string, Cell> | undefined {
    const header = this.header()
    for (let r = 1; r < this.values.length; r += 1) {
      if (String(this.values[r][0]) !== id) continue
      const out: Record<string, Cell> = {}
      header.forEach((name, index) => {
        out[name] = this.values[r][index] ?? ''
      })
      return out
    }
    return undefined
  }

  dataRowCount(): number {
    return Math.max(0, this.getLastRow() - 1)
  }
}

class MockSpreadsheet {
  private readonly sheets = new Map<string, MockSheet>()

  constructor(
    private readonly stats: RuntimeStats,
    private readonly hooks: RuntimeHooks,
  ) {}

  getSheetByName(name: string): MockSheet | undefined {
    return this.sheets.get(name)
  }

  insertSheet(name: string): MockSheet {
    if (this.sheets.has(name)) throw new Error(`sheet exists: ${name}`)
    const sheet = new MockSheet(name, this.stats, this.hooks)
    this.sheets.set(name, sheet)
    return sheet
  }

  names(): string[] {
    return [...this.sheets.keys()]
  }

  all(): MockSheet[] {
    return [...this.sheets.values()]
  }
}

export interface BackendCall {
  action: string
  body: Record<string, unknown>
}

export interface AppsScriptBackend {
  /** Runs the shipped `doPost` with the body SyncClient would send. */
  post(body: Record<string, unknown>): Record<string, unknown>
  /** Runs the shipped `doGet` with an optional `token` query parameter. */
  health(token?: string): Record<string, unknown>
  /** Seals the next `n` lock acquisitions (LOCK_TIMEOUT reachability). */
  failLocks(n: number): void
  setProperties(values: Record<string, string>): void
  sheet(name: string): MockSheet | undefined
  spreadsheet(): MockSpreadsheet
  /** Test hooks (see RuntimeHooks). */
  hooks: RuntimeHooks
  stats: RuntimeStats
  calls: BackendCall[]
}

/** The shipped backend, read from disk exactly as the download button sends it. */
export function appsScriptSource(): string {
  return readFileSync(join(process.cwd(), 'apps-script', 'Code.gs'), 'utf8')
}

export interface BackendOptions {
  /** Script Properties to seed (TOKEN, SPREADSHEET_ID, …). */
  properties?: Record<string, string>
}

export function createBackend(options: BackendOptions = {}): AppsScriptBackend {
  const stats: RuntimeStats = {
    formulaWrites: 0,
    coercedWrites: 0,
    setValuesCalls: 0,
    logRowsPruned: 0,
  }
  const hooks: RuntimeHooks = {}
  const spreadsheet = new MockSpreadsheet(stats, hooks)
  const properties = new Map<string, string>(Object.entries(options.properties ?? {}))
  const calls: BackendCall[] = []
  let lockFailures = 0

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    openById: () => spreadsheet,
  }
  const LockService = {
    getScriptLock: () => ({
      waitLock: (_ms: number) => {
        if (lockFailures > 0) {
          lockFailures -= 1
          throw new Error('timeout')
        }
      },
      releaseLock: () => undefined,
    }),
  }
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key: string) => (properties.has(key) ? properties.get(key) : null),
    }),
  }
  const ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput: (text: string) => ({
      text,
      mimeType: null as string | null,
      setMimeType(type: string) {
        this.mimeType = type
        return this
      },
    }),
  }

  // Code.gs is plain global-scope Apps Script: evaluate it as a function body
  // and hand back the two entry points, unchanged.
  const factory = new Function(
    'SpreadsheetApp',
    'LockService',
    'PropertiesService',
    'ContentService',
    `${appsScriptSource()}\n;return { doGet: doGet, doPost: doPost };`,
  ) as (
    sa: unknown,
    ls: unknown,
    ps: unknown,
    cs: unknown,
  ) => {
    doGet: (e: unknown) => { text: string }
    doPost: (e: unknown) => { text: string }
  }
  const api = factory(SpreadsheetApp, LockService, PropertiesService, ContentService)

  const run = (body: Record<string, unknown>): Record<string, unknown> => {
    calls.push({ action: String(body.action ?? ''), body })
    const output = api.doPost({ postData: { contents: JSON.stringify(body) } })
    return JSON.parse(output.text) as Record<string, unknown>
  }

  return {
    post: run,
    health: (token?: string) => {
      const output = api.doGet({ parameter: token === undefined ? {} : { token } })
      return JSON.parse(output.text) as Record<string, unknown>
    },
    failLocks: (n: number) => {
      lockFailures = n
    },
    setProperties: (values: Record<string, string>) => {
      for (const [key, value] of Object.entries(values)) properties.set(key, value)
    },
    sheet: (name: string) => spreadsheet.getSheetByName(name),
    spreadsheet: () => spreadsheet,
    hooks,
    stats,
    calls,
  }
}

/** Shorthand for the assertions every suite leans on. */
export function expectOk(
  response: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  if (response.ok !== true) {
    throw new Error(
      `${context}: expected ok, got ${String(response.code)} — ${String(response.message)}`,
    )
  }
  return response
}

export function expectCoded(
  response: Record<string, unknown>,
  code: string,
  context: string,
): Record<string, unknown> {
  if (response.ok !== false || response.code !== code) {
    throw new Error(
      `${context}: expected ${code}, got ${String(response.code)} / ${String(response.ok)}`,
    )
  }
  return response
}
