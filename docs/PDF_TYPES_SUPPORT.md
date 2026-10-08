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
| 3  | Mixed PDF (text + scanned pages/images) | 🔶 | Per-page classes + method selection ✅ (text / OCR / hybrid): hybrid keeps the text layer authoritative, OCRs the rest and drops blocks that overlap existing text (unit-tested); reading-order restructure of merged column lines in phase c |
| 4  | Multi-Column PDF (2/3-col, newspaper, reading order) | 🔶→⏳ | `complex` classification for ≥3 columns ✅ (item-level gutter detection); reading-order restructure of merged column lines in phase c |
| 5  | PDF With Images (captions, diagrams, charts) | 🔶 | Images kept in the page render/background ✅; image-anchored extraction + caption linkage in phase c |
| 6  | PDF With Tables (simple/complex, merged cells, multi-page) | 🔶→⏳ | Row detection + table blocks ✅ (text representation); pdfplumber cell extraction implemented in the sidecar server (frontend integration pending), merged cells/multi-page ❌ |
| 7  | Academic / Research PDF (footnotes, refs, citations, equations) | 🔶→⏳ | 2-column papers classified `text` ✅; footnote region + heading hierarchy in phase c; equations ❌ (see #23) |
| 8  | Business / Report PDF (reports, invoices, financial) | 🔶 | Paragraph/table extraction ✅; invoice form layout understanding ❌ |
| 9  | Forms / Structured PDF (fillable, checkboxes, signatures) | 🔶 | Field detection/counted in probe ✅, password-style unlock flow ✅; translating labels in phase c; form filling ❌ (out of scope) |
| 10 | Presentation PDF (slides, big headings, text boxes) | 🔶→⏳ | Size-spread/complexity signal ✅; per-slide text-box reading order in phase c |
| 11 | Book / Document PDF (chapters, TOC, headers/footers, page numbers, long docs) | 🔶→⏳ | Header/footer bands, page labels, running heads ✅; long-document chunked translation ✅; footnote region phase c |
| 12 | Magazine / Brochure (complex layouts, multi-column, text around images) | 🔶→⏳ | `complex` classification ✅ (columns, overlap, size spread); structure repair in phase c |
| 13 | Technical PDF (manuals, code snippets, diagrams) | 🔶 | Extracts as text ✅; code formatting preservation ❌ (phase c) |
| 14 | Legal PDF (contracts, numbered sections, footnotes) | 🔶→⏳ | Numbered-section/list handling ✅; footnote region phase c |
| 15 | Password-Protected / Encrypted PDF | ✅     | Wizard password prompt, wrong-password explanation, unlocked pre-flight; graceful unsupported-encryption errors; fixture-tested (RC4) |
| 16 | Large PDF (hundreds/thousands of pages) | ✅     | 300-page fixture: worker-side probe/parse, main thread stays responsive, resumable queue, progress UI, chunked translation |
| 17 | Unicode / Multilingual (Burmese, CJK, Arabic, Devanagari, Cyrillic) | 🔶→⏳ | Language detection + Zawgyi/Unicode handling ✅, Myanmar rendering ✅; OCR validated for English end-to-end, other scripts need their tesseract traineddata (mya available, untested) |
| 18 | RTL PDF (Arabic, Hebrew, mixed) | 🔶     | RTL line ordering in grouping ✅; bidi/visual-order edge cases ❌ |
| 19 | PDF With Annotations (comments, highlights, stamps, links) | 🔶→⏳ | Annotation/link counting in probe ✅; links preserved as clickable text in exports phase c |
| 20 | Damaged / Invalid PDF | 🔶     | Load/probe failures surface as actionable errors ✅; partial repair ❌ |
| 21 | PDF With Embedded Fonts (subset/custom/fallback) | ✅     | Font inventory (embedded/standard/other) in metadata ✅, subset-prefix cleaning ✅, Myanmar fallback stack in export ✅ |
| 22 | PDF With Complex Layout (text boxes, overlap, sidebars, watermarks) | ⏳→✅   | `complex` class + scoring ✅ (this phase); extraction-side structure repair phase c |
| 23 | PDF With Equations / Math content | ❌     | Formulas extract as plain text (lossy); LaTeX/OCR-of-equations not implemented |
| 24 | PDF With Code (syntax, monospace, formatting) | 🔶→⏳ | Monospace font extracted as style ✅; block-level code formatting phase c |
| 25 | PDF With Hyperlinks (external, internal, TOC, cross-references) | 🔶→⏳ | Link annotations counted ✅; URL text preserved as text ✅; clickable links phase c |

## Phase roadmap for this matrix

| Phase | Delivers | Moves types |
| ----- | -------- | ----------- |
| (a) Classification | `complex` class, complexity scoring, item-level column detection, wizard metadata | 4, 12, 22 classification ✅ |
| (b) Extraction methods | Browser Tesseract OCR auto-runs per window (status lifecycle, confidence, cached recognition), hybrid merge with geometric dedup, run-OCR setting persisted per project, Python sidecar server (protocol v1, 20 tests) | 2, 3 extraction ✅ |
| (b2) Sidecar wiring | `src/sidecar/sidecarClient.ts`: cached `GET /health` probe, `POST /ocr` with page/language/password, per-line confidence added to the server response, lazy render so a sidecar page never rasterises in the browser, automatic fall-back to browser Tesseract on any failure (22 client + 5 pipeline + 1 Python test) | 2 extraction ✅ with a native-OCR fast path |
| (c) Structure preservation | Reading-order repair across merged columns, footnote regions, real table cells, links, code blocks, headings | 4, 5, 6, 7, 9, 11, 13, 14, 19, 24, 25 |
| (d) Layout auto-adjust | Auto-fit/reflow when translated text grows (EN→MY), export height handling | 1, 8, 10, 12 (translation-time layout) |

_Known limitations carried over: table cell truncation at 45k characters,
style reset on re-parse, no equation rendering (type 23)._
