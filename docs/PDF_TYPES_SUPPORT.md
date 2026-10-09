# PDF Type Support Matrix

How the translator handles each PDF type from the reference list
(`types-of-pdf-file.md`, 25 types). Status is updated as phases land.

**Legend**

| Mark | Meaning |
| ---- | ------- |
| ✅ | Supported and covered by tests |
| 🔶 | Partial — works with known limitations |
| ⏳ | Planned in the current phase (PDF classification & structure) |
| ❌ | Not yet supported |

**Page classes** (per-page classification, `src/pdf/pageClassify.ts` +
`src/pdf/layoutComplexity.ts`):

| Class    | Detected when                                        | Extraction method       |
| -------- | ---------------------------------------------------- | ----------------------- |
| `text`   | Usable text layer, single-column layout              | Text extraction         |
| `scanned`| Page is images only (no usable text layer)           | OCR ✅ (browser Tesseract, auto-runs in the parse window; sidecar OCR ⏳) |
| `mixed`  | Text layer **and** images on one page                | Hybrid ✅ (text layer + OCR of the rest, geometric dedup) |
| `complex`| Text layer present, but layout breaks reading order  | Text extraction, careful structure handling |
| `empty`  | Nothing on the page                                  | Nothing to translate    |

Complex-layout signals (scored in `src/pdf/layoutComplexity.ts`): ≥3 text
columns, overlapping text boxes (sidebars/watermarks), rotated text or page,
table-like rows, slide-like font-size spread, image-heavy pages. Column
detection runs on the **raw text runs** (item boxes), so it survives line
clustering merging columns together.

Optional **Python sidecar** (`sidecar/`): PyMuPDF + pdfplumber + Tesseract
behind a local HTTP service — protocol v1 server with a 20-test suite ✅, and
**wired into the browser as of phase b2** ✅. `src/sidecar/sidecarClient.ts`
probes `GET /health` once per run (cached, longer when it is absent) and, when
the sidecar can serve the request, `POST /ocr` answers a scanned page straight
from the PDF — no browser rasterisation, no WASM core, no CDN traineddata
download. The response carries per-line text, page-point boxes and a mean
confidence, which the client converts to pixel boxes for the existing
structure pass. Everything else degrades gracefully with no sidecar: an
absent, blocked, misconfigured or tesseract-less sidecar resolves `null`, the
browser Tesseract path takes over, and the user sees no error and no delay
beyond one cached probe. Configure with `VITE_PDF_SIDECAR_URL` (default
`http://localhost:8790`; set it blank to disable the sidecar entirely).

## The 25 types

