/**
 * Auto-fit and overflow detection (Phase 4).
 *
 * The original bbox is sacred: text may shrink (within a min/max band) and
 * re-wrap inside it, but it may never silently grow past it. When even the
 * minimum size does not fit we report `fits: false` so the UI can show the
 * overflow warning instead of clipping the text.
 *
 * Everything is measured in **PDF points**, the same unit as `BlockRecord`'s
 * geometry and the CSS `pt` unit the overlay uses, so no conversion can drift
 * between the editor and the exports.
 */

/** Width of `text` rendered at `fontSize` points, in points. */
export type TextMeasurer = (input: {
  text: string
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
}) => number

export interface FitBox {
  width: number
  height: number
}

export interface FitRequest {
  text: string
  box: FitBox
  fontFamily: string
  bold: boolean
  italic: boolean
  /** Size extracted from the PDF — the upper bound for a shrink. */
  originalSize: number
  /** Multiplier applied after the font size (1.7 for Myanmar). */
  lineHeight: number
  minSize?: number
  maxSize?: number
  measure: TextMeasurer
}

export interface FitResult {
  /** The size to render at (points). */
  fontSize: number
  /** False when the text still exceeds the box at `fontSize`. */
  fits: boolean
  /** Wrapping chosen for `fontSize`. */
  lines: string[]
  /** Widest wrapped line at `fontSize` (points). */
  width: number
  /** `lines.length * lineHeight * fontSize` (points). */
  height: number
  /** True when auto-fit picked a size different from `originalSize`. */
  scaled: boolean
  reason: 'empty' | 'fits' | 'shrunk' | 'overflow'
}

export const FIT_MIN_SIZE = 6
const LINE_SNAP = 0.25

/** Greedy word wrap; CJK/Myanmar may break between characters. */
export function wrapLines(
  text: string,
  maxWidth: number,
  widthOf: (chunk: string) => number,
): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const out: string[] = []
  for (const paragraph of normalized.split('\n')) {
    if (paragraph.length === 0) {
      out.push('')
      continue
    }
    if (widthOf(paragraph) <= maxWidth) {
      out.push(paragraph)
      continue
    }
    let line = ''
    // Split into tokens: words (space-terminated) and single wide characters.
    const tokens = tokenize(paragraph)
    for (const token of tokens) {
      const candidate = line.length === 0 ? token : line + token
      if (line.length > 0 && widthOf(candidate) > maxWidth) {
        out.push(line.replace(/\s+$/g, ''))
        line = token.replace(/^\s+/, '')
      } else {
        line = candidate
      }
      // A single token wider than the box still gets its own line.
      if (line.length > 0 && widthOf(line) > maxWidth && !line.includes(' ')) {
        out.push(line)
        line = ''
      }
    }
    if (line.trim().length > 0 || out.length === 0) out.push(line.replace(/\s+$/g, ''))
  }
  return out
}

/** Latin words keep their spaces; CJK/Myanmar/Arabic break per character. */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let word = ''
  for (const char of text) {
    if (char === ' ' || char === '\t') {
      word += char
      if (word.length > 0) tokens.push(word)
      word = ''
      continue
    }
    if (isWide(char)) {
      if (word.length > 0) {
        tokens.push(word)
        word = ''
      }
      // Wide scripts have no spaces: every character is a break opportunity.
      tokens.push(char)
      continue
    }
    word += char
  }
  if (word.length > 0) tokens.push(word)
  return tokens
}

function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x1000 && code <= 0x109f)
  )
}

/** Height of `text` wrapped in `box.width` at `fontSize` (points). */
export function measureBlock(
  text: string,
  box: FitBox,
  fontSize: number,
  lineHeight: number,
  measure: TextMeasurer,
  font: { fontFamily: string; bold: boolean; italic: boolean },
): { lines: string[]; width: number; height: number } {
  const probe = (chunk: string): number =>
    measure({
      text: chunk,
      fontFamily: font.fontFamily,
      fontSize,
      bold: font.bold,
      italic: font.italic,
    })
  const lines = wrapLines(text, box.width, probe)
  let width = 0
  for (const line of lines) width = Math.max(width, probe(line))
  return { lines, width, height: lines.length * lineHeight * fontSize }
}

/**
 * Largest size in `[minSize, maxSize]` whose wrapped text fits the box;
 * returns `minSize` (and `fits: false`) when nothing fits.
 */
