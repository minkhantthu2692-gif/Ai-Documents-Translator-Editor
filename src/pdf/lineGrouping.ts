/**
 * Text-item → line grouping.
 *
 * pdf.js hands back one item per text-run. Runs that share a baseline belong
 * to the same visual line; this module clusters them, joins the pieces with
 * sensible word gaps, computes a top-left-origin bounding box in page points
 * and derives a portable line style (family, size, weight, italic, colour,
 * rotation) plus a stable id.
 */

import { lineId, type BBox } from './stableId'

export interface TextItemLike {
  str: string
  transform: number[]
  width: number
  height: number
  dir?: string
  fontName?: string
  hasEOL?: boolean
}

export interface LineStyle {
  /** Font family with the subset prefix removed (e.g. `ABCDEF+Bold` → `Bold`). */
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  /** `#rrggbb`, defaults to black when the content stream colour is unknown. */
  color: string
  /** Degrees, normalised to (-180, 180]. */
  rotation: number
}

/** One text run inside a line: its horizontal extent and the text it carries. */
export interface LineRun {
  /** Axis-aligned extent in page points, corners transformed. */
  x: number
  w: number
  /**
   * Text contributed by this run, *including* the word space inserted before it
   * (except for the first run). Joining every run's `text` reproduces the
   * line's text exactly, and any contiguous slice reproduces that slice's —
   * which is what lets a merged line be cut back into its columns.
   */
  text: string
}

export interface GroupedLine {
  id: string
  text: string
  bbox: BBox
  style: LineStyle
  /** Indices into the input item array, in visual order. */
  itemIndexes: number[]
  /**
   * Per-run geometry, left to right. Absent on lines built by hand (tests,
   * OCR) and on lines the caller never needs to cut apart.
   *
   * This exists because clustering is baseline-driven with no horizontal limit:
   * two columns laid out on a common grid arrive as a *single* line spanning
   * both, and the bounding box then hides the gutter completely. Without the
   * sub-line geometry there is no way for the structure pass to see where the
   * columns are — which is exactly the "merged column lines" reading-order
   * problem.
   */
  runs?: LineRun[]
}

export interface GroupOptions {
  pageIndex: number
  /** Page height in PDF points — used to convert to top-left coordinates. */
  pageHeight: number
  /** Optional per-item fill colour coming from the operator list. */
  colors?: Array<string | null | undefined>
  /**
   * Optional per-item style overrides coming from the resolved font objects
   * (pdf.js reports real bold/italic flags that font *names* alone miss).
   * Indexed like `colors`.
   */
  styles?: Array<Partial<LineStyle> | null | undefined>
  /** Force this style (used when re-grouping OCR results). */
  forceStyle?: Partial<LineStyle>
}

interface Candidate {
  index: number
  item: TextItemLike
  x: number
  baselineY: number
  width: number
  height: number
  size: number
  rotation: number
  u: [number, number]
  v: [number, number]
}

const SUBSET_PREFIX = /^[A-Z]{6}\+/

/** Removes pdf.js subset prefixes and leading slashes from a font name. */
export function cleanFontName(name: string | undefined): string {
  if (!name) return 'Helvetica'
  const withoutSlash = name.startsWith('/') ? name.slice(1) : name
  const cleaned = withoutSlash.replace(SUBSET_PREFIX, '')
  return cleaned || withoutSlash
}

