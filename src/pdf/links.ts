/**
 * Link annotations → links an export can actually render.
 *
 * pdf.js hands back a `/Link` annotation as a rectangle in PDF user space and
 * either a URI or an internal destination; it never says *which words* it
 * covers, and that is the whole problem: an export has to wrap the right
 * characters in an `<a>` (or a `TextRun`), not just remember that the page had
 * a link somewhere on it.
 *
 * The anchor is therefore reconstructed geometrically — the rectangle is
 * matched against the page's lines, and the runs inside it are located inside
 * the line's own text by searching for them. Slicing `line.text` (rather than
 * re-joining run fragments) is what makes every anchor a *substring* of the
 * block it lands in: `structurePage` joins lines with `\n`, so a match in the
 * line is a match in the block, and the exporter needs exactly that.
 *
 * Internal destinations (`/Dest`, a table of contents pointing at page 5) are
 * captured with their raw destination by `internalDestinations`; turning that
 * into a page index needs the document (`getDestination` / `getPageIndex`),
 * which this layer does not have — the caller resolves them and hands the
 * result back as a `PageLink` with a `destPage`. An anchor only survives
 * translation if the model kept the words; URLs and citations do, ordinary
 * prose does not, which is why `applyLinks` in the exporters also falls back
 * to wrapping a literal occurrence of the URL.
 */

import type { GroupedLine, TextItemLike } from './lineGrouping'
import { type LinkRef, type PageBlock } from './structure'
import { type BBox } from './stableId'

export type { LinkRef } from './structure'

/** A `/Link` annotation as a rectangle in top-left page points. */
export interface PageLink {
  /** Absolute URL for external links; empty string for internal ones. */
  url: string
  /** 0-based target page for internal links, null for external ones. */
  destPage: number | null
  bbox: BBox
}

/** A link with the words it covers, ready to be filed under a block. */
export interface LinkAnchor extends LinkRef {
  /** The annotation rectangle, used to pick the block. */
  bbox: BBox
}

/** Schemes a browser navigates instead of interpreting. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'ftp:', 'tel:'])

/** Longest URI we will carry: enough for a real URL, not for a payload. */
const MAX_URL_LENGTH = 2048

/** `example.com/path` — a URI written without a scheme, which PDFs do a lot. */
const BARE_HOST = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/|\?|#|$)/i

/**
 * A URL that is safe to put in an `href`, or null.
 *
 * This is the only thing standing between a hostile PDF and the exported
 * HTML, so it is deliberately strict: an explicit scheme from the allow-list,
 * or a bare host we promote to `https://`. Everything else — `javascript:`,
 * `data:`, a relative path, an absurdly long string — is dropped rather than
 * escaped, because escaping does not neutralise a scheme.
 */
export function safeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return null

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (scheme === null) {
    // No scheme: accept `www.example.com/...` and give it https, reject
    // anything that does not at least look like a host (`../../index.html`).
    if (!BARE_HOST.test(url)) return null
    return `https://${url}`
  }
  return SAFE_SCHEMES.has(`${scheme[1].toLowerCase()}:`) ? url : null
}

/**
 * PDF rectangle (bottom-left origin) → top-left page points.
 *
 * Shared with `formFields.ts`: a widget's `/Rect` and a link's `/Rect` are the
 * same rectangle in the same space, and converting it twice would be two
 * places for the flip to disagree.
 */
export function rectToBBox(rect: unknown, pageHeight: number): BBox | null {
  if (!Array.isArray(rect) || rect.length < 4) return null
  const [x1, y1, x2, y2] = rect as number[]
  if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) return null
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  const top = pageHeight - Math.max(y1, y2)
  const bottom = pageHeight - Math.min(y1, y2)
  const bbox: BBox = { x: left, y: top, w: right - left, h: bottom - top }
  return bbox.w > 0 && bbox.h > 0 ? bbox : null
}

/**
 * External links on one page, in annotation order.
 *
 * A `/Link` that carries an internal destination instead of a URI is not a
 * broken link — it is a different feature, and it comes out of
 * `internalDestinations` rather than here, because a page index cannot be
 * resolved without the document.
 */
