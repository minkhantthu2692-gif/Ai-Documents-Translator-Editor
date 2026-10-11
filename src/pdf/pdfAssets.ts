/**
 * Locations of the data files pdf.js fetches at runtime.
 *
 * Without them CJK/Cyrillic "ToUnicode-less" encodings can't be decoded
 * (`cmaps`) and the base-14 fonts can't be rendered (`standard_fonts`).
 * Both are published under `<BASE_URL>pdfjs-assets/` by the `pdfjsAssets`
 * Vite plugin — served in dev, copied into `dist/` on build — and are fetched
 * lazily, so they never land in the JS bundle. `BASE_URL` keeps the URLs
 * correct when the app is deployed under a sub-path (GitHub Pages).
 */
const ASSET_BASE = import.meta.env.BASE_URL || '/'

export const PDF_CMAP_URL = `${ASSET_BASE}pdfjs-assets/cmaps/`

export const PDF_STANDARD_FONT_URL = `${ASSET_BASE}pdfjs-assets/standard_fonts/`

/**
 * Parameters shared by every `getDocument()` call in the app.
 *
 * `disableFontFace` is the one that matters for *rendering*. Our pages are
 * painted inside the analysis worker, and a worker has no `document`, so pdf.js
 * cannot install a `FontFace`; it falls back to `ctx.font` set to the font's own
 * name, which the browser does not have. Every glyph the system fallback then
 * lacks is drawn as a square — which is exactly how a Myanmar-source PDF
 * becomes a full page of boxes at 100% while its English pages look fine and
 * nothing at all is wrong at thumbnail size. With `disableFontFace` pdf.js emits
 * each glyph as a canvas *path* instead, so painting depends on no font
 * installation whatsoever and renders identically on every machine.
 *
 * It also forces `useSystemFonts` off, which is what pdf.js itself defaults to
 * when `disableFontFace` is set (it asserts in `loadSystemFont` if the two are
 * forced to disagree). That is a net gain rather than a cost: base-14 fonts are
 * drawn from the `standard_fonts` data we ship instead of whatever the machine
 * happens to have installed, so a page looks the same everywhere.
 *
 * Text extraction is unaffected — `getTextContent()` reads the content stream
 * and the ToUnicode map, never the font renderer.
 */
export const PDF_DOCUMENT_PARAMS = {
  cMapUrl: PDF_CMAP_URL,
  cMapPacked: true,
  standardFontDataUrl: PDF_STANDARD_FONT_URL,
  disableFontFace: true,
  useSystemFonts: false,
  // Keep pdf.js quiet: errors are surfaced through our own reason codes.
  verbosity: 0,
} as const
