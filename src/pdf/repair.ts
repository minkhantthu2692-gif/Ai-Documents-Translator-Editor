/**
 * Damaged-structure repair — the salvage path behind the PDF_CORRUPTED wall.
 *
 * pdf.js already recovers a great deal on its own: a missing `%PDF-` header,
 * junk before it, `startxref` values pointing at garbage, `startxref`
 * missing entirely, a tail chopped after the trailer — in each case it warns
 * "Indexing all PDF objects" and rebuilds the cross-reference from a byte
 * scan (probed against the shipped build). Three shapes defeat it:
 *
 * - the xref *table* is destroyed while `startxref` still points at it (the
 *   indexer only adopts a trailer when it stumbles on a parseable `xref`
 *   keyword, and a blanked `startxref` is no escape either),
 * - `/Root` names an object that does not exist,
 * - the trailer is gone entirely.
 *
 * The repair for all three is one append-only move: rebuild a classic xref
 * table from a byte scan of `N G obj` headers and append it with a fresh
 * trailer (`/Root` retargeted at the last `<< /Type /Catalog >>` the scan
 * found), `startxref` and `%%EOF`. The original bytes are never touched —
 * the tail is pure ASCII — so a wrong guess cannot make things worse; if the
 * catalog itself is not directly readable (gone, or packed inside a
 * compressed object stream) there is nothing to retarget and we return
 * `null`, letting the caller report the failure it already knew how to
 * report.
 *
 * `fixes` is a short human-readable list for the event log.
 */

/** More than this many objects and the rebuilt table would dwarf the file. */
const MAX_OBJECT_NUMBER = 500_000

/** Window after a catalog candidate that is scanned for `/Type /Catalog`. */
const OBJECT_HEADER = /(?<![\d])(\d+) (\d+) obj[\s<]/g
const CATALOG = /\/Type\s*\/Catalog\b/g

export interface PdfRepairResult {
  /** Original bytes with the rebuilt tail appended. */
  bytes: Uint8Array
  /** What was done, in order — for the log. */
  fixes: string[]
}

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  pattern.lastIndex = 0
  let last: RegExpExecArray | null = null
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) last = found
  return last
}

/** Object number whose header the keyword at `index` sits under, or null. */
function objectNumberBefore(text: string, index: number): number | null {
  for (let at = text.lastIndexOf('obj', index); at >= 0; at = text.lastIndexOf('obj', at - 1)) {
    const before = text.slice(Math.max(0, at - 24), at).trimEnd()
    const match = /(\d+) (\d+)$/.exec(before)
    if (match) return Number(match[1])
    // `obj` inside `endobj`: keep looking. Anything else is not a header.
    if (!/end$/.test(before)) return null
  }
  return null
}

/**
 * Appends a rebuilt xref + trailer so pdf.js can open a file whose own index
 * is beyond its self-recovery. `null` when even that cannot help.
 */
export function repairPdf(bytes: Uint8Array): PdfRepairResult | null {
  const text = new TextDecoder('windows-1252').decode(bytes)

  // Every `N G obj` header, last occurrence wins — incremental updates put
  // the newest version of an object later in the file.
  const offsets = new Map<number, { offset: number; generation: number }>()
  OBJECT_HEADER.lastIndex = 0
  for (let found = OBJECT_HEADER.exec(text); found; found = OBJECT_HEADER.exec(text)) {
    offsets.set(Number(found[1]), { offset: found.index, generation: Number(found[2]) })
  }
  if (offsets.size === 0) return null

  // The catalog: the /Type keyword a byte scan can actually see. Compressed
  // object streams never show it, which is exactly the honest "not
  // repairable" case.
  const catalog = lastMatch(text, CATALOG)
  if (!catalog) return null
  const root = objectNumberBefore(text, catalog.index)
  if (root === null || !offsets.has(root)) return null

  // /Info survives when it was nameable and the object it names survived.
  const infoMatch = lastMatch(text, /\/Info\s+(\d+)\s+\d+\s+R(?![\d])/g)
  const info =
    infoMatch && offsets.has(Number(infoMatch[1])) && Number(infoMatch[1]) !== root
      ? Number(infoMatch[1])
      : null

  let max = 0
  for (const number of offsets.keys()) if (number > max) max = number
  const size = max + 1
  if (size > MAX_OBJECT_NUMBER) return null

  let table = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let number = 1; number < size; number++) {
    const entry = offsets.get(number)
    table +=
      entry === undefined
        ? '0000000000 65535 f \n'
        : `${String(entry.offset).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} n \n`
  }
  const infoRef = info === null ? '' : ` /Info ${info} 0 R`
  const tail =
    table +
    `trailer\n<< /Size ${size} /Root ${root} 0 R${infoRef} >>\n` +
    `startxref\n${bytes.length}\n%%EOF\n`

  // What was actually wrong with the old index, from the reader's side.
  const fixes = ['rebuilt-xref-table']
  const oldRoot = lastMatch(text, /\/Root\s+(\d+)\s+\d+\s+R(?![\d])/g)
  if (!oldRoot) fixes.push('appended-trailer')
  else if (Number(oldRoot[1]) !== root) fixes.push('retargeted-root')

  const repaired = new Uint8Array(bytes.length + tail.length)
  repaired.set(bytes, 0)
  repaired.set(new TextEncoder().encode(tail), bytes.length)
  return { bytes: repaired, fixes }
}
