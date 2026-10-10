/**
 * Damaged-structure repair (type 20). Every fixture is one minimal 1-page
 * PDF damaged in a way pdf.js provably cannot self-heal (probed against the
 * shipped build: it recovers a missing header, junk before the header,
 * garbage `startxref` targets and a missing tail on its own — these three
 * shapes and the "catalog is gone" shape are what is left).
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist'
import { ensurePdfRuntimeSupport } from './pdfRuntime'
import { repairPdf } from './repair'

// pdf.js reads document fingerprints eagerly and needs the toHex shim.
ensurePdfRuntimeSupport()

/* ------------------------------ fixtures ---------------------------- */

function buildPdf(): string {
  const content = 'BT 72 720 Td (Hello repair) Tj ET\n'
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  ]
  const header = '%PDF-1.4\n'
  let body = header
  const offsets = [0]
  for (const object of objects) {
    offsets.push(body.length)
    body += object
  }
  const xrefPos = body.length
  let xref = 'xref\n0 5\n0000000000 65535 f \n'
  for (let i = 1; i <= 4; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const tail = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return header + body + xref + tail
}

const base = buildPdf()

/** xref table destroyed while `startxref` still points at it. */
const noXrefTable = base.replace(
  /xref\n0 5\n(?:\d{10} \d{5} [fn] \n)+/,
  'x'.repeat(base.indexOf('trailer') - base.indexOf('xref\n0 5')),
)

/** /Root names an object that does not exist. */
const badRoot = base.replace('/Root 1 0 R', '/Root 9 0 R')

/** Trailer, startxref and part of the table chopped off. */
const truncatedTail = base.slice(0, base.length - 70)

/** The catalog object itself is gone — nothing to retarget at. */
const missingCatalog = base.replace('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', '')

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function open(repaired: Uint8Array): Promise<number> {
  const task = getDocument({ data: repaired.slice() })
  const doc = await task.promise
  const pages = doc.numPages
  await task.destroy()
  return pages
}

/* -------------------------------- tests ------------------------------ */

describe('repairPdf', () => {
  it('appends a rebuilt tail and never touches the original bytes', () => {
    const source = bytes(noXrefTable)
    const result = repairPdf(source)
    expect(result).not.toBeNull()
    // Byte-identical prefix: a wrong guess cannot corrupt anything.
    expect(Array.from(result!.bytes.subarray(0, source.length))).toEqual(Array.from(source))
    const tail = new TextDecoder('windows-1252').decode(result!.bytes.subarray(source.length))
    expect(tail).toContain('xref\n0 5\n')
    expect(tail).toContain('/Root 1 0 R')
    expect(tail.trimEnd().endsWith('%%EOF')).toBe(true)
    // The new startxref points at where the table now begins.
    const startxref = Number(/startxref\n(\d+)/.exec(tail)?.[1])
    expect(startxref).toBe(source.length)
  })

  it('reports each defect it diagnosed alongside the rebuild', () => {
    expect(repairPdf(bytes(truncatedTail))?.fixes).toEqual([
      'rebuilt-xref-table',
      'appended-trailer',
    ])
    expect(repairPdf(bytes(badRoot))?.fixes).toEqual(['rebuilt-xref-table', 'retargeted-root'])
    expect(repairPdf(bytes(noXrefTable))?.fixes).toEqual(['rebuilt-xref-table'])
  })

  it('keeps the newest version of an object and its generation', () => {
    // An incremental update: a second object 4 with generation 2.
    const updated =
      base.slice(0, base.indexOf('xref\n0 5')) +
      '4 2 obj\n<< /Type /Updated >>\nendobj\n' +
      base.slice(base.indexOf('xref\n0 5'))
    const result = repairPdf(bytes(updated))
    expect(result).not.toBeNull()
    const tail = new TextDecoder('windows-1252').decode(result!.bytes.subarray(updated.length))
    // Object 4's entry must point at the update, generation kept.
    const fourth = tail.split('\n').find((line) => line.endsWith(' 00002 n '))
    expect(fourth).toBeDefined()
    const offset = Number(fourth!.slice(0, 10))
    const at = new TextDecoder('windows-1252').decode(result!.bytes.subarray(offset, offset + 12))
    expect(at).toContain('4 2 obj')
  })

  it('returns null when the catalog itself is not readable', () => {
    expect(repairPdf(bytes(missingCatalog))).toBeNull()
  })

  it('returns null when there is nothing to index', () => {
    expect(repairPdf(bytes('not a pdf at all'))).toBeNull()
    expect(repairPdf(new Uint8Array(0))).toBeNull()
  })

  it('carries /Info through when the metadata object survived', () => {
    const withInfo =
      base.slice(0, base.indexOf('xref\n0 5')) +
      '6 0 obj\n<< /Title (Repaired) >>\nendobj\n' +
      base.replace('/Size 5', '/Size 7 /Info 6 0 R').slice(base.indexOf('xref\n0 5'))
    const result = repairPdf(bytes(withInfo))
    const tail = new TextDecoder('windows-1252').decode(result!.bytes.subarray(withInfo.length))
    expect(tail).toContain('/Info 6 0 R')
  })

  it('opens as a real document once repaired', async () => {
    for (const damaged of [noXrefTable, badRoot, truncatedTail]) {
      const result = repairPdf(bytes(damaged))
      expect(result).not.toBeNull()
      await expect(open(result!.bytes)).resolves.toBe(1)
    }
  })
})
