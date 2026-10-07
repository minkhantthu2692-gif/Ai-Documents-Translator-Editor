/**
 * Generates the local PDF fixtures used by tests and browser smoke checks.
 *
 *   node scripts/make-fixtures.mjs
 *
 * Output (all committed, all small):
 *   fixtures/text-300p.pdf   300 pages of English text, running heads, page
 *                            labels, bullets, a URL, a formula, a small table
 *   fixtures/scanned.pdf     3 pages of raster images, no text layer at all
 *   fixtures/mixed.pdf       page 1 = image + text, page 2 = plain text
 *   fixtures/encrypted.pdf   3 pages, RC4 40-bit (V1/R2), password "secret123"
 *
 * Everything is written by hand (xref offsets computed exactly) so the script
 * only depends on node:crypto for MD5. Content is ASCII so a latin-1 stream
 * encoding stays faithful.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'fixtures')
const PASSWORD = 'secret123'

/* ------------------------------------------------------------------ */
/* Minimal PDF writer                                                  */
/* ------------------------------------------------------------------ */

class PdfWriter {
  constructor() {
    /** Objects in order; `bytes` is set for stream objects, `body` otherwise. */
    this.objects = []
  }

  /** Adds a non-stream object, returns its 1-based object number. */
  add(body) {
    this.objects.push({ num: this.objects.length + 1, body })
    return this.objects.length
  }

  /** Sets the document Info dictionary (referenced from the trailer). */
  setInfo(fields) {
    const body = Object.entries(fields)
      .map(([key, value]) => `/${key} (${escape(value)})`)
      .join(' ')
    const num = this.add(`<< ${body} >>`)
    this.infoNum = num
    return num
  }

  /** Adds a stream object. `dict` may be empty (content streams need no /Type). */
  addStream(dict, content) {
    const num = this.objects.length + 1
    const header = Buffer.from(
      `${num} 0 obj\n<<${dict ? ` ${dict}` : ''} /Length ${content.length} >>\nstream\n`,
      'latin1',
    )
    const footer = Buffer.from('\nendstream\nendobj\n', 'latin1')
    this.objects.push({ num, bytes: Buffer.concat([header, content, footer]) })
    return num
  }

  replaceBody(num, body) {
    this.objects[num - 1].body = body
  }

  /** RC4-encrypts every stream with its own object key (V1 / R2). */
  encryptStreams(encryption) {
    const marker = Buffer.from('\nstream\n')
    const terminator = Buffer.from('\nendstream')
    for (const object of this.objects) {
      if (!object.bytes) continue
      const start = object.bytes.indexOf(marker)
      if (start < 0) continue
      const dataStart = start + marker.length
      const dataEnd = object.bytes.indexOf(terminator, dataStart)
      if (dataEnd < 0) throw new Error(`unterminated stream in object ${object.num}`)
      const plain = object.bytes.subarray(dataStart, dataEnd)
      const cipher = encryption.encryptObject(object.num, 0, plain)
      object.bytes = Buffer.concat([
        object.bytes.subarray(0, dataStart),
        cipher,
        object.bytes.subarray(dataEnd),
      ])
    }
  }

