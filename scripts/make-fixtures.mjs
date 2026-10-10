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
 *   fixtures/complex.pdf     1 page, three text columns + rotated watermark
 *   fixtures/slide.pdf       1 landscape page: a wide title over two text
 *                            boxes whose lines share baselines (type 10)
 *   fixtures/magazine.pdf    1 page: a photo inside the column with copy
 *                            flowing around it (type 12)
 *   fixtures/links.pdf       1 page, five /Link annotations: a mid-line URL,
 *                            a mid-line word, an internal destination, a
 *                            `data:` URI and a URI with no scheme
 *   fixtures/links-internal.pdf 2 pages, a contents page whose entries jump
 *                            to the chapter — a direct `[ref /XYZ …]`, a
 *                            named destination via `/Dests`, and an external
 *                            URI beside them
 *   fixtures/table.pdf       2 pages, two tables whose cells are each their
 *                            own positioned show-text operator — the shape a
 *                            real document uses — one row leaving a cell empty
 *   fixtures/table-spans.pdf 1 page, one table whose header cell is drawn
 *                            *across* two columns: no operator says so, only
 *                            the run's width does
 *   fixtures/table-continued.pdf 2 pages, one table cut by the page break:
 *                            page 1 ends with it running off the foot, page 2
 *                            opens with the single row the break left behind
 *   fixtures/figure.pdf      2 pages: a captioned figure, an uncaptioned one,
 *                            a texture under type, a full-bleed wash, an icon
 *                            and a letterhead logo — five images, one of which
 *                            should survive the figure pass
 *   fixtures/annotations.pdf 1 page, nine annotations: a highlight's reason,
 *                            a sticky note, a callout body, a stamp legend —
 *                            and five that must produce no text at all
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
/** Courier: 0.6em advance for every glyph, so link rectangles can be exact. */
const FONT_MONO = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'
const LETTER = '/MediaBox [0 0 612 792]'

function escape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function addPagesObject(writer) {
  writer.add('<< /Type /Catalog /Pages 2 0 R >>') // object 1
  return writer.add('<< /Type /Pages /Kids [] /Count 0 >>') // object 2
}

