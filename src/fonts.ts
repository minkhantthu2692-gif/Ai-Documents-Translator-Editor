/**
 * Font inventory for export (Phase 4).
 *
 * Two jobs:
 *
 *  1. **Pre-export check** — the families the extracted blocks reference must
 *     exist in the browser, otherwise the printed/exported page silently
 *     substitutes a different face. Missing families come back as an
 *     `EXPORT_FONT_MISSING` issue with a fix action (substitute a bundled
 *     family).
 *  2. **Self-contained CSS** — HTML/print/EPUB exports inline every used face
 *     as a `data:` URL so the file renders identically on a machine that has
 *     none of our fonts installed (this is what makes Myanmar ligatures and
 *     stacked consonants survive the round trip).
 *
 * Discovery runs through the CSSOM (the app already imported every
 * `@fontsource` stylesheet), so no font file names are hard-coded and Vite's
 * hashed asset URLs are picked up automatically.
 */

import { containsCjk, containsMyanmar } from '@/lib/text'

/** Families the app ships locally (AGENT.md stack). */
export const BUNDLED_FAMILIES = [
  'Noto Sans',
  'Noto Serif',
  'Source Serif 4',
  'Roboto',
  'Inter',
  'Noto Sans Myanmar',
  'Padauk',
] as const

export interface FontFaceInfo {
  family: string
  weight: string
  style: string
  /** Absolute URL of the font file (same-origin asset or data URL). */
  url: string
  unicodeRange: string
}

export interface FontCheckResult {
  /** Families we could not resolve (drive `EXPORT_FONT_MISSING`). */
  missing: string[]
  /** Families that resolved (including bundled ones). */
  ok: string[]
}

function quoted(family: string): string {
  const trimmed = family.trim()
  if (trimmed.length === 0) return 'sans-serif'
  return /^[-A-Za-z0-9]+$/.test(trimmed) ? trimmed : `"${trimmed.replace(/"/g, '')}"`
}

/** True when the browser can render text in `family`. */
export function hasFamily(family: string): boolean {
  if ((BUNDLED_FAMILIES as readonly string[]).includes(family)) return true
  if (typeof document === 'undefined' || !('fonts' in document)) return true
  try {
    return document.fonts.check(`16px ${quoted(family)}`)
  } catch {
    return true
  }
}

/**
 * Resolves every family asynchronously (triggers a load for faces that are
 * declared but not yet fetched) and reports the ones that stay unavailable.
 */
export async function checkFonts(families: string[]): Promise<FontCheckResult> {
  const unique = [...new Set(families.map((family) => family.trim()).filter(Boolean))]
  const missing: string[] = []
  const ok: string[] = []

  for (const family of unique) {
    if ((BUNDLED_FAMILIES as readonly string[]).includes(family)) {
      ok.push(family)
      continue
    }
    if (typeof document !== 'undefined' && 'fonts' in document) {
      try {
        await document.fonts.load(`16px ${quoted(family)}`, 'MmMmWw')
      } catch {
        /* load failures fall through to check() */
      }
    }
    if (hasFamily(family)) ok.push(family)
    else missing.push(family)
  }
  return { missing, ok }
}

/**
 * Every `@font-face` the app registered, read from the CSSOM. Returns `[]`
 * outside a browser (Vitest) — callers degrade to an empty font CSS.
 */