/** `#rrggbb` from `0xRRGGBB` (pdf.js `getFillRGBColor` values). */
function rgbToHex(color: number | string | null | undefined): string | null {
  if (color == null) return null
  if (typeof color === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase()
    if (/^#[0-9a-f]{3}$/i.test(color)) return color.toLowerCase()
    return null
  }
  if (!Number.isFinite(color)) return null
  return `#${((color >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`
}

function analyzeItem(item: TextItemLike, index: number): Candidate | null {
  if (!item.str || !item.str.trim()) return null
  const [a, b, c, d, e, f] = item.transform ?? []
  if (![a, b, c, d, e, f].every((value) => Number.isFinite(value))) return null

  const verticalSize = Math.hypot(c, d)
  const horizontalSize = Math.hypot(a, b)
  const size = verticalSize || horizontalSize || 10
  const uLength = horizontalSize || 1
  const u: [number, number] = [a / uLength, b / uLength]
  const vLength = verticalSize || 1
  const v: [number, number] = [c / vLength, d / vLength]
  const rotation = Math.round(((Math.atan2(b, a) * 180) / Math.PI) * 100) / 100

  return {
    index,
    item,
    x: e,
    baselineY: f,
    width: item.width || 0,
    height: item.height || size,
    size,
    rotation,
    u,
    v,
  }
}

/** Baseline distance tolerated as "same line" for two candidates. */
function toleranceFor(a: Candidate, b: Candidate): number {
  return Math.max(1, Math.min(a.size, b.size) * 0.45)
}

/** True when the inter-item gap is big enough to warrant a word space. */
function needsSpace(previous: Candidate, next: Candidate): boolean {
  // Measure the gap in reading order: left-to-right for LTR runs, right-to-left
  // for RTL runs (where the first member sits to the right of the next one).
  const gap =
    next.x >= previous.x
      ? next.x - (previous.x + previous.width)
      : previous.x - (next.x + next.width)
  const threshold = Math.max(1, Math.min(previous.size, next.size) * 0.22)
  return gap > threshold
}

function styleOf(candidate: Candidate, options: GroupOptions): LineStyle {
  const fontName = cleanFontName(candidate.item.fontName)
  const override = options.styles?.[candidate.index]
  const bold = override?.bold ?? /bold|black|heavy|semibold|demibold/i.test(fontName)
  const italic = override?.italic ?? /italic|oblique/i.test(fontName)
  const fromItems = override?.color ?? options.colors?.[candidate.index]
  const color = rgbToHex(fromItems) ?? '#000000'
  return {
    fontFamily: override?.fontFamily ?? fontName,
    fontSize: Math.round(candidate.size * 100) / 100,
    bold,
    italic,
    color,
    rotation: candidate.rotation,
    ...options.forceStyle,
  }
}

/**
 * Clusters items into lines.
 *
 * Lines come back sorted top-to-bottom (PDF space, so largest y first), then
 * left-to-right within a row — the reading order the structure pass expects.
 */
export function groupItemsIntoLines(items: TextItemLike[], options: GroupOptions): GroupedLine[] {
  const candidates: Candidate[] = []
  for (let index = 0; index < items.length; index += 1) {
    const candidate = analyzeItem(items[index], index)
    if (candidate) candidates.push(candidate)
  }
  if (candidates.length === 0) return []

  interface Cluster {
    members: Candidate[]
    referenceY: number
    rotation: number
  }
  const clusters: Cluster[] = []

  // Top-to-bottom in PDF space keeps near-baseline runs together.
  const ordered = [...candidates].sort(
    (a, b) => b.baselineY - a.baselineY || a.x - b.x || a.index - b.index,
  )

  for (const candidate of ordered) {
    let target: Cluster | null = null
    for (const cluster of clusters) {
      if (Math.abs(cluster.rotation - candidate.rotation) > 1) continue
      if (
        Math.abs(cluster.referenceY - candidate.baselineY) <=
        toleranceFor(cluster.members[0], candidate)
      ) {
        target = cluster
        break
      }
    }
    if (target) {
      target.members.push(candidate)
      // Keep the reference on the cluster's median baseline.
      target.referenceY =
        target.members.reduce((sum, member) => sum + member.baselineY, 0) / target.members.length
    } else {
      clusters.push({
        members: [candidate],
        referenceY: candidate.baselineY,
        rotation: candidate.rotation,
      })
    }
  }

  const lines: GroupedLine[] = []
  const pageHeight = options.pageHeight

  for (const cluster of clusters) {
    const rtl = cluster.members.every((member) => member.item.dir === 'rtl')
    const members = [...cluster.members].sort((a, b) =>
      rtl ? b.x - a.x : a.x - b.x || a.index - b.index,
    )

    // Text and per-run geometry in one pass: the runs are what let a line that
    // merged across a column gutter be cut back apart later.
    let text = ''
    const runs: LineRun[] = []
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    for (let i = 0; i < members.length; i += 1) {
      const member = members[i]
      const spaced = i > 0 && needsSpace(members[i - 1], member)
      if (spaced) text += ' '
      text += member.item.str

      const corners: Array<[number, number]> = [
        [0, 0],
        [member.width, 0],
        [0, member.height],
        [member.width, member.height],
      ]
      let runMinX = Infinity
      let runMaxX = -Infinity
      for (const [cx, cy] of corners) {
        const px = member.u[0] * cx + member.v[0] * cy + member.x
        const py = member.baselineY + member.u[1] * cx + member.v[1] * cy
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
        runMinX = Math.min(runMinX, px)
        runMaxX = Math.max(runMaxX, px)
      }
      runs.push({
        x: runMinX,
        w: runMaxX - runMinX,
        text: (spaced ? ' ' : '') + member.item.str,
      })
    }

    const bbox: BBox = {
      x: Math.round(minX * 100) / 100,
      y: Math.round((pageHeight - maxY) * 100) / 100,
      w: Math.round((maxX - minX) * 100) / 100,
      h: Math.round((maxY - minY) * 100) / 100,
    }

    const style = styleOf(members[0], options)
    lines.push({
      id: lineId(options.pageIndex, bbox, text),
      text: text.replace(/\s+/g, ' ').trim(),
      bbox,
      style,
      itemIndexes: members.map((member) => member.index),
      runs,
    })
  }

  lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  return lines
}

/** Median font size of the page — the reference used to spot headings. */
export function medianFontSize(lines: GroupedLine[]): number {
  if (lines.length === 0) return 0
  const sizes = lines.map((line) => line.style.fontSize).sort((a, b) => a - b)
  const middle = Math.floor(sizes.length / 2)
  return sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2
}
