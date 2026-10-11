/**
 * The parameters every `getDocument()` in the app shares.
 *
 * They look like housekeeping (where do the cMaps live) but one of them decides
 * whether a page paints at all, and the failure mode is silent: a page of
 * hollow squares that looks fine at thumbnail size. Reproduced against a real
 * 8-page PDF on 11 Oct 2026 before the fix, and kept here so it cannot come
 * back.
 */

import { describe, expect, it } from 'vitest'
import { PDF_CMAP_URL, PDF_DOCUMENT_PARAMS, PDF_STANDARD_FONT_URL } from './pdfAssets'

describe('PDF document parameters', () => {
  it('paints glyphs as paths, because a worker cannot install a font', () => {
    // Pages are rendered inside the analysis worker, and a worker has no
    // `document`, so pdf.js cannot register a `FontFace`. Without this flag it
    // draws with `ctx.font` set to the embedded font's own name, which the
    // browser does not have: every glyph the system fallback lacks becomes a
    // square. That is not a rare edge — it is what happened to a real document
    // whose embedded fonts used a custom encoding, turning a full page into
    // boxes at 100% while its English pages looked fine and nothing at all was
    // wrong at thumbnail size. With the flag, pdf.js emits each glyph as a
    // canvas path, so painting depends on no font installation at all.
    expect(PDF_DOCUMENT_PARAMS.disableFontFace).toBe(true)
  })

  it('does not force system fonts alongside disableFontFace', () => {
    // pdf.js already defaults `useSystemFonts` to false when `disableFontFace`
    // is set, and asserts inside `loadSystemFont` if the two are forced to
    // disagree. Forcing it true here would trade squares for a thrown
    // assertion on any base-14 font.
    expect(PDF_DOCUMENT_PARAMS.useSystemFonts).toBe(false)
  })

  it('keeps shipping the data the non-embedded fallbacks need', () => {
    // Being independent of installed fonts only works because the base-14 data
    // and the cMaps are fetched at runtime; drop either and a non-embedded
    // font has nothing left to draw from.
    expect(PDF_DOCUMENT_PARAMS.cMapUrl).toBe(PDF_CMAP_URL)
    expect(PDF_DOCUMENT_PARAMS.standardFontDataUrl).toBe(PDF_STANDARD_FONT_URL)
    expect(PDF_DOCUMENT_PARAMS.cMapPacked).toBe(true)
    expect(PDF_CMAP_URL).toContain('cmaps')
    expect(PDF_STANDARD_FONT_URL).toContain('standard_fonts')
  })

  it('stays quiet so errors surface through our own reason codes', () => {
    expect(PDF_DOCUMENT_PARAMS.verbosity).toBe(0)
  })
})