  render(extraTrailer = '') {
    const chunks = []
    let offset = 0
    const push = (buffer) => {
      chunks.push(buffer)
      offset += buffer.length
    }

    push(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'))

    const offsets = [0]
    for (const object of this.objects) {
      offsets[object.num] = offset
      push(object.bytes ?? Buffer.from(`${object.num} 0 obj\n${object.body}\nendobj\n`, 'latin1'))
    }

    const xrefOffset = offset
    const count = this.objects.length + 1
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let num = 1; num < count; num += 1) {
      xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`
    }
    const infoRef = this.infoNum ? ` /Info ${this.infoNum} 0 R` : ''
    xref += `trailer\n<< /Size ${count} /Root 1 0 R${infoRef}${extraTrailer} >>\n`
    xref += `startxref\n${xrefOffset}\n%%EOF\n`
    push(Buffer.from(xref, 'latin1'))

    return Buffer.concat(chunks)
  }
}

/* ------------------------------------------------------------------ */
/* Shared building blocks                                              */
/* ------------------------------------------------------------------ */

const FONT_REGULAR =
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
const FONT_BOLD =
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
const LETTER = '/MediaBox [0 0 612 792]'

function escape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function addPagesObject(writer) {
  writer.add('<< /Type /Catalog /Pages 2 0 R >>') // object 1
  return writer.add('<< /Type /Pages /Kids [] /Count 0 >>') // object 2
}

function addPage(writer, pagesNum, resources, contents) {
  const contentsRef = Array.isArray(contents)
    ? `[${contents.map((num) => `${num} 0 R`).join(' ')}]`
    : `${contents} 0 R`
  return writer.add(
    `<< /Type /Page /Parent ${pagesNum} 0 R ${LETTER} ` +
      `/Resources << ${resources} >> /Contents ${contentsRef} >>`,
  )
}

function finalizePages(writer, pagesNum, kids) {
  writer.replaceBody(
    pagesNum,
    `<< /Type /Pages /Kids [${kids.map((num) => `${num} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  )
}

/**
 * Builds a page content stream: running head, body lines, page label.
 * Coordinates are PDF points, bottom-left origin, 792pt tall letter page.
 */
function contentStream({ head, body, foot, bodySize = 11, leading = 16 }) {
  const parts = []
  parts.push('BT\n')
  parts.push('/F2 9 Tf\n1 0 0 rg\n') // head is drawn in a colour to exercise colours
  parts.push(`72 770 Td (${escape(head)}) Tj\n`)
  parts.push('0 0 0 rg\n/F1 9 Tf\n')
  parts.push(`0 -712 Td (${escape(foot)}) Tj\n`)
  parts.push('ET\n')
  parts.push('BT\n')
  parts.push(`/F1 ${bodySize} Tf\n0 0 0 rg\n`)
  parts.push('72 740 Td\n')
  body.forEach((line, index) => {
    if (index > 0) parts.push(`0 -${leading} Td\n`)
    if (line.length === 0) {
      // A blank line: advance another leading without drawing any glyph, so
      // the extraction pipeline sees a real paragraph break.
      parts.push(`0 -${leading} Td\n`)
      return
    }
    if (line.startsWith('# ')) {
      // Section heading: bold and one size up (exercises font style capture).
      parts.push(`/F2 ${bodySize + 3} Tf\n`)
      parts.push(`(${escape(line.slice(2))}) Tj\n`)
      parts.push(`/F1 ${bodySize} Tf\n`)
      return
    }
    parts.push(`(${escape(line)}) Tj\n`)
  })
  parts.push('ET\n')
  return Buffer.from(parts.join(''), 'latin1')
}

const SENTENCES = [
  'The quarterly review covers revenue, operating costs and headcount across all regions.',
  'Our team finished the migration ahead of schedule and reduced infrastructure spend.',
  'Customers reported faster page loads after the caching layer was enabled by default.',
  'Risk management remains a priority for the board and the audit committee this year.',
  'Inventory levels returned to normal in the second half of the reporting period.',
  'The training programme reached every branch office before the end of March.',
  'Supplier contracts were renegotiated to reflect the new volume commitments.',
  'Employee satisfaction improved after the flexible schedule policy was introduced.',
  'Safety inspections found no critical issues at any of the production facilities.',
  'The mobile application now supports offline editing and automatic synchronisation.',
  'Marketing spent the additional budget on search, events and partner programmes.',
  'Revenue growth was driven mainly by the subscription tier and renewals.',
  'Legal confirmed that the new terms comply with the updated data protection rules.',
  'Research findings will be published in the annual technical report next quarter.',
  'Facilities upgraded the cooling system to reduce energy consumption in the data hall.',
  'Support tickets were resolved faster after the knowledge base was reorganised.',
]

function bodyLines(pageIndex) {
  if (pageIndex === 0) {
    return [
      '# Introduction',
      'This document summarises the operations of the past financial year.',
      // \x95 is the WinAnsi byte for U+2022 (bullet) — written as latin-1 below.
      '\x95 Revenue grew by twelve percent compared with the previous year.',
      '\x95 Operating costs stayed flat despite higher shipment volumes.',
      '\x95 Headcount increased by forty people in the engineering team.',
      '',
      'See https://example.com/docs for the detailed methodology.',
      '',
      'Energy is E=mc^2 when the model is applied to production data.',
    ]
  }
  if (pageIndex === 2) {
    return [
      'Name    Value',
      'Alpha   12',
      'Beta    34',
      'Gamma   56',
      'The table above lists the measured values for each sample group.',
    ]
  }
  return Array.from(
    { length: 18 },
    (_, line) => SENTENCES[(pageIndex * 7 + line) % SENTENCES.length],
  )
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function buildTextPdf(pageCount) {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const kids = []
  for (let index = 0; index < pageCount; index += 1) {
    const stream = writer.addStream(
      '',
      contentStream({
        head: `Annual Report 2026 - Chapter ${Math.floor(index / 20) + 1}`,
        foot: `Page ${index + 1} of ${pageCount}`,
        body: bodyLines(index),
      }),
    )
    kids.push(addPage(writer, pagesNum, resources, stream))
  }
  finalizePages(writer, pagesNum, kids)
  writer.setInfo({
    Title: 'Annual Report 2026',
    Author: 'Finance Department',
    Subject: 'Operations review for the financial year',
    Keywords: 'annual, report, operations',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
  return writer.render()
}

/** An image-only "scan": no text operators anywhere. */
function buildScannedPdf(pageCount) {
  const width = 120
  const height = 156
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)

  const kids = []
  for (let index = 0; index < pageCount; index += 1) {
    // White sheet with black bars, shifted a little every page.
    const pixels = Buffer.alloc(width * height * 3, 0xff)
    for (let row = 0; row < 14; row += 1) {
      const top = 12 + row * 10 + (index % 3)
      const barWidth = width - 20 - ((row * 7 + index * 5) % 30)
      for (let y = top; y < Math.min(top + 5, height); y += 1) {
        for (let x = 10; x < 10 + barWidth; x += 1) {
          const offset = (y * width + x) * 3
          pixels[offset] = 20
          pixels[offset + 1] = 20
          pixels[offset + 2] = 20
        }
      }
    }
    const image = writer.addStream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8',
      pixels,
    )
    const contents = writer.addStream(
      '',
      Buffer.from('q\n612 0 0 792 0 0 cm\n/Im1 Do\nQ\n', 'latin1'),
    )
    kids.push(addPage(writer, pagesNum, `/XObject << /Im1 ${image} 0 R >>`, contents))
  }
  finalizePages(writer, pagesNum, kids)
  return writer.render()
}

function buildMixedPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const fontResources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const width = 90
  const height = 110
  const pixels = Buffer.alloc(width * height * 3, 0xff)
  for (let y = 20; y < 80; y += 8) {
    for (let x = 10; x < 80; x += 1) {
      const offset = (y * width + x) * 3
      pixels[offset] = 30
      pixels[offset + 1] = 90
      pixels[offset + 2] = 160
    }
  }
  const image = writer.addStream(
    `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8',
    pixels,
  )

  const page1Text = writer.addStream(
    '',
    contentStream({
      head: 'Figure 1 - Deployment pipeline',
      foot: 'Page 1',
      body: [
        'The figure shows the stages of the deployment pipeline described below.',
        'Each stage is validated before the next one is allowed to start.',
        'Rollback is automatic when a health check fails twice in a row.',
      ],
    }),
  )
  const page1Image = writer.addStream(
    '',
    Buffer.from('q\n300 0 0 300 280 60 cm\n/Im1 Do\nQ\n', 'latin1'),
  )
  const page1 = addPage(writer, pagesNum, `${fontResources} /XObject << /Im1 ${image} 0 R >>`, [
    page1Text,
    page1Image,
  ])

  const page2Text = writer.addStream(
    '',
    contentStream({ head: 'Details', foot: 'Page 2', body: SENTENCES.slice(0, 12) }),
  )
  const page2 = addPage(writer, pagesNum, fontResources, page2Text)

  finalizePages(writer, pagesNum, [page1, page2])
  return writer.render()
}

/* ------------------------------------------------------------------ */
/* RC4 40-bit encryption (standard security handler, V1 / R2)          */
/* ------------------------------------------------------------------ */

const PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
)

function md5(...chunks) {
  const hash = createHash('md5')
  for (const chunk of chunks) hash.update(chunk)
  return hash.digest()
}

function rc4(key, data) {
  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) box[i] = i
  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (j + box[i] + key[i % key.length]) & 0xff
    const swap = box[i]
    box[i] = box[j]
    box[j] = swap
  }
  const out = Buffer.alloc(data.length)
  let x = 0
  let y = 0
  for (let k = 0; k < data.length; k += 1) {
    x = (x + 1) & 0xff
    y = (y + box[x]) & 0xff
    const swap = box[x]
    box[x] = box[y]
    box[y] = swap
    out[k] = data[k] ^ box[(box[x] + box[y]) & 0xff]
  }
  return out
}

function pad(password) {
  const source = Buffer.from(password, 'latin1').subarray(0, 32)
  return Buffer.concat([source, PADDING]).subarray(0, 32)
}

class Rc4Encryption {
  /** Same password as owner and user password; permissions allow everything. */
  constructor(password, id) {
    this.permissions = -4 // 0xFFFFFFFC: print/copy/annotate allowed
    const ownerHash = md5(pad(password))
    this.o = rc4(ownerHash.subarray(0, 5), pad(password))
    const permissionsBytes = Buffer.alloc(4)
    permissionsBytes.writeInt32LE(this.permissions)
    this.fileKey = md5(
      Buffer.concat([pad(password), this.o, permissionsBytes, id.subarray(0, 16)]),
    ).subarray(0, 5)
    this.u = rc4(this.fileKey, PADDING)
  }

