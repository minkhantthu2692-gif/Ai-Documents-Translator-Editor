/**
 * Stable identifiers for extracted layout units.
 *
 * A block (or line) must keep the same id across re-parses of the same file so
 * translations, edits and the translation-memory keyed on blockId survive a
 * "re-parse this PDF" action. The id is therefore a pure hash of the page
 * index, the quantised position and the text — never a random counter.
 *
 * Quantisation (0.5pt grid) absorbs the tiny float differences pdf.js can
 * produce between runs while staying far below the visual resolution of the
 * layout.
 */

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/** Rounds to the 0.5pt grid used by stable ids. */
export function quantize(value: number, step = 0.5): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value / step) * step
}

/** FNV-1a 32-bit hash of a string (deterministic, allocation free). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Builds `prefix_<16 hex chars>` from arbitrary parts.
 * Two independent FNV passes with different material reduce collision risk.
 */
export function stableId(prefix: string, parts: Array<string | number>): string {
  const material = parts.map((part) => String(part)).join('|')
  const a = fnv1a(material)
  const b = fnv1a(`aidt|${material}`)
  return `${prefix}_${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/**
 * Deterministic block id: page index + quantised bbox + normalised text.
 * Whitespace collapses so a re-parse with slightly different kerning still
 * produces the same id.
 */
export function blockId(pageIndex: number, bbox: BBox, text: string): string {
  return stableId('blk', [
    pageIndex,
    quantize(bbox.x),
    quantize(bbox.y),
    quantize(bbox.w),
    quantize(bbox.h),
    normalizeForId(text),
  ])
}

/** Deterministic line id: same ingredients, tighter payload. */
export function lineId(pageIndex: number, bbox: BBox, text: string): string {
  return stableId('ln', [
    pageIndex,
    quantize(bbox.x),
    quantize(bbox.y),
    quantize(bbox.h),
    normalizeForId(text),
  ])
}

/** Normalises a string so cosmetic extraction noise does not change the id. */
export function normalizeForId(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** Stable id used as the page-thumbnail cache key. */
export function thumbnailId(projectId: string, pageIndex: number, width: number): string {
  return `thumb:${projectId}:${pageIndex}:${width}`
}