export function linksFromAnnotations(
  annotations: ReadonlyArray<{
    subtype?: string
    url?: string
    unsafeUrl?: string
    rect?: number[]
  }>,
  pageHeight: number,
): PageLink[] {
  const links: PageLink[] = []
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link') continue
    const url = safeLinkUrl(annotation.url) ?? safeLinkUrl(annotation.unsafeUrl)
    if (url === null) continue
    const bbox = rectToBBox(annotation.rect, pageHeight)
    if (bbox === null) continue
    links.push({ url, destPage: null, bbox })
  }
  return links
}

/** One internal `/Link`: its raw destination and the rectangle it sits on. */
export interface InternalDestination {
  /** The annotation's `/Dest` — a name (string) or `[ref, /XYZ, …]`. */
  dest: unknown
  bbox: BBox
}

/**
 * Internal links on one page — `/Link` annotations whose action is a
 * destination inside the same document rather than a URI.
 *
 * The destination is handed back raw: resolving a named destination to a page
 * index needs `getDestination`/`getPageIndex` on the document, which this
 * layer never sees. An annotation with a safe URI is excluded even if it also
 * carries a `dest`, because the URI is what the PDF chose to navigate.
 */
export function internalDestinations(
  annotations: ReadonlyArray<{
    subtype?: string
    url?: string
    unsafeUrl?: string
    dest?: unknown
    rect?: number[]
  }>,
  pageHeight: number,
): InternalDestination[] {
  const destinations: InternalDestination[] = []
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link') continue
    if (safeLinkUrl(annotation.url) !== null || safeLinkUrl(annotation.unsafeUrl) !== null) continue
    const dest = annotation.dest
    if (typeof dest !== 'string' && !Array.isArray(dest)) continue
    const bbox = rectToBBox(annotation.rect, pageHeight)
    if (bbox === null) continue
    destinations.push({ dest, bbox })
  }
  return destinations
}

/**
 * Horizontal extent of one text run, the same corner walk `itemBoxesOf` does.
 *
 * Written out rather than reused because `itemBoxesOf` drops zero-width runs,
 * which would desynchronise the array from the item indexes we index by.
 */
function itemXExtent(item: TextItemLike | undefined): { x: number; w: number } | null {
  if (item === undefined) return null
  const [a, b, c, d, e] = item.transform ?? []
  if (![a, b, c, d, e].every((value) => Number.isFinite(value))) return null
  const horizontal = Math.hypot(a, b) || 1
  const vertical = Math.hypot(c, d) || 1
  const u = a / horizontal
  const v = c / vertical
  const width = item.width || 0
  const height = item.height || vertical
  let minX = e
  let maxX = e
  for (const cx of [0, width]) {
    for (const cy of [0, height]) {
      const px = u * cx + v * cy + e
      minX = Math.min(minX, px)
      maxX = Math.max(maxX, px)
    }
  }
  return maxX - minX > 0 ? { x: minX, w: maxX - minX } : null
}

function overlapsY(line: GroupedLine, link: BBox): boolean {
  return line.bbox.y < link.y + link.h && line.bbox.y + line.bbox.h > link.y
}

/**
 * The words one line of a link actually covers.
 *
 * Each run is located inside `line.text` with a moving cursor, so the result
 * is a slice of the line — never a re-assembly that could differ from it by a
 * gap-filling space. Runs are recorded only when their box reaches into the
 * rectangle, and the slice spans from the first to the last of them, which
 * keeps text the rectangle passes *between* two covered runs.
 *
 * The slice is then narrowed to the part of each run the rectangle covers,
 * cut proportionally across the run's width. pdf.js emits one item per `Tj`
 * operator, so a line written as a single show-text call arrives as one run
 * forty words wide; without the narrowing the anchor would be the whole line,
 * every word on it clickable and the `<a>` in the export far larger than the
 * PDF ever was. The cut is exact for monospaced type and approximate for
 * proportional, which is the right way round to fail: it lands on nearby
 * characters rather than on a neighbouring word.
 */
