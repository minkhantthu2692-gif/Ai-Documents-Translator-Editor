/**
 * Operator-list analysis.
 *
 * pdf.js `page.getOperatorList()` is the only public way to learn what a page
 * actually *draws* — the fill colour in force for each text run, how many
 * images are painted, and which font objects were resolved. This module turns
 * that stream into plain data.
 *
 * Everything here is pure (numbers in, data out) so it can be unit-tested
 * without pdf.js; `pdfOps.test.ts` verifies the OPS mirror against the real
 * `pdfjs-dist` constants.
 */

/**
 * Mirrors pdf.js `OPS` (src/display/api.js). Kept local so this module has no
 * runtime dependency on pdf.js; `pdfOps.test.ts` asserts it stays in sync.
 */
export const OPS = {
  dependency: 1,
  setLineWidth: 2,
  setLineCap: 3,
  setLineJoin: 4,
  setMiterLimit: 5,
  setDash: 6,
  setRenderingIntent: 7,
  setFlatness: 8,
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setLeading: 36,
  setFont: 37,
  setTextRenderingMode: 38,
  setTextRise: 39,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
  setCharWidth: 48,
  setCharWidthAndBounds: 49,
  setStrokeColorSpace: 50,
  setFillColorSpace: 51,
  setStrokeColor: 52,
  setStrokeColorN: 53,
  setFillColor: 54,
  setFillColorN: 55,
  setStrokeGray: 56,
  setFillGray: 57,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  setStrokeCMYKColor: 60,
  setFillCMYKColor: 61,
  shadingFill: 62,
  beginInlineImage: 63,
  beginImageData: 64,
  endInlineImage: 65,
  paintXObject: 66,
  markPoint: 67,
  markPointProps: 68,
  beginMarkedContent: 69,
  beginMarkedContentProps: 70,
  endMarkedContent: 71,
  beginCompat: 72,
  endCompat: 73,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  beginAnnotation: 80,
  endAnnotation: 81,
  paintImageMaskXObject: 83,
  paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89,
  paintSolidColorImageMask: 90,
  constructPath: 91,
  setStrokeTransparent: 92,
  setFillTransparent: 93,
  rawFillPath: 94,
} as const

/** Shape of the pair `pdfjs` returns from `page.getOperatorList()`. */
export interface OpList {
  fnArray: number[]
  argsArray: unknown[][]
}

/** Text-showing operators (each one paints a run of glyphs). */
const TEXT_OPS: ReadonlySet<number> = new Set([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
])

/**
 * Operators that paint an image. `paintSolidColorImageMask` is deliberately
 * excluded: pdf.js also uses it for stroked/filled text rendering modes, which
 * would make every such page look "scanned".
 */
const IMAGE_OPS: ReadonlySet<number> = new Set([
  OPS.beginInlineImage,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
])

const FILL_COLOR_OPS: ReadonlySet<number> = new Set([
  OPS.setFillColor,
  OPS.setFillColorN,
  OPS.setFillGray,
  OPS.setFillRGBColor,
  OPS.setFillCMYKColor,
  OPS.setFillTransparent,
])

/** The base-14 fonts a PDF may reference without embedding them. */
export const STANDARD_14: ReadonlySet<string> = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'HelveticaNarrow',
  'HelveticaNarrow-Bold',
  'HelveticaNarrow-Oblique',
  'HelveticaNarrow-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'TimesNewRoman',
  'TimesNewRomanPSMT',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'CourierNew',
  'CourierNewPSMT',
  'Symbol',
  'ZapfDingbats',
])

const SUBSET_PREFIX = /^[A-Z]{6}\+/