function addPage(writer, pagesNum, resources, contents, annots = [], mediaBox = LETTER) {
  const contentsRef = Array.isArray(contents)
    ? `[${contents.map((num) => `${num} 0 R`).join(' ')}]`
    : `${contents} 0 R`
  const annotsRef =
    annots.length > 0 ? ` /Annots [${annots.map((num) => `${num} 0 R`).join(' ')}]` : ''
  return writer.add(
    `<< /Type /Page /Parent ${pagesNum} 0 R ${mediaBox} ` +
      `/Resources << ${resources} >> /Contents ${contentsRef}${annotsRef} >>`,
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

/**
 * One positioned text run: its own `BT`/`ET` and its own `Tm`.
 *
 * This is how a real PDF draws a table — one show-text operator per cell, each
 * at its own x — so pdf.js hands back one *item* per cell and the detector has
 * real geometry to read. Writing a row as one string with spaces between the
 * columns (which is what a fixture writer reaches for first) yields a single
 * item, and a single item has no gaps in it: it would never be split.
 */
function cell(x, y, size, font, text) {
  return `BT\n/${font} ${size} Tf\n1 0 0 1 ${x} ${y} Tm\n(${escape(text)}) Tj\nET\n`
}

/**
 * A two-page fixture whose tables are drawn the way a document processor
 * draws them.
 *
 * Page 1 is a plain three-column table between two paragraphs. Page 2 is
 * another, with one row whose middle cell is empty — no operator draws it, so
 * that row arrives with one fewer run, and one fewer boundary, than its
 * neighbours. Both are the shape `tableForLines` has to turn into a
 * rectangle, and neither can be reached by any test that builds lines by hand.
 */
function buildTablePdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const page1 = [
    cell(72, 740, 14, 'F2', 'Quarterly revenue'),
    cell(72, 700, 11, 'F1', 'Revenue was reviewed for the three regions below.'),
    cell(72, 684, 11, 'F1', 'Every figure is stated in thousands of dollars.'),
    cell(72, 644, 11, 'F1', 'Region'),
    cell(260, 644, 11, 'F1', 'Q1'),
    cell(430, 644, 11, 'F1', 'Q2'),
    cell(72, 628, 11, 'F1', 'North'),
    cell(260, 628, 11, 'F1', '120'),
    cell(430, 628, 11, 'F1', '150'),
    cell(72, 612, 11, 'F1', 'South'),
    cell(260, 612, 11, 'F1', '90'),
    cell(430, 612, 11, 'F1', '110'),
    cell(72, 596, 11, 'F1', 'East'),
    cell(260, 596, 11, 'F1', '75'),
    cell(430, 596, 11, 'F1', '80'),
    cell(72, 548, 11, 'F1', 'The board accepted the figures without amendment.'),
  ].join('')

  const page2 = [
    cell(72, 740, 14, 'F2', 'Detail by product'),
    cell(72, 700, 11, 'F1', 'The second table leaves one cell empty in a single row.'),
    cell(72, 660, 11, 'F1', 'Product'),
    cell(300, 660, 11, 'F1', 'Units'),
    cell(460, 660, 11, 'F1', 'Notes'),
    cell(72, 644, 11, 'F1', 'Widget'),
    cell(300, 644, 11, 'F1', '120'),
    cell(460, 644, 11, 'F1', 'restocked'),
    cell(72, 628, 11, 'F1', 'Gadget'),
    cell(460, 628, 11, 'F1', 'clearance'),
    cell(72, 612, 11, 'F1', 'Gizmo'),
    cell(300, 612, 11, 'F1', '80'),
    cell(460, 612, 11, 'F1', 'backorder'),
    cell(72, 564, 11, 'F1', 'Two of the three rows had a second column.'),
  ].join('')

  const kids = [
    addPage(writer, pagesNum, resources, writer.addStream('', Buffer.from(page1, 'latin1'))),
    addPage(writer, pagesNum, resources, writer.addStream('', Buffer.from(page2, 'latin1'))),
  ]
  finalizePages(writer, pagesNum, kids)
  writer.setInfo({
    Title: 'Tables',
    Author: 'Finance Department',
    Subject: 'Two tables drawn cell by cell',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
  return writer.render()
}

/**
 * A one-page fixture whose header cell is drawn *across* two columns.
 *
 * PDF content streams have no "this cell spans two columns" operator: a
 * document processor draws the merge as one show-text run that starts inside
 * the second column and runs past the third's left edge. Geometry is the only
 * witness, and that is precisely what `spansOf` reads.
 *
 * The run is kept short — under eight ems — for a reason that is not about
 * this fixture at all. The reading-order pass cuts a line whose runs are spans
 * of prose at the column gutter, and it tells the two apart by run width: a
 * cell-sized run is a cell, a wide one is a clause. So a merged header only
 * reaches the table detector when it is cell-sized itself, which is the common
 * case (`First half 2026`, `Total`, `All regions`) but not the universal one.
 *
 * The three data rows are the control: same page, same columns, no merge —
 * their spans must all come back as one.
 */
function buildTableSpansPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const content = [
    cell(72, 740, 14, 'F2', 'Half-year revenue'),
    cell(72, 700, 11, 'F1', 'The header below is drawn across both figure columns.'),
    cell(72, 684, 11, 'F1', 'No second operator draws the column it covers.'),
    cell(72, 644, 11, 'F1', 'Region'),
    cell(260, 644, 11, 'F1', 'First half 2026'),
    cell(72, 628, 11, 'F1', 'North'),
    cell(260, 628, 11, 'F1', '120'),
    cell(300, 628, 11, 'F1', '150'),
    cell(72, 612, 11, 'F1', 'South'),
    cell(260, 612, 11, 'F1', '90'),
    cell(300, 612, 11, 'F1', '110'),
    cell(72, 596, 11, 'F1', 'East'),
    cell(260, 596, 11, 'F1', '75'),
    cell(300, 596, 11, 'F1', '80'),
    cell(72, 548, 11, 'F1', 'The header cell spans both figure columns.'),
  ].join('')

  const kids = [
    addPage(writer, pagesNum, resources, writer.addStream('', Buffer.from(content, 'latin1'))),
  ]
  finalizePages(writer, pagesNum, kids)
  writer.setInfo({
    Title: 'Table with a merged cell',
    Author: 'Finance Department',
    Subject: 'A header cell drawn across two columns',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
  return writer.render()
}

/**
 * A two-page fixture whose table is cut by a page break.
 *
 * Page 1 ends with the table running off the foot of the sheet — nothing
 * follows it, which is what a table cut by a break looks like from its own
 * side — and page 2 opens with the single row the break left behind.
 *
 * That row is the shape neither detector can reach on its own. One line
 * cannot agree with *itself* about where its columns are, so the recurrence
 * test has nothing to recur and reads `West 200 210` as a paragraph. What it
 * can be read against is the table it came from: three cells, starting at the
 * same x that table started at.
 *
 * Page 2 carries three lines of prose well below the row for a reason about
 * the fixture rather than the pipeline: block grouping sizes its gap test
 * against the page's own median leading, and a page whose only two blocks are
 * separated by one gap would take that gap *as* the median and fuse them. The
 * prose makes the leading small and the 40pt above it unmistakable.
 */
function buildTableContinuationPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const page1 = [
    cell(72, 740, 14, 'F2', 'Revenue by region'),
    cell(72, 700, 11, 'F1', 'The table below runs off the foot of this page.'),
    cell(72, 660, 11, 'F1', 'Region'),
    cell(260, 660, 11, 'F1', 'Q1'),
    cell(430, 660, 11, 'F1', 'Q2'),
  ]
  const names = ['North', 'South', 'East', 'Central', 'Coast', 'Valley', 'Upland', 'Delta']
  for (let index = 0; index < 31; index += 1) {
    const y = 642 - index * 18
    page1.push(
      cell(72, y, 11, 'F1', names[index % names.length]),
      cell(260, y, 11, 'F1', `${120 + index}`),
      cell(430, y, 11, 'F1', `${150 + index}`),
    )
  }

  const page2 = [
    cell(72, 740, 11, 'F1', 'West'),
    cell(260, 740, 11, 'F1', '200'),
    cell(430, 740, 11, 'F1', '210'),
    cell(72, 700, 11, 'F1', 'The row above is the last of the table that began overleaf.'),
    cell(72, 684, 11, 'F1', 'Three lines of prose stand below it, so it is a block of its own.'),
    cell(72, 668, 11, 'F1', 'Nothing here repeats the columns that row was cut from.'),
  ]

  const kids = [
    addPage(
      writer,
      pagesNum,
      resources,
      writer.addStream('', Buffer.from(page1.join(''), 'latin1')),
    ),
    addPage(
      writer,
      pagesNum,
      resources,
      writer.addStream('', Buffer.from(page2.join(''), 'latin1')),
    ),
  ]
  finalizePages(writer, pagesNum, kids)
  writer.setInfo({
    Title: 'Table continued over a page break',
    Author: 'Finance Department',
    Subject: 'One row left on the page after the break',
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

/**
 * Figures: five images on two pages, of which exactly one should survive the
 * figure pass.
 *
 * Page 1 is the happy path — a picture with `Figure 1.` set beneath it. Page 2
 * is everything that must *not* become a figure: a texture the body text is
 * printed on, a full-bleed wash, an icon too small to label and a letterhead
 * logo sitting in the running-head band. The uncaptioned picture is the
 * in-between case: no label, but a paragraph close enough to own it.
 *
 * One image object is reused by every draw. The figure pass reads geometry,
 * not pixels, so there is nothing to gain from six copies of the same bytes.
 */
function buildFigurePdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const fontResources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const width = 90
  const height = 110
  const pixels = Buffer.alloc(width * height * 3, 0xff)
  for (let y = 10; y < 100; y += 6) {
    for (let x = 8; x < 82; x += 1) {
      const offset = (y * width + x) * 3
      pixels[offset] = 20
      pixels[offset + 1] = 70
      pixels[offset + 2] = 140
    }
  }
  const image = writer.addStream(
    `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8',
    pixels,
  )

  const head = 'BT\n/F2 9 Tf\n1 0 0 rg\n72 770 Td (Annual Report 2026) Tj\nET\n'
  const foot = (label) => `BT\n/F1 9 Tf\n0 0 0 rg\n72 58 Td (${label}) Tj\nET\n`
  const paragraph = (lines, size, y, leading) =>
    [
      `BT\n/F1 ${size} Tf\n0 0 0 rg\n72 ${y} Td\n`,
      ...lines.map(
        (line, index) => `${index > 0 ? `0 -${leading} Td\n` : ''}(${escape(line)}) Tj\n`,
      ),
      'ET\n',
    ].join('')

  // --- page 1: one picture, its label, and prose either side -----------
  const page1Text = writer.addStream(
    '',
    Buffer.from(
      [
        head,
        paragraph(
          [
            'The diagram below summarises the deployment pipeline.',
            'Each stage is validated before the next one may start.',
          ],
          11,
          740,
          16,
        ),
        // Two points smaller than the body: enough for `canMerge` to split it
        // and for the block to read as a caption rather than a sentence.
        'BT\n/F1 9 Tf\n0 0 0 rg\n156 500 Td (Figure 1. Stages of the pipeline.) Tj\nET\n',
        paragraph(
          [
            'Rollback is automatic when a health check fails twice in a row.',
            'Every stage reports its own status.',
          ],
          11,
          476,
          16,
        ),
        foot('Page 1 of 2'),
      ].join(''),
      'latin1',
    ),
  )
  const page1Art = writer.addStream(
    '',
    Buffer.from('q\n300 0 0 140 156 520 cm\n/Im1 Do\nQ\n', 'latin1'),
  )

  // --- page 2: four images, none of which may become a figure ---------
  // Drawn first so the text really is printed on top of the wash.
  const page2Art = writer.addStream(
    '',
    Buffer.from(
      [
        'q\n612 0 0 792 0 0 cm\n/Im1 Do\nQ\n', // full-bleed wash: more than the page's share
        'q\n40 0 0 40 72 740 cm\n/Im1 Do\nQ\n', // letterhead logo, inside the running-head band
        'q\n240 0 0 160 72 560 cm\n/Im1 Do\nQ\n', // the uncaptioned figure
        'q\n460 0 0 150 72 300 cm\n/Im1 Do\nQ\n', // texture under the paragraph
        'q\n16 0 0 16 500 660 cm\n/Im1 Do\nQ\n', // an icon: below the area floor
      ].join(''),
      'latin1',
    ),
  )
  const page2Text = writer.addStream(
    '',
    Buffer.from(
      [
        head,
        paragraph(['The picture above lists the four stages of the pipeline.'], 11, 540, 14),
        // Eleven lines wide enough to cover the texture's 460pt entirely: the
        // coverage rule is what has to drop this one, not its size.
        paragraph(SENTENCES.slice(0, 11), 11, 440, 14),
        foot('Page 2 of 2'),
      ].join(''),
      'latin1',
    ),
  )

  const page1 = addPage(writer, pagesNum, `${fontResources} /XObject << /Im1 ${image} 0 R >>`, [
    page1Art,
    page1Text,
  ])
  const page2 = addPage(writer, pagesNum, `${fontResources} /XObject << /Im1 ${image} 0 R >>`, [
    page2Art,
    page2Text,
  ])
  finalizePages(writer, pagesNum, [page1, page2])
  writer.setInfo({
    Title: 'Figures',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
  return writer.render()
}

/* ------------------------------------------------------------------ */
/* A "complex layout" page: three columns of text plus a rotated        */
/* watermark crossing them — reading order cannot be trusted.           */
/* ------------------------------------------------------------------ */
function buildComplexPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const parts = ['BT\n', '/F1 9 Tf\n', '0 0 0 rg\n']
  // Three columns (x = 40 / 226 / 412, ~160pt wide, 24pt gutters), ten
  // aligned lines each: enough for the recursive column detector.
  for (const x of [40, 226, 412]) {
    for (let row = 0; row < 10; row += 1) {
      const y = 740 - row * 14
      parts.push(`1 0 0 1 ${x} ${y} Tm (Column filler line ${row + 1} of body words) Tj\n`)
    }
  }
  parts.push('ET\n')
  // Diagonal watermark: rotated text whose box crosses every column.
  parts.push('BT\n/F2 40 Tf\n0.75 0.75 0.75 rg\n')
  parts.push('0.7071 0.7071 -0.7071 0.7071 120 360 Tm (DRAFT COPY) Tj\n')
  parts.push('ET\n')

  const stream = writer.addStream('', Buffer.from(parts.join(''), 'latin1'))
  const page = addPage(writer, pagesNum, resources, stream)
  finalizePages(writer, pagesNum, [page])
  writer.setInfo({
    Title: 'Complex layout sample',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
  return writer.render()
}

/* ------------------------------------------------------------------ */
/* A presentation slide (type 10): a wide title spanning two free-     */
/* floating text boxes whose lines share baselines — per-slide box     */
/* reading order must come out title → left box → right box.           */
/* ------------------------------------------------------------------ */

function buildSlidePdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const parts = ['BT\n', '0 0 0 rg\n']
  // Title: 36pt bold, spanning the slide above both boxes.
  parts.push('/F2 36 Tf\n1 0 0 1 60 500 Tm (Annual Results 2026) Tj\n')
  // Left text box: five 11pt lines.
  parts.push('/F1 11 Tf\n')
  const left = [
    'Revenue grew across every region.',
    'Operating margin improved to 18%.',
    'Cash flow remained strongly positive.',
    'Debt levels fell below guidance.',
    'The board proposes no dividend change.',
  ]
  left.forEach((line, index) => {
    parts.push(`1 0 0 1 60 ${440 - index * 16} Tm (${escape(line)}) Tj\n`)
  })
  // Right text box: five 11pt lines on the SAME baselines as the left one —
  // clustering fuses each pair into one row unless the gutter is recovered.
  const right = [
    'Headcount ended the year at 4,120.',
    'Two new markets opened in June.',
    'The Berlin office doubled in size.',
    'Attrition fell to four percent.',
    'Hiring continues in engineering.',
  ]
  right.forEach((line, index) => {
    parts.push(`1 0 0 1 430 ${440 - index * 16} Tm (${escape(line)}) Tj\n`)
  })
  // Slide-number band: small, low, centred — a footer by position.
  parts.push('/F1 9 Tf\n1 0 0 1 380 30 Tm (Slide 3) Tj\n')
  parts.push('ET\n')

  const stream = writer.addStream('', Buffer.from(parts.join(''), 'latin1'))
  const page = addPage(writer, pagesNum, resources, stream, [], '/MediaBox [0 0 792 612]')
  finalizePages(writer, pagesNum, [page])
  writer.setInfo({
    Title: 'Slide sample',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
  return writer.render()
}

/* ------------------------------------------------------------------ */
/* A magazine page (type 12): a photo inside the text column with the  */
/* copy flowing around it — narrow lines beside the photo between      */
/* full-width lines, which must read intro → beside → closing.          */
/* ------------------------------------------------------------------ */

function buildMagazinePdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const fontResources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`

  const width = 120
  const height = 90
  const pixels = Buffer.alloc(width * height * 3, 0xff)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      pixels[offset] = 180 - x
      pixels[offset + 1] = 120
      pixels[offset + 2] = 90 + y
    }
  }
  const image = writer.addStream(
    `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8',
    pixels,
  )

  const parts = ['BT\n', '0 0 0 rg\n']
  parts.push('/F1 9 Tf\n1 0 0 1 60 760 Tm (The Monthly Review) Tj\n')
  parts.push('/F2 24 Tf\n1 0 0 1 60 715 Tm (The Long Road North) Tj\n')
  parts.push('/F1 11 Tf\n')
  const intro = [
    'The road north climbs out of the valley before dawn.',
    'Trucks pass in convoys, headlights cutting the fog.',
    'By mid-morning the pass is a ribbon above the clouds.',
    'Everything that travels this route is counted twice.',
  ]
  intro.forEach((line, index) => {
    parts.push(`1 0 0 1 60 ${680 - index * 15} Tm (${escape(line)}) Tj\n`)
  })
  // Last full-width line before the photo band.
  parts.push('1 0 0 1 60 620 Tm (The convoy halts for the border check at noon.) Tj\n')
  // Beside the photo: four narrow lines, its own x origin.
  const beside = [
    'Soldiers wave the drivers',
    'through without ceremony.',
    'The paperwork travels ahead,',
    'by fax, to the next post.',
  ]
  beside.forEach((line, index) => {
    parts.push(`1 0 0 1 290 ${581 - index * 14} Tm (${escape(line)}) Tj\n`)
  })
  // Closing paragraph: full width again, below the photo.
  const closing = [
    'By evening the column reaches the northern plain.',
    'The drivers sleep in the cab, engines idling.',
    'Dawn brings the same road, in reverse.',
  ]
  closing.forEach((line, index) => {
    parts.push(`1 0 0 1 60 ${455 - index * 15} Tm (${escape(line)}) Tj\n`)
  })
  parts.push('/F1 9 Tf\n1 0 0 1 300 40 Tm (42) Tj\n')
  parts.push('ET\n')

  const text = writer.addStream('', Buffer.from(parts.join(''), 'latin1'))
  // The photo sits left, inside the beside-lines band (y 470..595).
  const art = writer.addStream('', Buffer.from('q\n210 0 0 125 60 470 cm\n/Im1 Do\nQ\n', 'latin1'))
  const page = addPage(writer, pagesNum, `${fontResources} /XObject << /Im1 ${image} 0 R >>`, [
    art,
    text,
  ])
  finalizePages(writer, pagesNum, [page])
  writer.setInfo({
    Title: 'Magazine layout sample',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
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

/**
 * One page of `/Link` annotations, laid out in Courier so every rectangle can
 * be computed exactly: at 10pt, each glyph is 6pt wide, so the anchor of a
 * link is a known character range rather than a guess.
 *
 * Five three-line paragraphs (tight leading, blank line between) rather than
 * one evenly spaced block: the paragraph merger sets its reference gap from
 * the page's own median, so a page where every line is equally far apart
 * merges all of it and nothing can be asserted per block.
 *
 * Covers the five shapes the extractor has to tell apart:
 *   1. a URL in the middle of a line  — the usual bare link
 *   2. an ordinary word mid-line      — a citation-style hyperlink
 *   3. an internal `/Dest`            — no URI, and this one names nothing, so
 *      it resolves to no link unless a resolver says otherwise (the resolvable
 *      shapes live in `links-internal.pdf`)
 *   4. a `data:` URI                  — must be rejected, not escaped
 *   5. a URI with no scheme           — navigable once pdf.js gives it one
 */
function buildLinksPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const mono = writer.add(FONT_MONO)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R /F3 ${mono} 0 R >>`

  const CH = 6 // Courier advance at 10pt
  const LEFT = 72
  /**
   * The rectangle, bottom-left origin. Tight around the glyph box — 13pt for
   * 10pt type on 13pt leading — because a generous one reaches onto the next
   * line and every fixture assertion then counts an anchor that is not there.
   */
  const rectFor = (y, from, to) => `[${LEFT + from * CH} ${y - 2} ${LEFT + to * CH} ${y + 11}]`
  const uri = (rect, target) =>
    writer.add(
      `<< /Type /Annot /Subtype /Link /Rect ${rect} /Border [0 0 0] ` +
        `/A << /S /URI /URI (${escape(target)}) >> >>`,
    )

  // The five linked lines: text, baseline, and the anchor as `[from, to)` in
  // glyphs. `null` marks the internal destination, which carries no URI.
  const linked = [
    ['Read more at https://example.com/api now', 660, 13, 36, 'https://example.com/api'],
    ['See the pricing page for details.', 608, 8, 20, 'https://example.com/pricing'],
    ['Section 7 explains the batching rules.', 556, 0, 9, null],
    [
      'A saved copy sits at data:payload in the archive.',
      504,
      21,
      33,
      'data:text/html;base64,PHNjcmlwdD4=',
    ],
    ['The index lives at www.example.org/spec weekly.', 452, 19, 39, 'www.example.org/spec'],
  ]
  const fillers = [
    ['The endpoint returns JSON and nothing else.', 'Rate limits apply per key.'],
    ['Enterprise plans are quoted separately.', 'Billing runs monthly in advance.'],
    ['It is the authoritative reference.', 'Ask support if anything is unclear.'],
    ['That address is not a download.', 'Use the release page instead.'],
    ['It lists every published revision.', 'Subscribe to get a notification.'],
  ]

  const annots = linked.map(([, y, from, to, target]) => {
    const rect = rectFor(y, from, to)
    if (target === null) {
      // An internal destination with no URI. Nothing in this document defines
      // the name, so `resolveDestination` answers null and no link is emitted.
      return writer.add(
        `<< /Type /Annot /Subtype /Link /Rect ${rect} /Border [0 0 0] /Dest (chapter-7) >>`,
      )
    }
    return uri(rect, target)
  })

  // Baselines are absolute in the table above; `Td` is relative, so every
  // draw subtracts from a running cursor instead of trusting the deltas to
  // happen to add up.
  const body = ['BT\n', '/F2 16 Tf\n0 0 0 rg\n', '72 690 Td\n']
  let cursor = 690
  const move = (target, text) => {
    const dy = cursor - target
    cursor = target
    return dy === 0 ? `(${escape(text)}) Tj\n` : `0 -${dy} Td (${escape(text)}) Tj\n`
  }
  body.push(move(690, 'Useful Links'))
  for (let index = 0; index < linked.length; index += 1) {
    const [line, y] = linked[index]
    body.push('/F3 10 Tf\n')
    body.push(move(y, line))
    body.push(move(y - 13, fillers[index][0]))
    body.push(move(y - 26, fillers[index][1]))
    // A blank line: advance again without drawing, which is what separates
    // one paragraph from the next. The cursor moves in the PDF as well as in
    // here, or the next paragraph lands on this one's last line.
    body.push('0 -26 Td\n')
    cursor -= 26
  }
  body.push('ET\n')

  const content = Buffer.from(
    [
      'BT\n',
      '/F2 9 Tf\n1 0 0 rg\n',
      `72 770 Td (${escape('Annual Report 2026')}) Tj\n`,
      '0 0 0 rg\n/F1 9 Tf\n',
      `0 -712 Td (${escape('Page 1 of 1')}) Tj\n`,
      'ET\n',
      ...body,
    ].join(''),
    'latin1',
  )
  const stream = writer.addStream('', content)
  const page = addPage(writer, pagesNum, resources, stream, annots)
  finalizePages(writer, pagesNum, [page])
  return writer.render()
}

/**
 * Two pages of internal destinations: a contents page whose entries jump to
 * the chapter page, in both shapes a real PDF uses — a direct `[ref /XYZ …]`
 * array and a named destination resolved through the catalog's `/Dests` —
 * with one external URI beside them so both kinds on one page are exercised.
 *
 * Courier throughout, so every rectangle computes to the exact character
 * range it covers (10pt → 6pt advance), the way `links.pdf` does it.
 */
function buildLinksInternalPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const mono = writer.add(FONT_MONO)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R /F3 ${mono} 0 R >>`

  const CH = 6 // Courier advance at 10pt
  const LEFT = 72
  const rectFor = (y, from, to) => `[${LEFT + from * CH} ${y - 2} ${LEFT + to * CH} ${y + 11}]`

  // Page 2 first: page 1's destinations name its object number.
  const chapter = Buffer.from(
    [
      'BT\n',
      '/F2 16 Tf\n0 0 0 rg\n',
      `1 0 0 1 ${LEFT} 700 Tm (Introduction) Tj\n`,
      '/F1 10 Tf\n0 0 0 rg\n',
      `1 0 0 1 ${LEFT} 670 Tm (The chapter this contents page points at.) Tj\n`,
      `1 0 0 1 ${LEFT} 656 Tm (Its second line sits here for context.) Tj\n`,
      '/F2 16 Tf\n',
      `1 0 0 1 ${LEFT} 420 Tm (Method) Tj\n`,
      '/F1 10 Tf\n',
      `1 0 0 1 ${LEFT} 390 Tm (The named destination lands on this heading.) Tj\n`,
      'ET\n',
    ].join(''),
    'latin1',
  )
  const page2 = addPage(writer, pagesNum, resources, writer.addStream('', chapter))

  const direct = (rect) =>
    writer.add(
      `<< /Type /Annot /Subtype /Link /Rect ${rect} /Border [0 0 0] ` +
        `/Dest [${page2} 0 R /XYZ null null null] >>`,
    )
  const named = (rect) =>
    writer.add(`<< /Type /Annot /Subtype /Link /Rect ${rect} /Border [0 0 0] /Dest (method) >>`)
  const uri = (rect, target) =>
    writer.add(
      `<< /Type /Annot /Subtype /Link /Rect ${rect} /Border [0 0 0] ` +
        `/A << /S /URI /URI (${escape(target)}) >> >>`,
    )

  // Three contents entries: text, baseline, anchor as `[from, to)` in glyphs,
  // and which kind of destination carries it.
  const toc = [
    ['Chapter 1  Introduction', 640, 11, 23, 'direct'],
    ['Chapter 2  Method', 588, 11, 17, 'named'],
    ['See https://example.com/spec for the errata.', 536, 4, 28, 'https://example.com/spec'],
  ]
  const fillers = [
    'The opening chapter defines the terms.',
    'The method chapter shows the working.',
    'The errata live behind that address.',
  ]

  const annots = toc.map(([, y, from, to, target]) => {
    const rect = rectFor(y, from, to)
    if (target === 'direct') return direct(rect)
    if (target === 'named') return named(rect)
    return uri(rect, target)
  })

  const parts = ['BT\n', '/F2 16 Tf\n0 0 0 rg\n']
  parts.push(`1 0 0 1 ${LEFT} 700 Tm (Contents) Tj\n`)
  toc.forEach(([line, y], index) => {
    parts.push('/F3 10 Tf\n')
    parts.push(`1 0 0 1 ${LEFT} ${y} Tm (${escape(line)}) Tj\n`)
    parts.push('/F1 10 Tf\n')
    parts.push(`1 0 0 1 ${LEFT} ${y - 14} Tm (${escape(fillers[index])}) Tj\n`)
  })
  parts.push('ET\n')
  const content = Buffer.from(
    [
      'BT\n',
      '/F2 9 Tf\n1 0 0 rg\n',
      `72 770 Td (${escape('Table of Contents')}) Tj\n`,
      '0 0 0 rg\n/F1 9 Tf\n',
      `0 -712 Td (${escape('Page 1 of 2')}) Tj\n`,
      'ET\n',
      ...parts,
    ].join(''),
    'latin1',
  )
  const page1 = addPage(writer, pagesNum, resources, writer.addStream('', content), annots)

  // The named destination lives on the catalog: `/Dests << /method [page 2 …] >>`.
  writer.replaceBody(
    1,
    `<< /Type /Catalog /Pages ${pagesNum} 0 R ` +
      `/Dests << /method [${page2} 0 R /XYZ null null null] >> >>`,
  )
  finalizePages(writer, pagesNum, [page1, page2])
  writer.setInfo({
    Title: 'Internal destination sample',
    Creator: 'make-fixtures.mjs',
    Producer: 'make-fixtures.mjs',
    CreationDate: "D:20260115093000+06'30'",
    ModDate: "D:20260320174500+06'30'",
  })
  return writer.render()
}

function buildFormPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`
  const helv = writer.add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  )

  /**
   * A one-command appearance stream. Buttons are only recognised as buttons at
   * all when they carry `/AP`, so every checkbox and radio gets two of these —
   * one for the on state, one for off.
   */
  const ap = () => writer.addStream('', Buffer.from('q Q'))

  const mk = '/MK << /BC [0.5 0.5 0.5] /BG [1 1 1] >>'
  const textField = (name, tu, rect, extra = '') =>
    writer.add(
      `<< /Type /Annot /Subtype /Widget /FT /Tx /Rect [${rect}] /F 4 ` +
        `/T (${escape(name)})${tu ? ` /TU (${escape(tu)})` : ''} ${extra}${mk} >>`,
    )
  const checkBox = (name, tu, rect) =>
    writer.add(
      `<< /Type /Annot /Subtype /Widget /FT /Btn /Rect [${rect}] /F 4 ` +
        `/T (${escape(name)})${tu ? ` /TU (${escape(tu)})` : ''} /V /Off /AS /Off ` +
        `/AP << /N << /Yes ${ap()} 0 R /Off ${ap()} 0 R >> >> >>`,
    )
  const choiceField = (name, tu, rect, options) =>
    writer.add(
      `<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /Rect [${rect}] /F 4 ` +
        `/T (${escape(name)})${tu ? ` /TU (${escape(tu)})` : ''} ` +
        `/Opt [${options.map((option) => `(${escape(option)})`).join(' ')}] ${mk} >>`,
    )
  const signatureField = (name, tu, rect) =>
    writer.add(
      `<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [${rect}] /F 4 ` +
        `/T (${escape(name)})${tu ? ` /TU (${escape(tu)})` : ''} ${mk} >>`,
    )
  // Field-flag bits for `/FT /Btn` (PDF 32000-1 table 227): radio = 0x8000,
  // pushbutton = 0x10000. They are adjacent and easy to transpose, and pdf.js
  // reports the wrong widget kind outright when they are.
  const pushButton = (name, rect) =>
    writer.add(
      `<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /Rect [${rect}] /F 4 /T (${escape(name)}) >>`,
    )

  // The radio group is the one shape that is a *parent* field with one widget
  // per option: the widgets carry no `/T` of their own, so a reader that
  // flattens annotations without following `/Parent` sees two nameless boxes.
  const radioGroup = writer.add('<< /FT /Btn /Ff 32768 /T (contact_method) /V /Off /Kids [] >>')
  const radioWidget = (rect) =>
    writer.add(
      `<< /Type /Annot /Subtype /Widget /Parent ${radioGroup} 0 R /Rect [${rect}] /F 4 ` +
        `/AS /Off /AP << /N << /Yes ${ap()} 0 R /Off ${ap()} 0 R >> >> >>`,
    )

  const text = (font, size, x, y, body) =>
    `BT\n/${font} ${size} Tf\n0 0 0 rg\n${x} ${y} Td (${escape(body)}) Tj\nET\n`

  // ── page 1: three printed labels, three fillable boxes, one checkbox ────
  const nameField = textField(
    'full_name',
    'Full name of the applicant',
    '180 570 400 586',
    '/MaxLen 40 ',
  )
  const dobField = textField(
    'dob',
    'Date of birth, day month year',
    '180 530 340 546',
    '/MaxLen 10 ',
  )
  const countryField = choiceField('country', 'Country of residence', '180 490 340 506', [
    'Myanmar',
    'Thailand',
    'Viet Nam',
    'Lao PDR',
  ])
  const agreeField = checkBox('agree_terms', 'I have read and accept the terms', '72 452 84 464')
  // `/F 2` is the hidden bit: a field every reader must ignore, and the one
  // place a form author writes text nobody is meant to see.
  const hiddenField = writer.add(
    `<< /Type /Annot /Subtype /Widget /FT /Tx /F 2 /Rect [400 570 540 586] ` +
      `/T (internal_ref) /TU (Internal reference number) >>`,
  )

  const page1 = addPage(
    writer,
    pagesNum,
    resources,
    writer.addStream(
      '',
      Buffer.from(
        text('F2', 14, 72, 700, 'Application form') +
          text(
            'F1',
            10,
            72,
            676,
            'Complete every field in block capitals. Signed forms are kept for seven years.',
          ) +
          text('F1', 10, 72, 578, 'Full Name:') +
          text('F1', 10, 72, 538, 'Date of Birth:') +
          text('F1', 10, 72, 498, 'Country:') +
          text('F1', 10, 92, 458, 'I agree to the terms'),
        'latin1',
      ),
    ),
    [nameField, dobField, countryField, agreeField, hiddenField],
  )

  // ── page 2: email, a two-option radio group, a bare button, a signature ─
  const emailField = textField('email', 'Electronic mail address', '180 570 400 586')
  const radioA = radioWidget('72 532 84 544')
  const radioB = radioWidget('180 532 192 544')
  writer.replaceBody(
    radioGroup,
    `<< /FT /Btn /Ff 32768 /T (contact_method) /TU (Preferred contact method) /V /Off ` +
      `/Kids [${radioA} 0 R ${radioB} 0 R] >>`,
  )
  const submit = pushButton('submit', '72 492 152 512')
  const signed = signatureField('signature', 'Signature of the applicant', '72 410 260 444')

  const page2 = addPage(
    writer,
    pagesNum,
    resources,
    writer.addStream(
      '',
      Buffer.from(
        text('F2', 14, 72, 700, 'Contact details') +
          text('F1', 10, 72, 578, 'Email:') +
          text('F1', 10, 92, 538, 'By post') +
          text('F1', 10, 200, 538, 'By email') +
          text('F1', 10, 72, 452, 'Signature'),
        'latin1',
      ),
    ),
    [emailField, radioA, radioB, submit, signed],
  )

  finalizePages(writer, pagesNum, [page1, page2])

  // The catalog is object 1 and is written before anything it references, so
  // the AcroForm dictionary is patched in once the field tree exists.
  writer.replaceBody(
    1,
    `<< /Type /Catalog /Pages ${pagesNum} 0 R /AcroForm << ` +
      `/Fields [${nameField} 0 R ${dobField} 0 R ${countryField} 0 R ${agreeField} 0 R ` +
      `${hiddenField} 0 R ${radioGroup} 0 R ${submit} 0 R ${signed} 0 R ${emailField} 0 R] ` +
      `/DR << /Font << /Helv ${helv} 0 R >> >> /DA (/Helv 10 Tf 0 g) /NeedAppearances true >> >>`,
  )

  return writer.render()
}

/**
 * One page of ordinary text carrying nine annotations: four that say
 * something, five that must not produce a word.
 *
 * The four that count are the shapes review markup actually arrives in — a
 * `/Highlight` whose `/Contents` explains why the passage was marked, a
 * sticky `/Text` note parked in the right margin, a `/FreeText` callout whose
 * body only exists in its appearance stream, and a `/Stamp` legend. The five
 * that must not are the traps: a `/Link` carrying `/Contents` (it is a link,
 * `links.ts` owns it), a hidden `/Text` behind `/F 2`, a `/Popup` that repeats
 * its parent's words verbatim at a different rectangle, a widget with a `/TU`
 * (it is a form label, `formFields.ts` owns it), and a note whose `/Contents`
 * is nothing but spaces.
 *
 * The rectangles are chosen so each case is decided by something different:
 * the highlight lies straight over the paragraph it marks, the stamp sits in
 * empty space to the right of every column, the callout sits in the gap
 * between two paragraphs, and the sticky note is in a margin no block reaches.
 */
function buildAnnotationsPdf() {
  const writer = new PdfWriter()
  const pagesNum = addPagesObject(writer)
  const regular = writer.add(FONT_REGULAR)
  const bold = writer.add(FONT_BOLD)
  const helv = writer.add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  )
  const resources = `/Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>`
  /** A one-command appearance stream, for the two annotations drawn by one. */
  const ap = () => writer.addStream('', Buffer.from('q Q'))
  const say = (font, size, x, y, body) =>
    `BT\n/${font} ${size} Tf\n0 0 0 rg\n${x} ${y} Td (${escape(body)}) Tj\nET\n`

  // A widget: `/TU` reaches the translator through `formFields.ts`.
  const reviewerField = writer.add(
    `<< /Type /Annot /Subtype /Widget /FT /Tx /F 4 /Rect [72 430 240 446] ` +
      `/T (reviewer) /TU (Name of the reviewer) >>`,
  )

  const annots = [
    // The reason a passage was marked, over the first body line.
    writer.add(
      `<< /Type /Annot /Subtype /Highlight /F 4 /Rect [70 655 350 669] ` +
        `/QuadPoints [70 655 70 669 350 669 350 655] ` +
        `/Contents (Please confirm this figure against the ledger before filing.) >>`,
    ),
    // A sticky note in the right margin, where no block of text reaches.
    writer.add(
      `<< /Type /Annot /Subtype /Text /Name /Comment /F 4 /Rect [560 620 576 636] ` +
        `/Contents (Check this figure with the finance team.) >>`,
    ),
    // A callout: body drawn by its appearance stream, never by an operator.
    writer.add(
      `<< /Type /Annot /Subtype /FreeText /F 4 /Rect [72 545 400 575] ` +
        `/DA (/Helv 12 Tf 0 0 0 rg) /AP << /N ${ap()} 0 R >> ` +
        `/Contents (Updated for the 2026 reporting cycle.) >>`,
    ),
    // A stamp, whose legend is wider than the box it is stamped into.
    writer.add(
      `<< /Type /Annot /Subtype /Stamp /Name /Approved /F 4 /Rect [430 500 560 520] ` +
        `/AP << /N ${ap()} 0 R >> /Contents (Approved by the audit committee.) >>`,
    ),
    // A link that also carries `/Contents`: it stays a link.
    writer.add(
      `<< /Type /Annot /Subtype /Link /F 4 /Rect [72 533 200 545] /Border [0 0 0] ` +
        `/Contents (The note must not become a note.) ` +
        `/A << /S /URI /URI (https://example.org/audit) >> >>`,
    ),
    // Hidden: shown to nobody, announced to nobody.
    writer.add(
      `<< /Type /Annot /Subtype /Text /Name /Note /F 2 /Rect [72 460 88 476] ` +
        `/Contents (Hidden note that must not appear.) >>`,
    ),
    // The popup that displays the highlight's own words at another rectangle.
    writer.add(
      `<< /Type /Annot /Subtype /Popup /F 4 /Rect [70 560 260 640] ` +
        `/Contents (Please confirm this figure against the ledger before filing.) >>`,
    ),
    // A widget: `/TU` reaches the translator through `formFields.ts`.
    reviewerField,
    // Nothing to say.
    writer.add(
      `<< /Type /Annot /Subtype /Text /Name /Note /F 4 /Rect [300 430 316 446] ` +
        `/Contents (   ) >>`,
    ),
  ]

  const content = Buffer.from(
    say('F2', 9, 72, 770, 'Annual Report 2026') +
      say('F1', 9, 72, 60, 'Page 1 of 1') +
      say('F2', 16, 72, 690, 'Quarterly Results') +
      say('F1', 10, 72, 660, 'Revenue rose twelve percent against the same quarter.') +
      say('F1', 10, 72, 646, 'Operating costs were held flat for the third period.') +
      say('F1', 10, 72, 610, 'Deferred income is recognised on delivery.') +
      say('F1', 10, 72, 596, 'The audit committee met twice in the period.') +
      say('F1', 10, 72, 536, 'Notes are attached to the relevant paragraph.') +
      say('F1', 10, 72, 522, 'Every figure is reconciled to the ledger.'),
    'latin1',
  )
  const page = addPage(writer, pagesNum, resources, writer.addStream('', content), annots)
  finalizePages(writer, pagesNum, [page])

  // The catalog is object 1 and is written before anything it references, so
  // the AcroForm dictionary is patched in once the field exists.
  writer.replaceBody(
    1,
    `<< /Type /Catalog /Pages ${pagesNum} 0 R /AcroForm << /Fields [${reviewerField} 0 R] ` +
      `/DR << /Font << /Helv ${helv} 0 R >> >> /DA (/Helv 10 Tf 0 g) /NeedAppearances true >> >>`,
  )
  return writer.render()
}

mkdirSync(OUT, { recursive: true })
const outputs = [
  ['text-300p.pdf', buildTextPdf(300)],
  ['scanned.pdf', buildScannedPdf(3)],
  ['mixed.pdf', buildMixedPdf()],
  ['encrypted.pdf', buildEncryptedPdf(3)],
  ['complex.pdf', buildComplexPdf()],
  ['slide.pdf', buildSlidePdf()],
  ['magazine.pdf', buildMagazinePdf()],
  ['links.pdf', buildLinksPdf()],
  ['links-internal.pdf', buildLinksInternalPdf()],
  ['table.pdf', buildTablePdf()],
  ['table-spans.pdf', buildTableSpansPdf()],
  ['table-continued.pdf', buildTableContinuationPdf()],
  ['figure.pdf', buildFigurePdf()],
  ['form.pdf', buildFormPdf()],
  ['annotations.pdf', buildAnnotationsPdf()],
]
for (const [name, buffer] of outputs) {
  writeFileSync(join(OUT, name), buffer)
  console.log(`${name}: ${buffer.length} bytes`)
}
console.log(`encrypted.pdf password: ${PASSWORD}`)