function anchorSlice(line: GroupedLine, items: readonly TextItemLike[], link: BBox): string {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let cursor = 0

  for (const index of line.itemIndexes) {
    const item = items[index]
    const extent = itemXExtent(item)
    if (item === undefined || extent === null || item.str.length === 0) continue
    const found = line.text.indexOf(item.str, cursor)
    if (found < 0) continue
    const end = found + item.str.length

    const left = Math.max(extent.x, link.x)
    const right = Math.min(extent.x + extent.w, link.x + link.w)
    if (right > left) {
      const from = Math.round(((left - extent.x) / extent.w) * item.str.length)
      const to = Math.round(((right - extent.x) / extent.w) * item.str.length)
      minX = Math.min(minX, found + Math.min(Math.max(from, 0), item.str.length))
      maxX = Math.max(maxX, found + Math.min(Math.max(to, 0), item.str.length))
    }
    cursor = end
  }

  if (!Number.isFinite(minX) || maxX <= minX) return ''
  return line.text.slice(minX, maxX).trim()
}

/**
 * One anchor per line the rectangle touches.
 *
 * A link that runs over two lines becomes two anchors rather than one that
 * straddles the `\n` `structurePage` joined the lines with, because an anchor
 * containing the joiner would never be found inside the block text.
 */
export function linkAnchors(
  links: readonly PageLink[],
  lines: readonly GroupedLine[],
  items: readonly TextItemLike[],
): LinkAnchor[] {
  const anchors: LinkAnchor[] = []
  for (const link of links) {
    for (const line of lines) {
      if (!overlapsY(line, link.bbox)) continue
      const text = anchorSlice(line, items, link.bbox)
      if (text.length === 0) continue
      anchors.push({
        text,
        url: link.url,
        ...(link.destPage !== null ? { destPage: link.destPage } : {}),
        bbox: link.bbox,
      })
    }
  }
  return anchors
}

function overlapArea(a: BBox, b: BBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The block a rectangle belongs to: its centre first, then best overlap. */
function blockFor(blocks: readonly PageBlock[], bbox: BBox): PageBlock | null {
  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2
  const containing = blocks.find(
    (block) =>
      cx >= block.bbox.x &&
      cx <= block.bbox.x + block.bbox.w &&
      cy >= block.bbox.y &&
      cy <= block.bbox.y + block.bbox.h,
  )
  if (containing !== undefined) return containing

  let best: PageBlock | null = null
  let bestArea = 0
  for (const block of blocks) {
    const area = overlapArea(block.bbox, bbox)
    if (area > bestArea) {
      bestArea = area
      best = block
    }
  }
  // A rectangle that barely grazes a block belongs to nobody; guessing would
  // put the link on the wrong paragraph, which is worse than leaving it off.
  return bestArea >= bbox.w * bbox.h * 0.3 ? best : null
}

/** Most links a single block may carry before we stop adding more. */
const MAX_LINKS_PER_BLOCK = 24

/**
 * Files every anchor under the block that holds it, in annotation order.
 *
 * Every block starts with an empty list, so a reader never has to test for
 * `undefined`, and repeats collapse — a rectangle that covers four lines of
 * the same URL yields one entry only if the slices differ, because two
 * identical anchors would wrap the same words twice.
 */
export function attachLinks(blocks: PageBlock[], anchors: readonly LinkAnchor[]): void {
  for (const block of blocks) block.links = []
  for (const anchor of anchors) {
    const block = blockFor(blocks, anchor.bbox)
    if (block === null || block.links.length >= MAX_LINKS_PER_BLOCK) continue
    const seen = block.links.some(
      (link) =>
        link.url === anchor.url &&
        link.text === anchor.text &&
        (link.destPage ?? null) === (anchor.destPage ?? null),
    )
    if (seen) continue
    block.links.push({
      text: anchor.text,
      url: anchor.url,
      ...(anchor.destPage !== undefined && anchor.destPage !== null
        ? { destPage: anchor.destPage }
        : {}),
    })
  }
}