/** Normalises any fill-colour argument pdf.js hands us to `#rrggbb`. */
export function normalizeColor(args: unknown[] | undefined): string | null {
  if (!args || args.length === 0) return null
  const first = args[0]

  if (typeof first === 'string') {
    const six = /^#([0-9a-f]{6})(?![0-9a-f])/i.exec(first)
    if (six) return `#${six[1].toLowerCase()}`
    const three = /^#([0-9a-f]{3})(?![0-9a-f])/i.exec(first)
    if (three) {
      const [r, g, b] = three[1].toLowerCase().split('')
      return `#${r}${r}${g}${g}${b}${b}`
    }
    return null
  }

  const numbers = args.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  if (numbers.length !== args.length) return null

  const toUnit = (value: number): number => Math.max(0, Math.min(1, value))
  const hex = (red: number, green: number, blue: number): string =>
    '#' +
    [red, green, blue]
      .map((value) =>
        Math.max(0, Math.min(255, Math.round(value)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')

  if (numbers.length >= 4) {
    // CMYK, either 0..1 floats or 0..255 bytes.
    const scale = numbers.every((value) => value <= 1) ? 1 : 255
    const [c, m, y, k] = numbers.slice(0, 4).map((value) => toUnit(value / scale))
    return hex(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k))
  }
  if (numbers.length >= 3) {
    const scale = numbers.every((value) => value <= 1) ? 255 : 1
    return hex(numbers[0] * scale, numbers[1] * scale, numbers[2] * scale)
  }
  if (numbers.length === 1) {
    const [value] = numbers
    // pdf.js normalises colour operators to a single 0xRRGGBB number, but a
    // lone 0/1 is only ever a grey level (black/white) in the raw op list —
    // 0x000001 is not a colour anyone writes, so reading 1 as white is safe.
    if (Number.isInteger(value) && Math.abs(value) > 1) {
      return hex((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
    }
    const gray = 255 * toUnit(value)
    return hex(gray, gray, gray)
  }
  return null
}

/** Position of the current text run in PDF user space (bottom-left origin). */
export interface TextRun {
  color: string | null
  x: number
  y: number
}

/**
 * Walks the operator list reconstructing (approximately) where each text run
 * started and which fill colour was in force. Glyph advances are ignored — the
 * start position is all the matcher needs.
 */
export function traceTextRuns(ops: OpList): TextRun[] {
  const runs: TextRun[] = []
  let color: string | null = null
  let x = 0
  let y = 0
  let leading = 0

  const { fnArray, argsArray } = ops
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index]
    const args = argsArray[index] ?? []

    if (FILL_COLOR_OPS.has(fn)) {
      const normalized = normalizeColor(args)
      if (normalized) color = normalized
      continue
    }
    switch (fn) {
      case OPS.beginText:
        x = 0
        y = 0
        break
      case OPS.setTextMatrix: {
        const [, , , , e, f] = args as number[]
        if (Number.isFinite(e) && Number.isFinite(f)) {
          x = e
          y = f
        }
        break
      }
      case OPS.moveText: {
        const [tx, ty] = args as number[]
        if (Number.isFinite(tx)) x += tx
        if (Number.isFinite(ty)) y += ty
        break
      }
      case OPS.setLeadingMoveText: {
        const [tx, ty] = args as number[]
        if (Number.isFinite(tx)) x += tx
        if (Number.isFinite(ty)) {
          y += ty
          leading = ty
        }
        break
      }
      case OPS.nextLine:
        y -= leading
        x = 0
        break
      default:
        if (TEXT_OPS.has(fn)) runs.push({ color, x, y })
        break
    }
  }
  return runs
}

/** Number of painted images on the page. */
export function countImages(ops: OpList): number {
  let count = 0
  for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) count += 1
  return count
}

interface Positioned {
  transform?: number[]
}

/**
 * Assigns a fill colour to every text item.
 *
 * pdf.js may split one text-showing operator into several items (whitespace
 * normalisation), so a straight zip is wrong. Instead both lists are walked in
 * stream order and each item takes the colour of the *nearest* run that still
 * lies ahead of it.
 */
export function assignColors(ops: OpList, items: Positioned[]): Array<string | null> {
  const runs = traceTextRuns(ops)
  const colors: Array<string | null> = new Array(items.length).fill(null)
  if (runs.length === 0) return colors

  const distance = (item: Positioned, run: TextRun): number => {
    const x = item.transform?.[4] ?? 0
    const y = item.transform?.[5] ?? 0
    return Math.hypot(x - run.x, y - run.y)
  }

  let runIndex = 0
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item?.transform) continue
    while (runIndex + 1 < runs.length) {
      const current = distance(item, runs[runIndex])
      const next = distance(item, runs[runIndex + 1])
      if (next >= current) break
      runIndex += 1
    }
    colors[index] = runs[runIndex].color
  }
  return colors
}

/**
 * Font embedding classification from the *resolved* font name pdf.js reports
 * (`FontFaceObject.loadedName`), with a subset-prefix and Type3 fallback.
 */
export function classifyFontName(
  name: string | undefined,
  options: { isType3?: boolean; missingFile?: boolean } = {},
): 'embedded' | 'standard' | 'other' {
  if (!name) return 'other'
  const cleaned = name.replace(/^\//, '').trim()
  if (options.isType3) return 'embedded'
  if (SUBSET_PREFIX.test(cleaned)) return 'embedded'
  const base = cleaned.replace(SUBSET_PREFIX, '')
  if (STANDARD_14.has(base)) return 'standard'
  // pdf.js could not find a font program for it → referenced, not embedded.
  if (options.missingFile) return 'standard'
  return 'other'
}

export interface FontStats {
  distinct: number
  embedded: number
  standard: number
  other: number
}

export function emptyFontStats(): FontStats {
  return { distinct: 0, embedded: 0, standard: 0, other: 0 }
}

/** Folds one classified font into the running totals (idempotent by key). */
export function addFont(
  stats: FontStats,
  seen: Set<string>,
  key: string,
  classification: ReturnType<typeof classifyFontName>,
): FontStats {
  if (seen.has(key)) return stats
  seen.add(key)
  return {
    distinct: stats.distinct + 1,
    embedded: stats.embedded + (classification === 'embedded' ? 1 : 0),
    standard: stats.standard + (classification === 'standard' ? 1 : 0),
    other: stats.other + (classification === 'other' ? 1 : 0),
  }
}
