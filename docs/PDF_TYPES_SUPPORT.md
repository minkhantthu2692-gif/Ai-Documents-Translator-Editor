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
| `scanned`| Page is images only (no usable text layer)           | OCR (⏳ phase b)        |
| `mixed`  | Text layer **and** images on one page                | Hybrid (⏳ phase b)     |
| `complex`| Text layer present, but layout breaks reading order  | Text extraction, careful structure handling |
| `empty`  | Nothing on the page                                  | Nothing to translate    |

Complex-layout signals (scored in `src/pdf/layoutComplexity.ts`): ≥3 text
columns, overlapping text boxes (sidebars/watermarks), rotated text or page,
table-like rows, slide-like font-size spread, image-heavy pages. Column
detection runs on the **raw text runs** (item boxes), so it survives line
clustering merging columns together.

Optional **Python sidecar** (`sidecar/`, ⏳ this phase): PyMuPDF +
pdfplumber (+ Tesseract OCR) behind a local HTTP service for stronger
extraction/OCR/tables when available; the browser path remains the default
and everything degrades gracefully without it.

## The 25 types

| #  | Type                                    | Status | Notes |
| -- | --------------------------------------- | ------ | ----- |
| 1  | Text-Based PDF                          | ✅     | Text layer → lines → blocks with headings, lists, styles, fonts, special characters; classified `text` |
| 2  | Scanned PDF (image-only, rotated, low-res, OCR) | ⏳ | Classification `scanned` ✅ today (pre-flight warns + offers OCR); OCR execution lands in phase b (browser Tesseract + sidecar), rotation/low-res handled by OSD |
| 3  | Mixed PDF (text + scanned pages/images) | 🔶→⏳  | Per-page classes `mixed`/`scanned` ✅; per-page method selection (text vs OCR vs hybrid) in phase b |
| 4  | Multi-Column PDF (2/3-col, newspaper, reading order) | 🔶→⏳ | `complex` classification for ≥3 columns ✅ (item-level gutter detection); reading-order restructure of merged column lines in phase c |
| 5  | PDF With Images (captions, diagrams, charts) | 🔶 | Images kept in the page render/background ✅; image-anchored extraction + caption linkage in phase c |
| 6  | PDF With Tables (simple/complex, merged cells, multi-page) | 🔶→⏳ | Row detection + table blocks ✅ (text representation); real cell geometry via pdfplumber in the sidecar (phase b/c); merged cells/multi-page ❌ |
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
| 17 | Unicode / Multilingual (Burmese, CJK, Arabic, Devanagari, Cyrillic) | 🔶→⏳ | Language detection + Zawgyi/Unicode handling ✅, Myanmar rendering ✅; per-script extraction validation phase c/b |
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
| (b) Extraction methods | OCR wiring (browser Tesseract), hybrid image-region OCR, per-page method selection, Python sidecar (classify/extract/ocr endpoints) | 2, 3, 17 extraction |
| (c) Structure preservation | Reading-order repair across merged columns, footnote regions, real table cells, links, code blocks, headings | 4, 5, 6, 7, 9, 11, 13, 14, 19, 24, 25 |
| (d) Layout auto-adjust | Auto-fit/reflow when translated text grows (EN→MY), export height handling | 1, 8, 10, 12 (translation-time layout) |

_Known limitations carried over: table cell truncation at 45k characters,
style reset on re-parse, no equation rendering (type 23)._