  /** Spec 7.6.3: MD5(fileKey + objNum(3) + genNum(2)), truncated to n+5 bytes. */
  objectKey(objectNum, genNum) {
    const extra = Buffer.alloc(5)
    extra.writeUIntLE(objectNum, 0, 3)
    extra.writeUIntLE(genNum, 3, 2)
    const n = this.fileKey.length // 5 bytes for a 40-bit key
    return md5(Buffer.concat([this.fileKey, extra])).subarray(0, Math.min(n + 5, 16))
  }

  encryptObject(objectNum, genNum, data) {
    return rc4(this.objectKey(objectNum, genNum), data)
  }

  encryptDict() {
    return (
      `<< /Filter /Standard /V 1 /R 2 /P ${this.permissions} ` +
      `/O <${this.o.toString('hex')}> /U <${this.u.toString('hex')}> >>`
    )
  }
}

function buildEncryptedPdf(pageCount) {
  const id = Buffer.from('5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a', 'hex')
  const encryption = new Rc4Encryption(PASSWORD, id)

  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const kids = []
  for (let index = 0; index < pageCount; index += 1) {
    const stream = writer.addStream(
      '',
      contentStream({
        head: 'Confidential document',
        foot: `Page ${index + 1}`,
        body: bodyLines(index),
      }),
    )
    kids.push(addPage(writer, pagesNum, resources, stream))
  }
  finalizePages(writer, pagesNum, kids)

  const encryptNum = writer.add(encryption.encryptDict())
  writer.encryptStreams(encryption)
  return writer.render(
    ` /Encrypt ${encryptNum} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`,
  )
}

/* ------------------------------------------------------------------ */

mkdirSync(OUT, { recursive: true })
const outputs = [
  ['text-300p.pdf', buildTextPdf(300)],
  ['scanned.pdf', buildScannedPdf(3)],
  ['mixed.pdf', buildMixedPdf()],
  ['encrypted.pdf', buildEncryptedPdf(3)],
]
for (const [name, buffer] of outputs) {
  writeFileSync(join(OUT, name), buffer)
  console.log(`${name}: ${buffer.length} bytes`)
}
console.log(`encrypted.pdf password: ${PASSWORD}`)
