/**
 * Locations of the data files pdf.js fetches at runtime.
 *
 * Without them CJK/Cyrillic "ToUnicode-less" encodings can't be decoded
 * (`cmaps`) and the base-14 fonts can't be rendered (`standard_fonts`).
 * Both are published under `/pdfjs-assets/` by the `pdfjsAssets` Vite plugin —
 * statically in dev, copied into `dist/` on build — and are fetched lazily, so
 * they never land in the JS bundle.
 */
export const PDF_CMAP_URL = '/pdfjs-assets/cmaps/'

export const PDF_STANDARD_FONT_URL = '/pdfjs-assets/standard_fonts/'

/** Parameters shared by every `getDocument()` call in the app. */
export const PDF_DOCUMENT_PARAMS = {
  cMapUrl: PDF_CMAP_URL,
  cMapPacked: true,
  standardFontDataUrl: PDF_STANDARD_FONT_URL,
  useSystemFonts: true,
  // Keep pdf.js quiet: errors are surfaced through our own reason codes.
  verbosity: 0,
} as const