export function fitBlockText(request: FitRequest): FitResult {
  const minSize = Math.max(1, request.minSize ?? FIT_MIN_SIZE)
  const maxSize = Math.max(
    minSize,
    request.maxSize ?? Math.max(request.originalSize, minSize) * 1.5,
  )
  const font = {
    fontFamily: request.fontFamily,
    bold: request.bold,
    italic: request.italic,
  }
  const trimmed = request.text.trim()
  if (trimmed.length === 0 || request.box.width <= 0 || request.box.height <= 0) {
    return {
      fontSize: request.originalSize,
      fits: true,
      lines: [],
      width: 0,
      height: 0,
      scaled: false,
      reason: 'empty',
    }
  }

  const fitsAt = (size: number) =>
    measureBlock(trimmed, request.box, size, request.lineHeight, request.measure, font)

  // Does the original size already fit? Then keep it untouched.
  const atOriginal = fitsAt(request.originalSize)
  if (atOriginal.width <= request.box.width && atOriginal.height <= request.box.height) {
    return {
      fontSize: request.originalSize,
      fits: true,
      lines: atOriginal.lines,
      width: atOriginal.width,
      height: atOriginal.height,
      scaled: false,
      reason: 'fits',
    }
  }

  // Binary search for the largest fitting size (monotone: smaller ⇒ fits).
  let low = minSize
  let high = Math.min(maxSize, request.originalSize)
  let best = -1
  for (let i = 0; i < 24 && low <= high; i += 1) {
    const mid = Math.floor(((low + high) / 2) * 4) / 4
    const measured = fitsAt(mid)
    if (measured.width <= request.box.width && measured.height <= request.box.height) {
      best = mid
      low = mid + LINE_SNAP
    } else {
      high = mid - LINE_SNAP
    }
  }

  if (best > 0) {
    const measured = fitsAt(best)
    return {
      fontSize: roundSize(best),
      fits: true,
      lines: measured.lines,
      width: measured.width,
      height: measured.height,
      scaled: roundSize(best) !== request.originalSize,
      reason: 'shrunk',
    }
  }

  const smallest = fitsAt(minSize)
  return {
    fontSize: roundSize(minSize),
    fits: false,
    lines: smallest.lines,
    width: smallest.width,
    height: smallest.height,
    scaled: roundSize(minSize) !== request.originalSize,
    reason: 'overflow',
  }
}

function roundSize(value: number): number {
  return Math.round(value * 100) / 100
}

/** Shared text-context surface (browser canvas and OffscreenCanvas agree). */
type TextContext = Pick<
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  'font' | 'measureText'
>

/** Factory for the measuring context (default: a DOM canvas). */
export type MeasurerContextFactory = () => TextContext | null

/**
 * Browser measurer: one shared 2D context, font specified in points (canvas
 * wants pixels, and 1pt = 96/72px at the CSS reference resolution).
 * Falls back to a metric-free estimate when no canvas is available (jsdom).
 *
 * Pass a factory to measure inside a worker (`OffscreenCanvas`) — the export
 * compositor does exactly that.
 *
 * `onFallback` fires once, when no context could be opened. It matters to a
 * caller that is *positioning* text rather than merely guessing at it: reflow
 * moves a block by what this returns, so an estimated width can leave a page a
 * line out and the reader should be told the export was approximate.
 */
export function createCanvasMeasurer(
  factory?: MeasurerContextFactory,
  onFallback?: () => void,
): TextMeasurer {
  let ctx: TextContext | null = null
  let probed = false
  return (input) => {
    if (!probed) {
      // Probe once. A measurer is called once per wrapped line, and an export
      // measures every block on the page, so re-trying a missing canvas (jsdom,
      // a context that refuses to open) would pay for itself never.
      probed = true
      if (factory) ctx = factory()
      else if (typeof document !== 'undefined') {
        ctx = document.createElement('canvas').getContext('2d') ?? null
      }
      if (!ctx) onFallback?.()
    }
    const px = (input.fontSize * 96) / 72
    if (ctx) {
      const style = input.italic ? 'italic ' : ''
      const weight = input.bold ? '700 ' : '400 '
      ctx.font = `${style}${weight}${px}px ${quoteFamily(input.fontFamily)}`
      return (ctx.measureText(input.text).width * 72) / 96
    }
    // No canvas: assume an average advance of 0.52em (good enough for warnings).
    return input.text.length * input.fontSize * 0.52
  }
}

function quoteFamily(family: string): string {
  const trimmed = family.trim()
  if (trimmed.length === 0) return 'sans-serif'
  return /^[-A-Za-z0-9]+$/.test(trimmed) ? trimmed : `"${trimmed.replace(/"/g, '')}"`
}

let shared: TextMeasurer | null = null

/** Lazily-created shared measurer (one canvas context for the whole app). */
export function textMeasurer(): TextMeasurer {
  if (!shared) shared = createCanvasMeasurer()
  return shared
}

/** Test seam: replace the shared measurer. */
export function setTextMeasurer(next: TextMeasurer | null): void {
  shared = next
}
