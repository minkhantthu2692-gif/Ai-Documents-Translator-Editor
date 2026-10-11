/**
 * Which fonts does a PDF actually use, and are they embedded?
 *
 * Answers the tofu question at its root: pdf.js can only paint a glyph when it
 * has the font data. An embedded subset is read straight from the file, a
 * non-embedded base-14 font is substituted from `standardFontDataUrl`, and
 * anything else (a custom Type1 with no FontFile, an exotic CID font) falls
 * back to whatever the browser happens to have — which is exactly how a page
 * of squares appears at full size but looks fine as a thumbnail.
 *
 * Rendering one page is what resolves its fonts into the page's `commonObjs`
 * store, so each inspected page is read with `getOperatorList()` first.
 *
 * Usage: node tools/font-audit.mjs <file.pdf> [pages]
 */
import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/font-audit.mjs <file.pdf> [pages]')
  process.exit(1)
}
const limit = Number(process.argv[3] ?? 12)

const data = new Uint8Array(readFileSync(file))
const doc = await getDocument({
  data,
  useSystemFonts: false,
  fontExtraProperties: true,
  verbosity: 0,
}).promise
const pages = Math.min(limit, doc.numPages)
console.log(`pages: ${doc.numPages} (inspecting ${pages})`)

/** @type {Map<string, {name: string, subtype: string, missing: boolean, composite: boolean, pages: number[], keys: string[]}>} */
const fonts = new Map()

for (let i = 1; i <= pages; i += 1) {
  const page = await doc.getPage(i)
  await page.getOperatorList()
  const content = await page.getTextContent()
  const store = page.commonObjs
  if (!store) continue

  for (const id of Object.keys(content.styles ?? {})) {
    if (!store.has(id)) continue
    const font = store.get(id)
    if (!font || typeof font !== 'object') continue
    const name = String(font.name ?? id)
    const existing = fonts.get(name)
    if (existing) {
      existing.pages.push(i)
      continue
    }
    fonts.set(name, {
      name,
      subtype: `${font.type ?? '?'}/${font.subtype ?? '?'}`,
      missing: Boolean(font.missingFile),
      composite: Boolean(font.composite),
      pages: [i],
      keys: Object.keys(font).filter((key) =>
        /file|data|toFontChar|differences|unicode/i.test(key),
      ),
    })
  }
}

console.log('')
console.log(['font', 'type', 'composite', 'missing', 'seen', 'data keys'].join('\t'))
for (const font of [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(
    [
      font.name,
      font.subtype,
      font.composite ? 'yes' : 'no',
      font.missing ? 'MISSING' : '',
      font.pages.length,
      font.keys.join(','),
    ].join('\t'),
  )
}

const missing = [...fonts.values()].filter((font) => font.missing)
console.log('')
console.log(`unique fonts: ${fonts.size}, pdf.js could not supply data for: ${missing.length}`)
if (missing.length) {
  console.log(
    'NO FONT DATA (these render from a browser substitute — squares if it lacks the glyphs):',
    missing.map((font) => font.name).join(', '),
  )
}
