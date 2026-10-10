/**
 * OSD probe — how tesseract.js actually behaves on rotated and skewed pages.
 *
 * One recognition per invocation against synthetic fixtures (a hand-drawn
 * 8×8 uppercase font, so no image is downloaded), printing a single RESULT
 * line. Spec: `node scripts/osd-probe.mjs file:psm:langs[:mode]` where mode is
 * `blocks` (return boxes), `auto`/`autob` (tesseract.js `rotateAuto` deskew),
 * or `rp<quarters>` (recognise with `rotateRadians` = quarters·90°, boxes on).
 *
 * Files: upright | rot90cw | rot90ccw | rot180 | skew2. The numbers this
 * probe produced are pinned in `src/ocr/orientation.ts` and in the type-2 row
 * of `docs/PDF_TYPES_SUPPORT.md`:
 *
 *   upright:3:eng .......... conf 72   (accepted first pass)
 *   rot90cw:3:eng .......... conf 72   (no trial needed: tesseract reads a
 *                                       top-to-bottom vertical line, which is
 *                                       what a clockwise turn presents)
 *   rot90ccw:3:eng ......... conf 15   → the quarter-turn trials lift it
 *   rot180:3:eng ........... conf 15   → rp2 reads upright at conf 74
 *   skew2:3:eng ............ conf 41   (text broken by a 2° feed skew)
 *   skew2:3:eng:auto ....... conf 88, rotateRadians -0.0334 (deskewed)
 *
 * Also why the app does not read orientation out of tesseract: with `osd` in
 * the language list the traineddata loads, yet `output.osd` comes back empty
 * on every page-segmentation mode tried (v7 dump never populates it), so
 * orientation is decided by trial confidence instead.
 *
 * On-demand tool: runs the WASM core and the traineddata packs from jsDelivr
 * (once per language), so it needs the network and takes seconds per spec.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/* ------------------------------------------------------------------ */
/* Minimal grayscale PNG encoder (fixtures need no image dependency)   */
/* ------------------------------------------------------------------ */

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function pngGray(w, h, px) {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = px[y * w + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ */
/* Fixtures: "HELLO WORLD" in a hand-drawn 8×8 font, ±quarter-turns,   */
/* and a 2° skew by nearest-neighbour sampling                         */
/* ------------------------------------------------------------------ */

const FONT = {
  H: [
    '01000010',
    '01000010',
    '01000010',
    '01111110',
    '01000010',
    '01000010',
    '01000010',
    '00000000',
  ],
  E: [
    '01111110',
    '01000000',
    '01000000',
    '01111100',
    '01000000',
    '01000000',
    '01111110',
    '00000000',
  ],
  L: [
    '01000000',
    '01000000',
    '01000000',
    '01000000',
    '01000000',
    '01000000',
    '01111110',
    '00000000',
  ],
  O: [
    '00111100',
    '01000010',
    '01000010',
    '01000010',
    '01000010',
    '01000010',
    '00111100',
    '00000000',
  ],
  W: [
    '01000010',
    '01000010',
    '01000010',
    '01000010',
    '01010110',
    '01010110',
    '00101010',
    '00000000',
  ],
  R: [
    '01111100',
    '01000010',
    '01000010',
    '01000010',
    '01111100',
    '01010000',
    '01001000',
    '00000000',
  ],
  D: [
    '01111100',
    '01000110',
    '01000010',
    '01000010',
    '01000010',
    '01000110',
    '01111100',
    '00000000',
  ],
  ' ': [
    '00000000',
    '00000000',
    '00000000',
    '00000000',
    '00000000',
    '00000000',
    '00000000',
    '00000000',
  ],
}

const W = 720
const H = 200
const UP = 4
const TEXT = 'HELLO WORLD'

function uprightImage() {
  const px = new Uint8Array(W * H).fill(255)
  const glyphW = 8 * UP
  const spacing = 2 * UP
  const total = TEXT.length * (glyphW + spacing) - spacing
  let cx = Math.floor((W - total) / 2)
  const cy = Math.floor((H - 8 * UP) / 2)
  for (const ch of TEXT) {
    const glyph = FONT[ch]
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (glyph[r][c] !== '1') continue
        for (let dy = 0; dy < UP; dy++) {
          for (let dx = 0; dx < UP; dx++) {
            px[(cy + r * UP + dy) * W + (cx + c * UP + dx)] = 0
          }
        }
      }
    }
    cx += glyphW + spacing
  }
  return px
}

/** Exact quarter-turns (90 = clockwise, 270 = counter-clockwise, 180 = flip). */
function rotate(px, w, h, deg) {
  const out = new Uint8Array(w * h)
  if (deg === 180) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = px[y * w + x]
    }
    return { px: out, w, h }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (deg === 90) out[x * h + (h - 1 - y)] = px[y * w + x]
      else out[(w - 1 - x) * h + y] = px[y * w + x]
    }
  }
  return { px: out, w: h, h: w }
}

/** Nearest-neighbour rotation by an arbitrary angle, white background. */
function skew(px, w, h, deg) {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const out = new Uint8Array(w * h).fill(255)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const dy = y - cy
      const sx = Math.round(cx + cos * dx + sin * dy)
      const sy = Math.round(cy - sin * dx + cos * dy)
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = px[sy * w + sx]
    }
  }
  return { px: out, w, h }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidt-osd-'))
const base = uprightImage()
const variants = {
  upright: { px: base, w: W, h: H },
  rot90cw: rotate(base, W, H, 90),
  rot90ccw: rotate(base, W, H, 270),
  rot180: rotate(base, W, H, 180),
  skew2: skew(base, W, H, 2),
}
for (const [name, v] of Object.entries(variants)) {
  fs.writeFileSync(path.join(dir, `${name}.png`), pngGray(v.w, v.h, v.px))
}

/* ------------------------------------------------------------------ */
/* One recognition, one RESULT line                                    */
/* ------------------------------------------------------------------ */

const spec = process.argv[2] ?? 'upright:3:eng'
const [file, psm, langsSpec, mode] = spec.split(':')
const langs = (langsSpec ?? 'eng').split(',')
const wantsBoxes = mode === 'blocks' || mode === 'autob' || (mode ?? '').startsWith('rp')
const quarters = (mode ?? '').startsWith('rp') ? Number(mode.slice(2)) : null

const { createWorker } = await import('tesseract.js')
const worker = await createWorker(langs, undefined, { logger: () => {} })
const options = { tessedit_pageseg_mode: psm ?? '3' }
if (mode === 'auto' || mode === 'autob') options.rotateAuto = true
if (quarters !== null) options.rotateRadians = (quarters * Math.PI) / 2

const res = await worker.recognize(path.join(dir, `${file}.png`), options, {
  text: true,
  blocks: wantsBoxes,
  hocr: false,
  tsv: false,
  pdf: false,
  osd: true,
})
const blocks = Array.isArray(res.data.blocks) ? res.data.blocks : res.data.blocks?.blocks
const firstBlock = blocks?.length ? blocks[0].bbox : null

console.log(
  `RESULT ${JSON.stringify({
    spec,
    dir,
    osd: res.data.osd,
    text: (res.data.text ?? '').trim().slice(0, 80),
    confidence: res.data.confidence,
    rotateRadians: res.data.rotateRadians,
    firstBlockBBox: firstBlock,
    blockCount: blocks?.length ?? 0,
  })}`,
)
await worker.terminate()