export function collectFontFaces(target?: FontFaceInfo['family'][]): FontFaceInfo[] {
  if (typeof document === 'undefined' || typeof CSSMediaRule === 'undefined') return []
  const wanted = target ? new Set(target.map((family) => family.toLowerCase())) : null
  const out: FontFaceInfo[] = []
  const seen = new Set<string>()

  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      // Grouping rules (@media / @supports / nested @font-face) are descended.
      const group = rule as unknown as { cssRules?: CSSRuleList }
      if (group.cssRules && group.cssRules.length > 0) {
        walk(group.cssRules)
        continue
      }
      const css = rule as CSSRule & Partial<CSSFontFaceRule>
      if (!('style' in css) || !css.style) continue
      const family = css.style.getPropertyValue('font-family').replace(/["']/g, '').trim()
      if (!family) continue
      if (wanted && !wanted.has(family.toLowerCase())) continue
      const src = css.style.getPropertyValue('src')
      const match = /url\((['"]?)([^'")]+)\1\)/.exec(src)
      if (!match) continue
      const url = new URL(match[2], document.baseURI).href
      const key = `${family}|${css.style.getPropertyValue('font-weight')}|${url}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        family,
        weight: css.style.getPropertyValue('font-weight') || '400',
        style: css.style.getPropertyValue('font-style') || 'normal',
        url,
        unicodeRange: css.style.getPropertyValue('unicode-range') || '',
      })
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules)
    } catch {
      /* cross-origin sheets are not readable; our own assets always are */
    }
  }
  return out
}

/** `ArrayBuffer` → base64 without blowing the call stack on large fonts. */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  if (typeof btoa === 'function') return btoa(binary)
  // Node (tests): Buffer exists there, not in a browser worker.
  return Buffer.from(bytes).toString('base64')
}

export interface FontCssOptions {
  /** Only embed these families (case-insensitive); `null` embeds everything. */
  families: string[] | null
  /** Per-family weight filter (defaults to every weight). */
  weights?: string[]
  /** Called after each font file is inlined (progress). */
  onFont?: (done: number, total: number) => void
  /** Test seam. */
  fetchImpl?: typeof fetch
}

export interface FontCssResult {
  css: string
  embedded: number
  /** Files we could not fetch (they silently stay as a normal URL reference). */
  failed: string[]
}

/**
 * Builds `@font-face` rules with inlined `data:` URLs for the used families.
 * Files already served as `data:` URLs pass through unchanged.
 */
export async function buildFontCss(
  faces: FontFaceInfo[],
  options: FontCssOptions,
): Promise<FontCssResult> {
  const wanted = options.families ? new Set(options.families.map((f) => f.toLowerCase())) : null
  const applicable = faces.filter((face) => {
    if (wanted && !wanted.has(face.family.toLowerCase())) return false
    if (options.weights && options.weights.length > 0) {
      const weight = face.weight.replace(/\s+/g, '')
      if (weight !== 'normal' && !options.weights.includes(weight)) return false
    }
    return true
  })

  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  const rules: string[] = []
  let embedded = 0
  const failed: string[] = []
  let done = 0

  for (const face of applicable) {
    options.onFont?.(done, applicable.length)
    done += 1
    if (face.url.startsWith('data:')) {
      rules.push(faceRule(face, face.url))
      embedded += 1
      continue
    }
    if (!fetchImpl) continue
    try {
      const response = await fetchImpl(face.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = await response.arrayBuffer()
      const mime = mimeFor(face.url)
      rules.push(faceRule(face, `data:${mime};base64,${toBase64(buffer)}`))
      embedded += 1
    } catch {
      failed.push(face.url)
      rules.push(faceRule(face, face.url))
    }
  }

  options.onFont?.(applicable.length, applicable.length)
  return { css: rules.join('\n'), embedded, failed }
}

function faceRule(face: FontFaceInfo, url: string): string {
  const range = face.unicodeRange ? `\n  unicode-range: ${face.unicodeRange};` : ''
  return [
    '@font-face {',
    `  font-family: ${quoted(face.family)};`,
    `  font-style: ${face.style};`,
    `  font-weight: ${face.weight};`,
    `  font-display: block;`,
    `  src: url(${url}) format('${formatFor(url)}');${range}`,
    '}',
  ].join('\n')
}

function formatFor(url: string): string {
  if (url.endsWith('.woff2') || url.includes(';base64')) {
    return url.includes('font/woff2') || url.endsWith('.woff2') ? 'woff2' : 'woff'
  }
  if (url.endsWith('.woff')) return 'woff'
  if (url.endsWith('.ttf')) return 'truetype'
  if (url.endsWith('.otf')) return 'opentype'
  return 'woff2'
}

function mimeFor(url: string): string {
  if (url.endsWith('.woff2')) return 'font/woff2'
  if (url.endsWith('.woff')) return 'font/woff'
  if (url.endsWith('.ttf')) return 'font/ttf'
  if (url.endsWith('.otf')) return 'font/otf'
  return 'application/octet-stream'
}

/** Distinct families referenced by a set of blocks. */
export function familiesOf(blocks: Array<{ fontFamily: string }>): string[] {
  return [
    ...new Set(
      blocks.map((block) => block.fontFamily).filter((family) => family.trim().length > 0),
    ),
  ]
}

/**
 * Substitution for a missing family: pick the bundled face whose script
 * matches the text (Myanmar → Noto Sans Myanmar), else the neutral default.
 */
export function suggestFallback(family: string, sampleText = ''): string {
  if (/myanmar|padauk|mm/i.test(family)) return 'Noto Sans Myanmar'
  if (/mono|code/i.test(family)) return 'Roboto'
  if (/serif|times|georgia|garamond|book/i.test(family)) return 'Noto Serif'
  if (containsMyanmar(sampleText)) return 'Noto Sans Myanmar'
  if (containsCjk(sampleText)) return 'Noto Sans'
  return 'Noto Sans'
}
