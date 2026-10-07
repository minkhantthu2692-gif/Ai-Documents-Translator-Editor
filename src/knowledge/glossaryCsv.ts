/**
 * Glossary CSV / TSV import & export (Phase 4).
 *
 * The interchange format has to survive Excel, Google Sheets and a text
 * editor, so it is RFC 4180 (CRLF, doubled quotes, header row) with an
 * auto-detected delimiter. Column names are matched leniently because every
 * tool exports a slightly different header.
 */

export interface GlossaryCsvRow {
  sourceTerm: string
  targetTerm: string
  notes: string
  caseSensitive: boolean
}

export interface GlossaryParseResult {
  rows: GlossaryCsvRow[]
  /** Rows that could not be understood (missing term, too few columns). */
  errors: Array<{ line: number; reason: string }>
  /** Columns detected in the header (for the UI summary). */
  columns: string[]
  delimiter: ',' | '\t'
}

const SOURCE_ALIASES = [
  'sourceterm',
  'source',
  'source_term',
  'from',
  'original',
  'orig',
  'term',
  'my',
  'myanmar',
  'input',
]
const TARGET_ALIASES = [
  'targetterm',
  'target',
  'target_term',
  'to',
  'translation',
  'translated',
  'trans',
  'en',
  'english',
  'output',
  'definition',
]
const NOTES_ALIASES = ['notes', 'note', 'comment', 'comments', 'description', 'remark']
const CASE_ALIASES = ['casesensitive', 'case_sensitive', 'case', 'cs']

/** Splits one delimited line, honouring quotes and doubled quote escapes. */
export function splitDelimitedLine(line: string, delimiter: ',' | '\t'): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      // Only a quote that *opens* a field quotes it; a stray quote in the
      // middle of a value (`c ""d""`) is data, not syntax.
      if (field.trim().length === 0) {
        field = ''
        quoted = true
      } else {
        field += char
      }
      continue
    }
    if (char === delimiter) {
      out.push(field)
      field = ''
      continue
    }
    field += char
  }
  out.push(field)
  return out.map((value) => value.trim())
}

/**
 * Splits a whole CSV document into records. Newlines inside a quoted value
 * belong to the value, so the record scanner runs before any line splitting.
 */
export function splitRecords(text: string): string[] {
  const out: string[] = []
  let record = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      quoted = !quoted
      record += char
      continue
    }
    if (!quoted && char === '\n') {
      out.push(record)
      record = ''
      continue
    }
    record += char
  }
  if (record.length > 0) out.push(record)
  return out
}

function normaliseHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\uFEFF/, '')
    .replace(/[^a-z_]/g, '')
}

/** Chooses `,` vs tab from the header line (spreadsheets emit both). */
export function detectDelimiter(firstLine: string): ',' | '\t' {
  const tabs = (firstLine.match(/\t/g) ?? []).length
  const commas = (firstLine.match(/,/g) ?? []).length
  return tabs > commas ? '\t' : ','
}

/** Parses a glossary export from any of the common spreadsheet tools. */
export function parseGlossaryCsv(text: string): GlossaryParseResult {
  const clean = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const lines = splitRecords(clean).filter((line, index) => index === 0 || line.trim().length > 0)
  const errors: GlossaryParseResult['errors'] = []
  if (lines.length === 0) return { rows: [], errors, columns: [], delimiter: ',' }

  const delimiter = detectDelimiter(lines[0])
  const header = splitDelimitedLine(lines[0], delimiter).map(normaliseHeader)
  const hasHeader = header.some((cell) => SOURCE_ALIASES.includes(cell))
  const columns = hasHeader ? header : []

  const indexOf = (aliases: string[], fallback: number): number => {
    if (hasHeader) {
      const found = header.findIndex((cell) => aliases.includes(cell))
      if (found >= 0) return found
    }
    return fallback
  }

  const sourceIndex = indexOf(SOURCE_ALIASES, 0)
  const targetIndex = indexOf(TARGET_ALIASES, 1)
  const notesIndex = hasHeader ? indexOf(NOTES_ALIASES, -1) : -1
  const caseIndex = hasHeader ? indexOf(CASE_ALIASES, -1) : -1

  const rows: GlossaryCsvRow[] = []
  const start = hasHeader ? 1 : 0
  for (let i = start; i < lines.length; i += 1) {
    const cells = splitDelimitedLine(lines[i], delimiter)
    const sourceTerm = cells[sourceIndex] ?? ''
    const targetTerm = cells[targetIndex] ?? ''
    if (sourceTerm.length === 0 && targetTerm.length === 0) continue
    if (sourceTerm.length === 0 || targetTerm.length === 0) {
      errors.push({ line: i + 1, reason: 'missing-term' })
      continue
    }
    const caseRaw = caseIndex >= 0 ? (cells[caseIndex] ?? '').toLowerCase() : ''
    rows.push({
      sourceTerm,
      targetTerm,
      notes: notesIndex >= 0 ? (cells[notesIndex] ?? '') : '',
      caseSensitive: caseRaw === 'true' || caseRaw === '1' || caseRaw === 'yes',
    })
  }

  return { rows, errors, columns, delimiter }
}

function escapeCell(value: string, delimiter: ',' | '\t'): string {
  const needsQuotes =
    value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')
  const escaped = value.replace(/"/g, '""')
  return needsQuotes ? `"${escaped}"` : escaped
}

/** Serialises glossary rows as RFC 4180 CSV (CRLF row terminator, no BOM). */
export function buildGlossaryCsv(
  rows: Array<Pick<GlossaryCsvRow, 'sourceTerm' | 'targetTerm'> & Partial<GlossaryCsvRow>>,
  delimiter: ',' | '\t' = ',',
): string {
  const header = ['source', 'target', 'notes', 'case_sensitive'].join(delimiter)
  const body = rows.map((row) =>
    [
      escapeCell(row.sourceTerm, delimiter),
      escapeCell(row.targetTerm, delimiter),
      escapeCell(row.notes ?? '', delimiter),
      escapeCell(row.caseSensitive ? 'true' : 'false', delimiter),
    ].join(delimiter),
  )
  return [header, ...body].join('\r\n') + '\r\n'
}

/** Rows that are duplicates of an earlier row (same source, same target). */
export function duplicateRows(rows: GlossaryCsvRow[]): number[] {
  const seen = new Set<string>()
  const duplicates: number[] = []
  rows.forEach((row, index) => {
    const key = `${row.caseSensitive ? 'cs' : 'ci'}|${row.sourceTerm.trim().toLowerCase()}|${row.targetTerm.trim()}`
    if (seen.has(key)) duplicates.push(index)
    else seen.add(key)
  })
  return duplicates
}