| #  | Type                                    | Status | Notes |
| -- | --------------------------------------- | ------ | ----- |
| 1  | Text-Based PDF                          | ✅     | Text layer → lines → blocks with headings, lists, styles, fonts, special characters; classified `text` |
| 2  | Scanned PDF (image-only, rotated, low-res, OCR) | ✅ | Classification `scanned` + auto-OCR inside the parse window (browser Tesseract: `queued→running→done`, confidence + text blocks persisted, E2E-verified); local sidecar OCR ✅ preferred automatically when running; pre-flight warns and offers OCR; rotated scans still need OSD ❌ |
| 3  | Mixed PDF (text + scanned pages/images) | 🔶 | Per-page classes + method selection ✅ (text / OCR / hybrid): hybrid keeps the text layer authoritative, OCRs the rest and drops blocks that overlap existing text (unit-tested); reading order across merged column lines ✅ |
| 4  | Multi-Column PDF (2/3-col, newspaper, reading order) | ✅     | `complex` classification for ≥3 columns ✅ (item-level gutter detection); reading order ✅ — rows fused across a gutter are cut back into one line per column, columns are read left-to-right (2–4), and a title spanning the fold opens its own zone ahead of both columns |
| 5  | PDF With Images (captions, diagrams, charts) | 🔶 | Images kept in the page render/background ✅; image-anchored extraction + caption linkage in phase c |
| 6  | PDF With Tables (simple/complex, merged cells, multi-page) | 🔶→⏳ | Row detection + table blocks ✅ (text representation); table rows are explicitly exempt from the column split so merging cells stay one row; pdfplumber cell extraction implemented in the sidecar server (frontend integration pending), merged cells/multi-page ❌ |
| 7  | Academic / Research PDF (footnotes, refs, citations, equations) | 🔶→⏳ | 2-column papers classified `text` ✅ and read in column order ✅; footnote regions ✅ (see below); heading hierarchy in phase c; equations ❌ (see #23) |
| 8  | Business / Report PDF (reports, invoices, financial) | 🔶 | Paragraph/table extraction ✅; invoice form layout understanding ❌ |
| 9  | Forms / Structured PDF (fillable, checkboxes, signatures) | 🔶 | Field detection/counted in probe ✅, password-style unlock flow ✅; translating labels in phase c; form filling ❌ (out of scope) |
| 10 | Presentation PDF (slides, big headings, text boxes) | 🔶→⏳ | Size-spread/complexity signal ✅; per-slide text-box reading order in phase c |
| 11 | Book / Document PDF (chapters, TOC, headers/footers, page numbers, long docs) | 🔶→⏳ | Header/footer bands, page labels, running heads ✅; long-document chunked translation ✅; footnote regions ✅ |
| 12 | Magazine / Brochure (complex layouts, multi-column, text around images) | 🔶→⏳ | `complex` classification ✅ (columns, overlap, size spread); multi-column reading order ✅; text-around-image structure repair in phase c |
| 13 | Technical PDF (manuals, code snippets, diagrams) | 🔶 | Extracts as text ✅; code formatting preservation ❌ (phase c) |
| 14 | Legal PDF (contracts, numbered sections, footnotes) | 🔶→⏳ | Numbered-section/list handling ✅; footnote regions ✅ — `1.`, `1)`, `1` and `(a)` callouts are recognised, so numbered notes are not read as list items |
| 15 | Password-Protected / Encrypted PDF | ✅     | Wizard password prompt, wrong-password explanation, unlocked pre-flight; graceful unsupported-encryption errors; fixture-tested (RC4) |
| 16 | Large PDF (hundreds/thousands of pages) | ✅     | 300-page fixture: worker-side probe/parse, main thread stays responsive, resumable queue, progress UI, chunked translation |
| 17 | Unicode / Multilingual (Burmese, CJK, Arabic, Devanagari, Cyrillic) | 🔶→⏳ | Language detection + Zawgyi/Unicode handling ✅, Myanmar rendering ✅; OCR validated for English end-to-end, other scripts need their tesseract traineddata (mya available, untested) |
| 18 | RTL PDF (Arabic, Hebrew, mixed) | 🔶     | RTL line ordering in grouping ✅; bidi/visual-order edge cases ❌ |
| 19 | PDF With Annotations (comments, highlights, stamps, links) | 🔶→⏳ | Annotation/link counting in probe ✅; links preserved as clickable text in exports phase c |
| 20 | Damaged / Invalid PDF | 🔶     | Load/probe failures surface as actionable errors ✅; partial repair ❌ |
| 21 | PDF With Embedded Fonts (subset/custom/fallback) | ✅     | Font inventory (embedded/standard/other) in metadata ✅, subset-prefix cleaning ✅, Myanmar fallback stack in export ✅ |
| 22 | PDF With Complex Layout (text boxes, overlap, sidebars, watermarks) | ⏳→✅   | `complex` class + scoring ✅ (this phase); column/sidebar reading order ✅; text-box + overlap repair in phase c |
| 23 | PDF With Equations / Math content | ❌     | Formulas extract as plain text (lossy); LaTeX/OCR-of-equations not implemented |
| 24 | PDF With Code (syntax, monospace, formatting) | 🔶→⏳ | Monospace font extracted as style ✅; block-level code formatting phase c |
| 25 | PDF With Hyperlinks (external, internal, TOC, cross-references) | 🔶→⏳ | Link annotations counted ✅; URL text preserved as text ✅; clickable links phase c |

## Phase roadmap for this matrix

| Phase | Delivers | Moves types |
| ----- | -------- | ----------- |
| (a) Classification | `complex` class, complexity scoring, item-level column detection, wizard metadata | 4, 12, 22 classification ✅ |
| (b) Extraction methods | Browser Tesseract OCR auto-runs per window (status lifecycle, confidence, cached recognition), hybrid merge with geometric dedup, run-OCR setting persisted per project, Python sidecar server (protocol v1, 20 tests) | 2, 3 extraction ✅ |
| (b2) Sidecar wiring | `src/sidecar/sidecarClient.ts`: cached `GET /health` probe, `POST /ocr` with page/language/password, per-line confidence added to the server response, lazy render so a sidecar page never rasterises in the browser, automatic fall-back to browser Tesseract on any failure (22 client + 5 pipeline + 1 Python test) | 2 extraction ✅ with a native-OCR fast path |
| (c) Structure preservation | **Reading order ✅** — `src/pdf/readingOrder.ts` cuts rows fused across a column gutter back into one line per column, orders 2–4 columns left to right, and gives a title that spans the fold its own zone ahead of both columns. **Footnote regions ✅** — `src/pdf/footnotes.ts` marks them before any merging happens. Remaining in this phase: real table cells, links, code blocks, headings | 4 ✅, reading order for 3 / 7 / 12 ✅, footnotes for 7 / 11 / 14 ✅; then 5, 6, 9, 13, 19, 24, 25 |
| (d) Layout auto-adjust | Auto-fit/reflow when translated text grows (EN→MY), export height handling | 1, 8, 10, 12 (translation-time layout) |

### Why reading order needed two detectors

Line clustering is baseline-driven with no horizontal limit, so two columns
laid out on a shared grid reach the structure pass as **one line per row** —
`Left half … Right half` — whose bounding box spans the fold. At that point the
gutter is not merely undetected, it is *absent from the geometry*, so no
ordering strategy can recover it. Reading order therefore works at two
granularities: `splitMergedLines` finds the empty band inside the **runs**
(before ordering, so columns exist at all), and `orderBodyLines` then places the
resulting lines by **line** (columns left to right, zones cut by lines that
genuinely span the gutter). Table rows are exempt throughout — their cells are
cells *because* they ride one baseline, so cutting there would turn one table
block into a stack of single-cell paragraphs. `detectColumns` (complexity
scoring) deliberately keeps refusing pages whose title bridges the gutter; that
refusal is correct for scoring and wrong for order, which is why
`structurePage` does not use it.

### Why footnotes need three signals

A footnote is the one kind of body text that must *not* behave like body text:
it is set small, it sits where a caption could sit, and it is close enough to
the paragraph above to be swallowed by the paragraph merger — after which its
marker is buried mid-sentence and the note is translated as part of the wrong
text. But each signal alone is also a trap: size alone swallows captions (a
figure note is small too), placement alone swallows any small print at the foot
of a page, and a marker alone swallows every numbered section of a legal
contract. `src/pdf/footnotes.ts` therefore requires **all three** — type below
`0.92 ×` the page's body size, a line starting at or below `55%` of the page
height, and a callout marker (`1`, `1.`, `1)`, `[3]`, `(a)`, `*`, `†`, Myanmar
digits) — for the line that *opens* a note. The lines continuing it only have
to be small, flush with the opener and directly below, because requiring a
marker on every line would miss every continuation.

Marking runs on the already-ordered body and before any merging, and
`structurePage` then enforces two block boundaries: a note never joins the
paragraph above it, and a note never joins the note below it (openers carry a
marker, continuations do not). `footnote` is a new `BlockKind`; the note's
marker deliberately stays **inside the block text** rather than becoming a
`listMarker`, because exports re-attach `listMarker` in front of the text and
the callout would print twice.

### Why list markers are re-attached idempotently

Lists are the converse case: a parsed bullet line keeps its marker **both**
inside the text — the bullet glyph really is part of the line pdf.js hands us —
and in `listMarker`, which every export builder puts back in front. Prompt rule
3 asks the model to leave the marker out of the translation, so the target
normally arrives without one and the two copies never meet. But every block
that has not been translated yet falls back to the *source*, which still has
it, and a model may ignore the rule and keep it; either way each format
printed `• • item`.

`listPrefix(block, text?)` therefore takes the text it is about to prefix and
returns `''` when that text already begins with the marker at a word boundary
— `1.` must not be read as a prefix of `1.5`, nor `-` of `-5`. The six
builders that emit a marker (Markdown, plain text, HTML absolute + flow, DOCX,
EPUB and the composited PDF/PNG) each pass the string they are actually
prefixing, which is why HTML's flow layout needs one call per paragraph: its
source and target lines differ, and only one of them may carry the bullet.
`json` and `delimited` keep the raw pair (`sourceText` with `listMarker`) —
they are data exports, and dropping either half would lose information.

_Known limitations carried over: table cell truncation at 45k characters,
style reset on re-parse, no equation rendering (type 23). Reading order is
unit-tested against synthetic column geometries (2/3/4 columns, fused rows,
spanning titles, tables); no real multi-column PDF has been run through it
end-to-end yet. Footnote detection is likewise tested on synthetic geometry: a
note set at the *same* size as the body is not detected (nothing separates it
but the horizontal rule above it, which is a graphics path pdf.js never hands
over), and a page whose text is mostly note type reports the note size as its
body median — so neither is recognised._
