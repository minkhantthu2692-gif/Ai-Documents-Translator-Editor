/**
 * Does `disableFontFace` change the text we extract?
 *
 * The flag only tells the renderer to emit glyph outlines instead of relying on
 * an installed `FontFace`, but `getTextContent()` is the thing the whole parse
 * pipeline depends on, so the claim is checked rather than assumed: same PDF,
 * both settings, byte-identical item text.
 *
 * Usage: node tools/extract-parity.mjs <file.pdf>
 */
import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/extract-parity.mjs <file.pdf>')
  process.exit(1)
}

const data = new Uint8Array(readFileSync(file))

async function extract(disableFontFace) {
  const doc = await getDocument({
    data: data.slice(),
    disableFontFace,
    useSystemFonts: false,
    cMapUrl: new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .href,
    verbosity: 0,
  }).promise

  const pages = []
  const limit = Math.min(doc.numPages, 8)
  for (let i = 1; i <= limit; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push({
      items: content.items
        .map(
          (item) => `${item.str}|${Math.round(item.transform[4])},${Math.round(item.transform[5])}`,
        )
        .join('\n'),
      styles: Object.keys(content.styles ?? {})
        .sort()
        .join(','),
    })
  }
  return pages
}

const withFlag = await extract(true)
const withoutFlag = await extract(false)

let identical = 0
for (let i = 0; i < withFlag.length; i += 1) {
  const sameText = withFlag[i].items === withoutFlag[i].items
  const sameStyles = withFlag[i].styles === withoutFlag[i].styles
  if (sameText && sameStyles) identical += 1
  console.log(
    `page ${i + 1}: text ${sameText ? 'identical' : 'DIFFERS'}, styles ${sameStyles ? 'identical' : 'DIFFERS'} (${withFlag[i].items.length} chars)`,
  )
}

console.log('')
console.log(`${identical}/${withFlag.length} pages identical`)
process.exit(identical === withFlag.length ? 0 : 1)
