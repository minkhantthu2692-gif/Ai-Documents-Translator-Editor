/**
 * Table-row detection.
 *
 * Split out of `structure.ts` because it is needed by *two* consumers with
 * opposite instincts: the block builder wants to know whether a run of lines is
 * a table, and the reading-order pass wants to know which lines it must leave
 * alone. Both live in modules that would otherwise have to import each other.
 *
 * A table row is a single visual line whose cells ride the same baseline.
 * That merge is load-bearing — the cells only read as one row *because* they
 * were clustered together — so anything that cuts a line apart at its internal
 * gaps must not cut here.
 */

import type { GroupedLine } from './lineGrouping'

export interface CellSplit {
  isTable: boolean
  cells: string[]
}

/** Detects short cells separated by wide, aligned gaps (table rows). */
export function splitRow(line: GroupedLine): CellSplit {
  const raw = line.text
  const parts = raw.split(/\s{2,}|\t/)
  if (parts.length < 2) return { isTable: false, cells: [raw] }
  const cells = parts.map((part) => part.trim()).filter(Boolean)
  const allShort = cells.every((cell) => cell.length <= 60)
  const wideGap = /\s{3,}|\t/.test(raw) || raw.includes('  ')
  return { isTable: allShort && wideGap && cells.length >= 2, cells }
}

/** True when a line must be kept whole because it reads as a table row. */
export function looksLikeTableRow(line: GroupedLine): boolean {
  return splitRow(line).isTable
}
