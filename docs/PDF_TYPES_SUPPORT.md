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

`POST /extract` is wired in as well — **as a fallback only**. Measured on the
300-page fixture it answers one 12-page parse window in ~1.3 s where pdf.js
takes ~20 ms (pdfplumber's table finder and the classify-level signal sweep
run on every page), so it is never the first reader. `assemblePage` in
`src/pdf/pdfExtract.ts` is the one tail both engines feed: sidecar lines are
rewritten as pdf.js-shaped text runs and pushed through the same
`groupItemsIntoLines` → `structurePage` → links passes, so reading order,
footnotes, code, tables, headings and link anchors stay single-sourced in
TypeScript rather than being reimplemented in Python. The worker retains the
file bytes only while the health probe says a sidecar is reachable, retries a
page only when pdf.js *threw* or handed over text it could not turn into a
block, and otherwise never calls it — an ordinary document pays nothing. A
page the sidecar cannot answer for is declined by name (`page-rotation`,
`line-rotation`, `pdfplumber-table`, `extraction-method`, …) and the browser's
result stands. Recordings of six fixtures are replayed in
`src/sidecar/extractParity.test.ts` and asserted identical block for block:
same kinds, text, `tableCells`, link anchors and boxes within 3 pt.

## The 25 types

| #  | Type                                    | Status | Notes |
| -- | --------------------------------------- | ------ | ----- |
| 1  | Text-Based PDF                          | ✅     | Text layer → lines → blocks with headings, lists, styles, fonts, special characters; classified `text` |
| 2  | Scanned PDF (image-only, rotated, low-res, OCR) | ✅ | Classification `scanned` + auto-OCR inside the parse window (browser Tesseract: `queued→running→done`, confidence + text blocks persisted, E2E-verified); local sidecar OCR ✅ preferred automatically when running; pre-flight warns and offers OCR; rotated scans still need OSD ❌ |
| 3  | Mixed PDF (text + scanned pages/images) | 🔶 | Per-page classes + method selection ✅ (text / OCR / hybrid): hybrid keeps the text layer authoritative, OCRs the rest and drops blocks that overlap existing text (unit-tested); reading order across merged column lines ✅ |
| 4  | Multi-Column PDF (2/3-col, newspaper, reading order) | ✅     | `complex` classification for ≥3 columns ✅ (item-level gutter detection); reading order ✅ — rows fused across a gutter are cut back into one line per column, columns are read left-to-right (2–4), and a title spanning the fold opens its own zone ahead of both columns |
| 5  | PDF With Images (captions, diagrams, charts) | 🔶→⏳ | Images kept in the page render/background ✅; **image-anchored extraction ✅** — every painted image's rectangle is traced from the operator list, filtered against page furniture and anchored to the block it illustrates as `PageBlock.figures` (see below); **cropped and embedded in DOCX / EPUB / Markdown ✅** (phase 9b, see "How a figure reaches DOCX, EPUB and Markdown") |
| 6  | PDF With Tables (simple/complex, merged cells, multi-page) | 🔶→⏳ | **Real table cells ✅** — a run of rows whose columns align becomes one `kind: 'table'` block carrying `tableCells` (rows × columns) as data, and HTML/EPUB draw a real `<table>`, DOCX a real `w:tbl`, Markdown a pipe table, JSON the grid (see below); table rows are explicitly exempt from the column split so merging cells stay one row; **Merged cells ✅** — a cell drawn across a column boundary becomes `tableSpans` beside the grid, and HTML/EPUB emit `colspan`, DOCX `w:gridSpan` (see below); **multi-page tables ✅** — the row a break orphaned joins the table it was cut from, by a geometry hint read from the page above and a mark read across the document at export (see below), with a cross-window rescue not attempted; and a gutter narrower than one em is not read as a column |
| 7  | Academic / Research PDF (footnotes, refs, citations, equations) | 🔶→⏳ | 2-column papers classified `text` ✅ and read in column order ✅; footnote regions ✅ (see below); heading hierarchy ✅ — every heading carries a 1–6 level from a document-wide ladder (see below); equations ❌ (see #23) |
| 8  | Business / Report PDF (reports, invoices, financial) | 🔶 | Paragraph/table extraction ✅; invoice form layout understanding ❌ |
| 9  | Forms / Structured PDF (fillable, checkboxes, signatures) | ✅ | Field detection/counted in probe ✅, password-style unlock flow ✅, **field labels translated ✅** (a widget's `/TU` and a dropdown's `/Opt` captions become `kind: 'form-field'` blocks — see below); form filling ❌ (out of scope) |
| 10 | Presentation PDF (slides, big headings, text boxes) | ✅ | Size-spread/complexity signal ✅; per-slide text-box reading order ✅ — a wide title above two free-floating text boxes whose lines share baselines comes out title → left box → right box, each box whole, never row-by-row across both boxes (`fixtures/slide.pdf`, `pdfExtract.test.ts`) |
| 11 | Book / Document PDF (chapters, TOC, headers/footers, page numbers, long docs) | 🔶→⏳ | Header/footer bands, page labels, running heads ✅; long-document chunked translation ✅; footnote regions ✅ |
| 12 | Magazine / Brochure (complex layouts, multi-column, text around images) | ✅ | `complex` classification ✅ (columns, overlap, size spread); multi-column reading order ✅; figures anchored to their captions ✅ (same pass as type 5); text-around-image copy ✅ — the lines beside a photo keep their own x origin and land between the full-width paragraphs around them, the flow-around line staying part of the paragraph above the photo, and the photo anchors to a block instead of becoming one (`fixtures/magazine.pdf`, `pdfExtract.test.ts`) |
| 13 | Technical PDF (manuals, code snippets, diagrams) | 🔶→⏳ | Extracts as text ✅; **code blocks** ✅ — detected, kept as `kind: 'code'`, indentation rebuilt from the bounding boxes and rendered as code in every format; **blank lines inside a snippet are not recovered** ❌ — a line with no text has no bounding box to measure, so the gap between two statements closes up in the flow formats |
| 14 | Legal PDF (contracts, numbered sections, footnotes) | 🔶→⏳ | Numbered-section/list handling ✅; footnote regions ✅ — `1.`, `1)`, `1` and `(a)` callouts are recognised, so numbered notes are not read as list items |
| 15 | Password-Protected / Encrypted PDF | ✅     | Wizard password prompt, wrong-password explanation, unlocked pre-flight; graceful unsupported-encryption errors; fixture-tested (RC4) |
| 16 | Large PDF (hundreds/thousands of pages) | ✅     | 300-page fixture: worker-side probe/parse, main thread stays responsive, resumable queue, progress UI, chunked translation |
| 17 | Unicode / Multilingual (Burmese, CJK, Arabic, Devanagari, Cyrillic) | 🔶→⏳ | Language detection + Zawgyi/Unicode handling ✅, Myanmar rendering ✅; OCR validated for English end-to-end, other scripts need their tesseract traineddata (mya available, untested) |
| 18 | RTL PDF (Arabic, Hebrew, mixed) | 🔶     | RTL line ordering in grouping ✅; bidi/visual-order edge cases ❌ |
| 19 | PDF With Annotations (comments, highlights, stamps, links) | 🔶→✅ | Annotation/link counting in probe ✅; `/Annots` `/Link` rectangles now become anchored `<a>` / `[text](url)` / docx `ExternalHyperlink` ✅ (external only — see below); a note's own words — a sticky note's message, the reason a passage was highlighted, a `/FreeText` callout's body, a stamp's legend — become one `kind: 'annotation'` block each ✅ (see below); the annotation's **author** (`/T`) and date (`/M`) stay out of it ❌ — a name is not for translating |
| 20 | Damaged / Invalid PDF | 🔶     | Load/probe failures surface as actionable errors ✅; partial repair ❌ |
| 21 | PDF With Embedded Fonts (subset/custom/fallback) | ✅     | Font inventory (embedded/standard/other) in metadata ✅, subset-prefix cleaning ✅, Myanmar fallback stack in export ✅ |
| 22 | PDF With Complex Layout (text boxes, overlap, sidebars, watermarks) | ⏳→✅   | `complex` class + scoring ✅ (this phase); column/sidebar reading order ✅; text-box + overlap repair in phase c |
| 23 | PDF With Equations / Math content | ❌     | Formulas extract as plain text (lossy); LaTeX/OCR-of-equations not implemented |
| 24 | PDF With Code (syntax, monospace, formatting) | 🔶→⏳ | Monospace face extracted as style ✅; **block-level code formatting** ✅ — a snippet is fenced in Markdown, `<pre>` in EPUB, `Courier New` with real `<w:br/>` in DOCX, and monospace with `white-space: pre-wrap` in HTML/print; **syntax colouring** ❌ — the PDF never hands over which tokens were which colour per glyph, so a snippet is set in one colour like the prose around it |
| 25 | PDF With Hyperlinks (external, internal, TOC, cross-references) | ✅ | External links ✅ — rectangle → words → `LinkRef[]` → anchored output in HTML/EPUB/Markdown/DOCX/JSON; URL text preserved as plain text ✅ in every format; internal `/Dest` links ✅ — resolved through the open document (named destinations via `getDestination`, refs via `getPageIndex`) to a page index and rendered as in-document anchors (`#page-N`) against HTML page sections, EPUB page headings (chapter-aware: a cross-chapter jump prefixes the owning `chap_M.xhtml`) and Markdown page-heading slugs; DOCX prints the words without a hyperlink (Word renders those through bookmarks we do not write) (`fixtures/links-internal.pdf`, direct + named + external on one page) |

## Phase roadmap for this matrix

| Phase | Delivers | Moves types |
| ----- | -------- | ----------- |
| (a) Classification | `complex` class, complexity scoring, item-level column detection, wizard metadata | 4, 12, 22 classification ✅ |
| (b) Extraction methods | Browser Tesseract OCR auto-runs per window (status lifecycle, confidence, cached recognition), hybrid merge with geometric dedup, run-OCR setting persisted per project, Python sidecar server (protocol v1, 20 tests) | 2, 3 extraction ✅ |
| (b2) Sidecar wiring | `src/sidecar/sidecarClient.ts`: cached `GET /health` probe, `POST /ocr` with page/language/password, per-line confidence added to the server response, lazy render so a sidecar page never rasterises in the browser, automatic fall-back to browser Tesseract on any failure (22 client + 5 pipeline + 1 Python test) | 2 extraction ✅ with a native-OCR fast path |
| (c) Structure preservation | **Reading order ✅** — `src/pdf/readingOrder.ts` cuts rows fused across a column gutter back into one line per column, orders 2–4 columns left to right, and gives a title that spans the fold its own zone ahead of both columns. `fixtures/complex.pdf` (3 columns + rotated watermark) now reads col 1 → col 2 → col 3 → watermark end-to-end. **Footnote regions ✅** — `src/pdf/footnotes.ts` marks them before any merging happens. **Heading hierarchy ✅** — `src/pdf/headings.ts` builds one document-wide ladder of heading font sizes during the probe and every page levels its headings against it; exporters render `h1`–`h6`, `HeadingLevel.HEADING_1–6` and ATX hashes. **Links ✅** — `src/pdf/links.ts` turns every `/Link` rectangle — external URI or internal `/Dest` — into the words it covers, and every exporter renders them as a real anchor: an absolute URL where the PDF had one, the in-document `#page-N` where it had a destination (see below). **Code blocks ✅** — `src/pdf/codeBlocks.ts` calls a run of lines code when two independent readings agree: a monospaced face *and* statement punctuation; a monospaced face *and* nesting (which is what catches YAML and JSON, whose lines carry no punctuation to score); or punctuation alone across several lines with a brace somewhere. `structure.ts` gives it `kind: 'code'`, stamps `skipRule: 'code'` so the model never rewrites a program, and hands the indentation back — see below. **Table cells ✅** — `src/pdf/rowSplit.ts` reads a run of rows whose columns align as one `kind: 'table'` block with `tableCells` as data, and every format draws a real grid rather than tab-separated text — see below. **Merged cells ✅** — the same file reads a cell drawn across a column boundary as a span (`tableSpans`), and HTML/EPUB emit `colspan` and DOCX `w:gridSpan` for it, on a printed grid of the shape the span was measured on — see below. **Multi-page tables ✅** — a row the break orphaned rejoins the table it was cut from, by a `{width, left}` hint from the page above during extraction and a mark across the whole document at export, and every format that keeps tables emits one — see below. **Figures ✅** — `src/pdf/imageOps.ts` rebuilds every painted image's rectangle from the operator list and `src/pdf/figures.ts` decides which of them are figures and which paragraph owns each one, recorded as `PageBlock.figures` — see below. **Form labels ✅** — `src/pdf/formFields.ts` reads the text a widget carries that the page never prints (its `/TU` tooltip and a choice field's `/Opt` captions) and makes one `kind: 'form-field'` block per described widget, hanging directly under its own box, so it reaches the model, the editor and every exporter like any other block — see below. **Annotation notes ✅** — `src/pdf/annotations.ts` reads the text an annotation carries that the page never prints (a sticky note's `/Contents`, the reason a passage was highlighted, a `/FreeText` callout's body, a stamp's legend) and makes one `kind: 'annotation'` block per note, filed directly under the passage it marks — see below. Remaining in this phase: nothing | 4 ✅, reading order for 3 / 7 / 12 ✅, footnotes for 7 / 11 / 14 ✅, heading hierarchy for 7 ✅, links for 19 / 25 ✅, code blocks for 13 / 24 ✅, table cells for 6 ✅, figures for 5 / 12 ✅, form labels for 9 ✅, annotation notes for 19 ✅ |
| (d) Layout auto-adjust | **Translation-time auto-fit ✅** — `src/editor/layout.ts` re-measures a block the moment a translation lands and takes the largest size in `[6pt, originalFontSize]` whose wrapped text still fits the original bbox; never a size the reader pinned, and never below the floor — an unfittable block keeps the document's own size and is flagged rather than shrunk into illegibility. Runs on the bulk queue, on inline re-apply and on accept-suggestion, never on a person typing; `layout.autoFit` in Settings → General turns it off. **Reflow ✅** — `src/export/reflow.ts` pushes the blocks under one that outgrew its box down by exactly the growth, within their own column, stopping at the page edge; HTML emits `min-height` where it emitted `height`, so a box is a floor the translation may grow into | 1, 8, 10, 12 ✅ (translation-time layout + the absolute HTML/print export) |

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

### Why a table has to be read geometrically

`groupItemsIntoLines` collapses every whitespace run to a single space and
trims, because that is what prose needs. The cost is that the *layout* — which
is the only thing separating a cell from a word — is gone by the time
`structure.ts` sees a line. The original row detector split `line.text` on
`/\s{2,}|\t/`, so it could not match a real PDF at all: it had been firing only
on lines a test built by hand. `src/pdf/rowSplit.ts` now answers two different
questions two different ways.

**"Is this run of lines a table?"** (`tableForLines`) is asked once a block
exists, and read off geometry. pdf.js emits one text item per show-text
operator, so each cell arrives as its own run at its own x, and a gap of a
full em between two runs on a shared baseline cannot be a word space — no face
sets one that wide (0.2–0.5 em proportional, exactly 0.5 em monospaced).
Cut positions are then clustered and a cut only becomes a column when most of
the rows agree on it, because a table is *aligned* columns: one row's long
word space is not a column. Rows that carry no geometry at all (hand-built
fixtures, OCR) fall back to agreeing on a column count. A row has to come out
at least half filled, which is what keeps a wide-gapped line of prose that
happened to sit beside a table from being read as a row of it.

**"Must reading order leave this line whole?"** (`looksLikeTableRow`) is asked
of a single line, before any block exists, and is the harder of the two. A row
fused across a column gutter and a genuine two-cell row have the same runs,
the same gaps and the same baselines — the two fixtures that pin `cutAtBands`
cannot be told apart by gap (28pt against 26pt) or by run count (two against
three), because they were written to differ only in the whitespace of their
text. What separates them in a real document is the *width* of the runs: a
cell is a label or a figure, a column's run is a span of prose. So the guard
accepts the whole-line whitespace form (what a fixture or an OCR line has) or,
when there is none, geometry restricted to runs narrower than eight ems. Get
that wrong in the generous direction and columns stop being cut apart, which
costs types 3, 7 and 12; get it wrong in the strict direction and a real table
flattens into one paragraph per column.

`fixtures/table.pdf` is the end of this: two pages whose cells are each their
own positioned show-text operator — the shape a document processor writes —
one row leaving a middle cell empty, and a paragraph on either side that has
to stay a paragraph. Neither page can be reached by a test that constructs a
line by hand.

### Why a merged cell rides beside the grid, not inside it

PDF content streams have no "this cell spans two columns" operator. A document
processor draws the merge as one show-text run that starts inside the column it
belongs to and runs past the next one's left edge, and geometry is the only
witness — so `spansOf` reads exactly that: a run crossing a column boundary
claims the boundary for the cell that starts it, and the covered column is left
holding nothing. `fixtures/table-spans.pdf` is the fixture, and it is honest
about what the file does *not* say: no operator anywhere records the merge.

The encoding sits **beside** the cells rather than in them. A merged cell holds
the number of columns it covers, the cells it covers hold `0`, an ordinary cell
holds `1`, and the merged cell's text stays in the column it was drawn in. The
row stays exactly as wide as it was, which is not cosmetic: `text` is built from
that same rectangle — the model reads ` \t ` between cells and the translation
cache keys on the exact string — so a table that gains a merge is byte-identical
to the table it was before, for the model and for the cache alike.

One refusal is per **row**, and costs the table nothing: the row is drawn flat —
every cell its own column, which is the reading it had before spans existed —
while the rows beside it keep their merges. It fires when a merge would cover a
column another run **on the same row** already sits in, or when two merges claim
one column: either way that is two texts in one cell, and run widths alone
cannot see the first of them, because a run whose *advance* reaches past a
boundary while the cell beginning exactly there is drawn beside it is just as
likely to be a trailing space in the width or a highlight laid over the words.

Two refusals are per **table**, because each says the whole block is not one:

- more than half the rows merged. Rows that mostly cross their own boundaries
  are prose whose sentences happen to span the reader's columns, which is the
  one shape this detector exists to refuse;
- the fill rule, which was already there: every row has to be at least half
  filled, and now counts a merge for the columns it covers. The weighting is
  what keeps that rule usable — a header written across two of three columns
  holds one cell out of three, and on an unweighted count it would be read as
  the line of prose beside the table.

There are no vertical merges. `LineRun` is a rectangle on a single baseline, so
nothing here can tell a cell two rows tall from two cells of the same width, and
a guess in that direction would drop a row out of the table.

`tableSpans` travels beside `tableCells` (page block → block row → export block)
and a renderer applies it only to a printed grid of the shape it was measured
on, through `tableSpansFor`. The grid a renderer draws comes from
`printedText`, which the model wrote, and it may have a different number of
columns than it was given: HTML and EPUB emit `colspan`, DOCX `w:gridSpan`, JSON
the spans themselves, while Markdown — which has no merge in its grammar — prints
the covered cell empty so the row keeps its columns. When the printed shape has
moved, the table is drawn flat: a table without its merges is still a table.

Reading order is the gate in front of all of this. It cuts a line at a column
gutter whenever a run is wider than eight ems, because that is how it tells a
cell from a span of prose, so a merged header *past* eight ems is cut in two
before the table detector ever sees it and the table falls back to a paragraph.
Short merges (`Total`, `First half 2026`) reach the detector; long ones do not,
and that is a limit of the guard rather than of the spans.

### Why a table cut by a page break stays one table

A table that runs off the foot of a page arrives as two halves, and each half
can be lost on its own. Page *n* ends with the table still running; page
*n+1* opens with the orphaned row — often a **single** line, which is exactly
the shape `tableForLines` refuses by rule (a table is a run of at least two
lines), so without help it degrades to the paragraph it looks like
(`West 200 210`). And even when the orphaned row *does* read as a table, the
formats disagree about what to do with it: Markdown promotes it to a header it
does not have, DOCX emits a second `w:tbl` that butts up against the first and
shows a seam where the page broke.

Two readings fix it, each answering the half the other cannot. **The hint**
(`continuationHintFor` in `pdfExtract.ts`) is read from the other side of the
break: the last body block of the page just parsed — a table at least two
cells wide whose bottom sits past 55% of the page height, so a table that
stopped in the top third with the sheet blank below it does not speak for the
next page's row. It carries that table's `{width, left}` into the next page's
options, where `tableForLines` consults it **only after ordinary detection has
already failed**, and only when every line splits into exactly that many cells
of its own, every run is cell-sized (≤8 ems) and the first run's x sits within
`max(4, 0.5em)` of the recorded left edge. One line proves no merge, so such a
block gets `spans: null`, and the hint is offered only to the page's first
*body* block — a running head printed above the row is not content between
the halves. `fixtures/table-continued.pdf` is the fixture: one row at the top
of page two and three prose lines below it that must stay prose.

**The mark** (`markTableContinuations` in `collect.ts`) is read from the whole
document, at export — the one moment every page is in order at once, however
far ahead the reader scrolled. It asks whether the previous page *ends* with a
table past the middle, this page *begins* with one, the two agree on a column
count, and the pages are neighbours (an export of a page range whose
neighbour was left out has nothing to continue from). The column count is the
whole of the discrimination: it separates "the rest of this table" from
"another table happens to start here", the one false positive the shape of the
evidence leaves open. A missed mark costs exactly what every format did
before it — two tables where the page broke one — and a wrong one would put
another table's rows under this table's header, which is why every guard is
about the *shape* of the join rather than a guess about the document.

Where formats keep tables, the marked halves are then joined: DOCX buffers the
open table's rows and appends the next page's — one `w:tbl`, the page break
spent on the join (Word paginates a table taller than a page itself, and a
break after it would push the rest of the document a page further on than the
source had it), the `Page N` marker printed *after* the joined rows because a
heading cannot sit inside a table. Markdown appends the rows to the part that
already has its header — no promotion — padding a short row rather than
cutting cells, and keeps the quoted source rows in the quoted half. JSON
carries `tableContinuation` beside the grid. HTML, EPUB, plain text and the
delimited formats already build tables row by row with no page in sight, so
nothing there changes.

Two edges stay open. The hint travels within a parse window only: a
continuation that first appears in another window is not rescued back. And
two tables of the same width either side of a break are indistinguishable
from one — the join then lands, mild in every format (rows together, one
header fewer).

### Why a snippet's indentation has to be measured back

`groupItemsIntoLines` collapses whitespace and trims every line, because prose
does not care where a word began and the spacing pdf.js reports is full of
incidental gaps. That is the right call for a paragraph and the wrong one for
code, where the leading columns *are* the structure — so by the time
`structurePage` sees a line, its indentation has gone from the string and lives
only in the bounding box.

The geometry is enough. In a monospaced face every glyph takes the same advance
width, so `bbox.w` divided by the character count *is* that width, and
`round((line.bbox.x − blockLeft) / charWidth)` is how many columns the line was
stepped right by. `codeBlockText` writes them back as spaces. `links.ts` already
makes the same "exact for monospaced, approximate for proportional" trade in
the other direction, and it is the right way round to fail: a line lands a
column off rather than at the margin.

Two rules had to move for a snippet to survive that far. `canMerge` refused to
join two lines whose left edges differed by more than half a character — less
than a single indent step — so every nested snippet arrived as one block per
nesting level; it now widens that tolerance when *both* lines are monospaced,
which is safe because reading order has already cut a two-column page apart.
And a line ending in `;` read as the end of a sentence, which parted one
statement from the next; code lines are exempt.

### Why one fused row could still collapse a whole page

`fixtures/complex.pdf` — three columns plus a rotated watermark — is the
fixture that found this. Its rows arrive fused across *both* gutters, and
`splitMergedLines` cuts them back apart using the empty bands a sweep over the
run boxes finds. Those bands were reconstructed as `centre ± width / 2`, which
round-trips through floating point and can land one unit in the last place
short of the real edge. The *widest* row is precisely the row that defines that
edge, so its own gap starts exactly on it — and a hair short is enough for the
cut test to refuse. That row then survives half cut, leaving columns two and
three fused for the last line of the page, and one line reaching across a
gutter is enough to send everything to its right back to row-by-row order. The
sweep now reports the raw event coordinates instead.

Two more defences came out of the same fixture:

- **A sub-group that still contains a spanning line cuts zones instead of
  giving up.** `orderColumns` fell back to plain order for the *entire*
  sub-group, so one line reaching across a gutter interleaved every column it
  sat beside. It now treats that line the way the page treats a title — a
  boundary, with each zone ordered on its own. The split budget is deliberately
  not spent on a zone cut: a boundary is removed from every segment it
  produces, so each recursive call sees a strictly smaller set and terminates
  on its own, while charging for it would exhaust the budget on a title and
  leave the real columns unordered.
- **Zone boundaries are found against every gutter, not only the band the
  current level chose.** A watermark lying across the left fold has its centre
  inside the left cluster, so `findBand` reports it as an ordinary member of
  that side — and ordering the cluster by `y` then drops it between column two
  and column three, splitting the body of the page in half. `zoneBoundaries`
  sweeps every detected gutter for lines that bridge it, using an overlap of at
  least `EDGE_EPSILON`: a part's box is rounded to two decimals, so a column
  line ending flush with the band can appear to poke a hundredth of a point
  into it, and a hundredth is not a bridge.

Each of the three fails a test when reverted: the exact edges by
`complex.pdf`, the sub-group zone cut by `cuts a zone inside a sub-group …`,
and the page-wide sweep by both that fixture and `keeps the columns whole when
a line bridges only one gutter`.

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

### Why a heading's level is decided by the whole document

`structurePage` only has to answer *is this a heading?* — larger than the page's
body median and short enough to be a title. *How deep* it is cannot be answered
from the page in front of it, because the headings that give it meaning are on
other pages: a chapter title appears once, and every page after it carries only
the sections beneath it. Rank a single page and `3.2 Methods` becomes a level-1
heading on the pages where its chapter is not present.

The ladder is therefore built where all the pages are in hand — `headingTiers`
runs over the probe's line list and returns the document's heading font sizes
largest first — and travels down the same channel running heads and feet
already use: `ProbeSummary.headingSizes` → `ProjectAnalysis.headingSizes` → the
`extract` request → `StructureOptions.headingSizes`. Two sizes agreeing to
within 5% are one level (a converter hands back 14.0 on one page and 14.2 on the
next, and a level spent on the difference pushes every real level below it down
one); at most six rungs are kept, because six is as deep as HTML, docx and
Markdown go.

A page with no ladder ranks its own headings instead. That is not only the
fallback for a project probed before the field existed — it is what OCR pages
always do, deliberately: tesseract reports the *line box* rather than the type
size, so OCR sizes run larger than the text layer's and mapping them onto the
document's absolute rungs would lift every scanned heading. The consequence is
that a hybrid page's two halves can differ by one level; each half is
consistent with itself.

The exported level is never printed raw. `headingOffset(block, levelsAbove)`
shifts it past whatever structural headings the builder already emits — the
`#` title, an optional `## Page N`, an EPUB chapter's `<h2>` — so a document
heading can never land on the same level as one of them, and clamps at six
afterwards. The tag change is otherwise **invisible**: HTML gives `.block`
`margin: 0; font-weight: inherit`, so `<h3>` renders like the `<div>` it
replaces and the printed page does not move by a point. In a bilingual export
exactly one paragraph per block takes the level, and it is the translation's —
a navigation pane should name what the document became, not repeat the text the
reader already had. Blocks parsed before this change carry `kind: 'heading'`
with no level and export as ordinary paragraphs until the page is re-parsed.

### Why a link's anchor has to be rebuilt from geometry

A PDF `/Link` annotation carries a **rectangle and a destination**, never the
words inside it. The text on that line came from `getTextContent()` and is
completely unaware an annotation sits over it, so nothing links unless the two
are put back together — and the rectangle says only *where*, not *which*.
`linkAnchors` therefore takes the rect's top-left corner, finds every line it
covers, and re-locates the runs underneath it by walking `indexOf(item.str,
cursor)` across the line's items in order. That recovers the run the annotation
began in and the run it ended in; what it does **not** recover is where inside
those runs the rectangle started, because pdf.js emits one item per `Tj` and a
whole 40-glyph line is a single item. The slice is narrowed proportionally
across the run's width instead — exact in Courier, approximate in a proportional
face, and always a substring of the line, which is the property every exporter
depends on. One anchor per line: an anchor that straddled the line break would
put a URL inside a newline.

Two rules keep the result honest. The destination goes through `safeLinkUrl`
before anything else happens — an allow-list of `http`, `https`, `mailto`, `ftp`
and `tel` compared as `scheme + ':'`, so `javascript:` and `data:` never reach a
browser no matter what a hostile PDF asked for, and a scheme-less
`www.example.com/...` is promoted to `https://`. That is the only guard between
the file and the exported HTML. An internal `/Dest` link has no URL to guard: it
is resolved against the open document instead — `resolveDestination` maps a name
through `getDestination` and a ref through `getPageIndex` to a 0-based page
index, bounded to 32 destinations per page and answering `null` (no link) for
every name nothing defines — and rendered as the in-document anchor `#page-N`
that every page section (`id="page-N"` in HTML) and page heading carries
(`<h2 id="page-N">` in EPUB, the `## Page N` slug in Markdown). EPUB chapters
are separate files, so a jump across a chapter boundary is prefixed with the
owning `chap_M.xhtml`. DOCX prints the words without a hyperlink: Word renders
such jumps through bookmarks this exporter does not write, and a hash "target"
would open as a broken external link instead.

Attachment is geometric too: `attachLinks` puts each anchor on the block whose
rectangle contains the rect's centre, or failing that overlaps it most while
covering at least 30% of its area — so a link at the end of a paragraph lands on
the paragraph, not on whichever line happened to be nearest. The rectangle is
deliberately tight (13pt around 10pt type): a generous one reaches onto the
neighbouring line and attaches the same URL twice.

What survives translation is the **words**, not the geometry, so the exporters
re-locate the anchor rather than reposition it. `linkSegments(text, links)`
offers each link's source text first and its URL as a fallback — the URL is the
one thing a translation usually leaves alone — takes the leftmost match, fires
each link once and never nests two anchors, so `[text](url)` cannot swallow a
neighbour. When neither is found the text is emitted unchanged, which is why a
block with no surviving anchor still exports correctly instead of dropping
content. An internal link offers its **words only**: `#page-N` is built by us,
never printed in the source, so searching for it would fire the link on
whatever `#page-3` happens to appear in the prose.

_Links carry these caveats: anchors only survive if the model keeps the words
or the URL; a page converted to Zawgyi before parsing reports different bytes
than the annotation was cut from, so its anchors are missed; DOCX uses an
explicit `0563C1` underline rather than the `Hyperlink` style, which exists only
inside Word's own stylesheet; an internal jump whose target page falls outside
a page-range export lands on an anchor the trimmed file no longer has._

### Why a figure has to be anchored to text

An image operator carries an **object id, not a rectangle**. The rectangle is
whatever the current transformation matrix makes of the unit square at the
moment `/Im1 Do` is executed, so the only way to know where a picture sits is to
walk the operator list the way the renderer does — `save`, `transform`,
`paint`, `restore`, keeping a stack of matrices and composing each `cm` with the
newest transform on the left, which is the spec's `CTM' = M × CTM`. pdf.js
publishes no API for any of this; `getOperatorList()` is the only place a page's
graphics are handed over, which is why `src/pdf/imageOps.ts` exists at all. The
boxes that come out are clipped to the sheet and rounded to 2 dp in the same
top-left page space every block bbox already uses, so a figure and the paragraph
beside it are measured with the same ruler. Form XObjects get their own frame on
the same stack, fused `repeat` and mask-group operators yield one box per tile,
and `paintSolidColorImageMask` is skipped — pdf.js also uses it to render stroked
text, so honouring it would turn every such page into a wall of pictures.

Once the rectangles exist, the question is **which paragraph a picture belongs
to**, and the answer cannot be "make it a block": a figure has no words for the
model to translate, so a block of its own would hand it something it cannot
change while splitting the paragraph it sits next to. `src/pdf/figures.ts`
therefore records each figure on the block it illustrates, as
`PageBlock.figures: FigureRef[]` — geometry only, never pixels, which keeps a
block row small enough to round-trip through IndexedDB and the sync sheet.

Two filters decide what counts as a figure at all, and both are about telling a
picture apart from page furniture. **Size**: thinner than 8pt in either direction
is a rule or a bar, smaller than 600pt² is a dot or an icon nobody labels, and
larger than 60% of the sheet is the page itself — a wash or a scan rather than
something on it. A rectangle whose centre falls in the top or bottom 10% band is
a running head or foot, which is what stops a letterhead logo being injected
halfway down a flow export. **Coverage**: when body type sits on more than 70% of
the rectangle, the picture is *behind* the page's text rather than next to it —
a background texture drops, while a photo with one headline over it survives.

Pairing is staged rather than scored, so a failure is always gentle (the figure
is dropped, and HTML/PDF still show it as page art). A caption is looked for
first — a line matching `Figure 1.`, `Fig. 2`, `Plate IV` and similar, *numbered*
so that "Diagram of the process" cannot be mistaken for a label — directly below
the picture within four times the caption's own font size, then directly above.
Only if there is no such caption does proximity take over: the nearest body block
below within half the page height, then the nearest above, each required to share
at least a third of a column with the picture. `mixed.pdf`'s running head reads
`Figure 1 - Deployment pipeline` and matches that pattern as happily as any real
caption does; it loses because it is four hundred points away, and that distance
rather than the name is what decided. The pass resets `figures` first, exactly as
`attachLinks` does, so running it twice changes nothing, and each block carries at
most twelve figures — a tiled pattern would otherwise pile every tile onto one
paragraph and hand an exporter a hundred pictures for one caption.

The local sidecar has no operator list to walk, so a recovered page would come
back with a caption naming a picture nothing is attached to. `recoverWithSidecar`
therefore reads pdf.js's `getOperatorList()` for the placements even though the
*text* came from PyMuPDF, feeding both engines the same geometry — and
`extractParity.test.ts` compares `figures` block for block because of it.

_Figures carry these caveats: a label the PDF draws itself as vector art or text
is not carried into a cropped image (the background render inpaints text boxes,
which is what keeps translated and source words from doubling up), while a label
burned into the raster survives because it is part of the pixels; a figure whose
only neighbour is more than half a page away is dropped rather than guessed at;
and a figure anchored to ordinary prose has no words of its own, so its alt text
is empty._

### How a figure reaches DOCX, EPUB and Markdown

Phase 9a stopped at boxes on purpose: pixels in a block row would not survive
IndexedDB or the sync sheet, and a figure is content the moment it is *placed*,
not the moment it is *found*. Phase 9b is the other half — the three formats
that could not show a picture at all now crop one and embed it, and they all
crop from exactly the same source.

**The crop comes from the page render, not from the image object.** An image
operator names a PDF object and the renderer paints it, but a picture on a real
page is usually composited: a mask here, a colour wash there, a form XObject
wrapping it. Rebuilding that would mean reimplementing the renderer. So the
figure rectangles from 9a are cut out of the finished **background render** —
the same `renderPageImages({ mode: 'background' })` asset the HTML and PDF
exports already put behind their text. One code path, and a picture looks the
same in a DOCX as it did in the browser preview. The cut happens inside
`renderPage` (`cutOut` in `src/pdf/pageRender.ts`), right after the render and
before the page blob is encoded, so the analysis worker never hands whole pages
across the worker boundary just to throw them away.

**Only figure-bearing pages are rendered.** `renderFigureCrops`
(`src/export/figureCrops.ts`) groups the document's figures by page and asks
for one render per page that has any. A 300-page report with four diagrams
costs four raster passes, not three hundred — which is the difference between a
figure export that finishes and one that does not.

**PNG, not WebP.** `docx` stores images by MIME type and its `ImageRun` accepts
only `jpg|png|gif|bmp`; EPUB readers are still uneven about WebP. The page
itself stays WebP because it is by far the larger asset.

**The three builders agree on identity, size and side.** `src/export/figureArt.ts`
is the shared vocabulary: `figureKey(blockId, index)` names a crop the same way
in the renderer and in the builder, `figureSize` gives a picture the printed size
it had on the page (a PDF point is 96/72 of a CSS pixel, which is what both DOCX
and CSS measure in) and shrinks only an over-wide one, proportionally, and
`figureGoesBefore` decides which side of its block a figure goes on by comparing
midpoints — so a picture painted *above* its caption still appears above it,
while one painted below the paragraph it was paired with stays below. EPUB
declares every crop in the package manifest under `OEBPS/images/figure-N.png`
(an `<img>` whose target is missing from the manifest does not open in every
reader), DOCX packs it into `word/media` with the caption as its accessibility
description, and Markdown inlines it as a data URI because Markdown has no asset
folder.

**`includeImages: false` turns all of it off**, and `figureRequirement` in
`src/export/runExport.ts` decides which formats pay for any of this: exactly
`docx`, `epub` and `markdown`. HTML, PDF, bilingual PDF, the raster PDF and the
image pack already carry the whole rendered page behind their text, so the
figures are visible there and cropping them would only duplicate them; JSON
carries the geometry and `text`/`csv`/`tsv` are not documents._

### Why a form label is a block of its own

A fillable PDF puts its instructions in two places. The words you can **see** —
`Full Name:`, `Country:` — are ordinary content-stream text; they come through
the normal line → block path with nothing done to them, and were never at risk.
The words you cannot see live on the widget itself, and no other pass in the
pipeline can reach them:

- `/TU`, the alternate field name, is what a screen reader announces and what a
  tooltip shows;
- `/Opt`, a choice field's option captions are what a reader picks from, and they
  are printed nowhere at all — you cannot open a dropdown in a PDF, so that list
  is invisible until somebody extracts it.

`src/pdf/formFields.ts` reads both off the annotations pdf.js already hands
`assemblePage` and makes **one `kind: 'form-field'` block per described widget**.
Because it is an ordinary block it needs no second translation path, no editor
panel and no per-format code: it enters the queue like any other text, it is
editable in the workspace, `json` emits its `kind` and its text, and every builder
that renders a paragraph renders it.

- **Nothing invisible prints by accident, and nothing printed is rewritten.**
  Field labels are attached *after* links and figures, so a `/Link` never wraps a
  tooltip and no figure is re-paired against one. The printed blocks keep their
  text, their anchors and their geometry; only their `order` index moves to make
  room.
- **It hangs under its own box, not inside it.** A widget is an empty rectangle,
  and a 12 pt checkbox is narrower than the caption already printed beside it —
  printing *into* the box would strike through the label rather than describe the
  field. The box grows right and down to hold every line, so a dropdown's four
  captions are not squeezed into a 16 pt rectangle, and it moves above the widget
  when the page has no room left below it.
- **It is italic and grey in every format**, so a reader can tell a description
  from the label printed above it instead of seeing what looks like a clumsy
  duplicate of it.
- **It obeys the same rules as printed text.** `classifyLine` and
  `tokenizePlaceholders` run on it, so a `/TU` that is already Burmese, an
  e-mail address or a formula is skipped exactly as it would have been if it had
  been printed on the page.
- **A widget with nothing to say contributes nothing**: a bare push button, a
  hidden field (`/F` hidden), a text box that was never described, and a radio kid
  whose label lives on its parent group.

Two limits worth stating. pdf.js returns *widget* annotations only, so a radio
group's own `/TU` — which sits on the parent field — never reaches this pass; the
form's author printed the option captions on the page instead, which is what forms
do anyway. And a description is wider than the row it belongs to whenever the
option list is long: in the absolutely-positioned HTML and print exports that
reaches the row below and is reported as `overflow`, exactly like any other block
whose text grew. The flowing layouts (DOCX, EPUB, Markdown, reflow HTML) have no
fixed rows and are unaffected.

`fixtures/form.pdf` (generated by `scripts/make-fixtures.mjs`) carries a text
field, a date field, a combo box with four options, a checkbox, a hidden field, a
two-option radio group, a push button and a signature across two pages — ten
widgets the probe counts, six blocks that come out.

### Why an annotation's note is a block of its own

A reviewed PDF keeps its marginalia in the annotation dictionary rather than in
the content stream. The words you can **see** — a heading, a paragraph, a table
cell — are show-text operators; they were never at risk. The words an annotation
carries are not operators at all:

- `/Contents` is the note itself: a sticky note's message, the reason a passage
  was highlighted, what the reviewer wrote on the callout;
- a `/FreeText` callout's body is drawn by its *appearance* stream, so a reader
  that only walks operators sees an empty box where the text was;
- a stamp's legend is written the same way.

`src/pdf/annotations.ts` reads all three off the annotations pdf.js already hands
`assemblePage` and makes **one `kind: 'annotation'` block per note**. It runs
**last of all** — after links, figures and field labels — because a note is
*about* a block: it has to be handed the finished list to find it.

- **It is filed under the passage it marks.** A highlight's rectangle lies
  straight over the words it annotates, so the note goes immediately *after* that
  block, at that block's own depth — filed by position instead it would land
  between two lines of the very paragraph it is about, in a gap two points high.
  The block has to cover 30% of the rectangle to count, the same bargain
  `links.ts` makes when it files an anchor, so a margin note that grazes a
  paragraph's corner is beside that paragraph rather than about it. A note with
  no block under it — a sticky note in the margin, a stamp in the corner — hangs
  under its own rectangle exactly as a form label hangs under its widget, and
  takes the reading-order slot `insertIndex` gives it.
- **It takes the column it sits in.** A note that follows a block is given that
  block's `x` and `w`, so it reads as a remark under the passage instead of a
  paragraph of its own starting wherever the icon happened to be.
- **Wrapping is what an overflow costs, not what every note pays.** The width is
  narrowed only when the sentence will not fit the column or would run past the
  right edge of the page, and then on word boundaries. Both the width and the
  break points are estimates — no measurer exists this early — and they are set
  a shade *generous*, so a line comes back a little short rather than a
  character wide: an extra line costs points of empty space, a line too long
  costs an overlap.
- **Italic and grey, in a class of its own** (`.annotation`), so a stylesheet can
  reach a note without reaching a form label, and the other way round.
- **It obeys the same rules as printed text**: `classifyLine` and
  `tokenizePlaceholders` run on it, so a note that is already Burmese, an address
  or a formula is handled as it would have been if it had been printed, and
  `buildUnits` binds it **backward** with the passage it marks — the way a
  caption binds to its figure, so one request translates both.
- **Five annotations on the fixture say nothing**: a `/Link` (that is
  `links.ts`), a `/Widget` (that is `formFields.ts`), a `/Popup` — which repeats
  its parent's `/Contents` at a *different* rectangle, so only the subtype keeps
  the note from being printed twice — an annotation behind `/F 2` hidden, and one
  whose `/Contents` is blank.

Two limits worth stating. The note's **author** (`/T`) and **date** (`/M`) are
deliberately not prefixed: a name is not for translating, and a date that went
through the model is a date nobody can check. And a note whose words live *only*
in its appearance stream, with nothing in `/Contents`, has nothing to say here
either — parsing appearance streams is out of reach of this pass, as it is of
every other pass in the pipeline.

`fixtures/annotations.pdf` (generated by `scripts/make-fixtures.mjs`) carries
nine annotations on one page — the four that speak and the five traps above. The
probe counts all nine; four blocks come out; every printed line stays exactly
where it was.

### Why a grown block is pushed instead of clipped

An EN→MY translation comes back taller than the line it replaced — often by
half — inside a box that was cut from the *source* PDF. An absolutely-positioned
layout has exactly three options: shrink the text, clip it, or move whatever is
underneath. Clipping is what "breaking them" means, so the two commits of this
phase take the other two in order, and only in that order.

Shrinking is `src/editor/autofit.ts`'s job and it is deliberately timid: the
band is `[6pt, originalFontSize]`, it runs only when a *translation* lands
(a person typing is never re-sized under their fingers), a size the reader
picked by hand is never overridden, and text that will not fit even at the floor
keeps the document's own size and is flagged — a 6pt line that still spills is
unreadable *and* wrong. What the band cannot absorb is handed to
`src/export/reflow.ts`, which moves the blocks below down by exactly the
surplus. Two rules keep that honest:

- **Only a block that sat above you can move you.** "Above" is judged on the
  *extracted* boxes, so two blocks that shared a row in the source — a second
  column, or a full-width band and the columns it sits on — are never treated as
  cause and effect. Growth in column one leaves column two exactly where it
  was, while a band that grew moves both columns under it.
- **The page cannot grow.** `@page { size }` is fixed, so a push stops at the
  bottom edge rather than printing half a block onto the next sheet, and a box
  too tall to fit anywhere is left alone. A block the edge stopped is named in
  the export summary — `EXPORT_LAYOUT_CLIPPED`, with how many — because the
  reader is then looking at an overlap and silence would be the wrong default.
  Reflow also refuses to repair an overlap the source PDF already had: that is
  a layout question for the reader, not one a push-down can answer.

The editor canvas runs the same pass, on the same measurer, so a page cannot
look broken on screen and clean in the file it prints to. The formats with no
geometry to push around are unchanged: DOCX, EPUB and Markdown are flow
layouts with no box to overflow, and the raster pair — Raster PDF and the
PNG/JPG pack — still paints the source exactly as it was, which is the entire
promise of an image format. That pair is also the one place a reader can ask
for the push-down anyway: **Adjust layout when a translation grows** in the
Export dialog (`ExportOptions.adjustLayout`, off by default) runs the same
pass through `src/export/composite.ts`, measured against the size the paint
will actually use — auto-fit has already shrunk each block into its box, so
only text that still overflows at the 6pt floor spends a push — and reports
`EXPORT_LAYOUT_ESTIMATED` and `EXPORT_LAYOUT_CLIPPED` exactly as the HTML and
print paths do. With it off, nothing about the sheet changes.

Either way the push cannot dodge artwork: figures and rules are painted into the
background before the text is, so a block grown taller than the gap above a
figure ends up over it — the same bargain the HTML path makes. Only the page
edge names itself (`EXPORT_LAYOUT_CLIPPED`); a block that landed on artwork is
left for the reader to see.

_Known limitations carried over: table cell truncation at 45k characters,
style reset on re-parse, no equation rendering (type 23). Reading order is
unit-tested against synthetic column geometries (2/3/4 columns, fused rows,
spanning titles, tables) and now also runs `fixtures/complex.pdf` end-to-end —
but that fixture is generated by `scripts/make-fixtures.mjs`, so no
real-world multi-column PDF has been through it yet. Footnote detection is
likewise tested on synthetic geometry: a
note set at the *same* size as the body is not detected (nothing separates it
but the horizontal rule above it, which is a graphics path pdf.js never hands
over), and a page whose text is mostly note type reports the note size as its
body median — so neither is recognised. Heading levels have the same caveat:
the ladder is exercised against generated fixtures, and no real academic paper
has been through it end-to-end. Layout auto-adjust shares the fixture caveat and
brings one of its own: reflow measures with the same canvas the raster path
uses, so a document exported where that canvas refused to open falls back to a
0.52em-per-character estimate and can shift a block a line further than it
needed. That is no longer silent — the export reports an
`EXPORT_LAYOUT_ESTIMATED` warning, in English and Myanmar, when it happened.
For the raster pair that warning is raised only when **Adjust layout** is on:
without it no block is *placed* by measurement, but the paint still wraps from
the same estimate, and there the result is visible only in the sheet.
The overflow badges survive reflow on purpose: it changes where a
block sits, not whether it outgrew the box the PDF cut for it.
Code detection carries the fixture caveat hardest: the detector and the
indentation rebuild are unit-tested against constructed geometry, and
**no real-world PDF containing a code snippet has been through them**. Three
gaps are known and unguarded. A blank line inside a snippet is lost — a line
with no text has no bounding box to measure, so the gap between two statements
closes up in the flow formats. The face is read off the family *name*, so a
PDF that subsets a monospaced font under a name with no hint of one (some do)
is caught only when its punctuation scores. And the wider `canMerge` tolerance
means two unrelated monospaced blocks that sit close together can fuse into
one, since "both lines are monospaced" is the whole of that test. No export
format renders syntax colouring: the PDF does not record which tokens were
which colour per glyph, so a snippet is set in one colour like the prose
around it. Table detection has three gaps of its own. A gutter narrower than
one em is not read as a column - that is the same threshold that keeps word
spaces out, and plenty of tables are ruled tighter than a full em. A row whose
runs offer no boundary at all (a last cell left blank, for instance) stops the
whole block being a table, and a row that comes out less than half filled is
read as prose that sat beside a table rather than a row of it - which is the
trade that keeps prose out. Multi-page joins have two gaps of their own: the
hint that rescues a single orphaned row travels within a parse window only, so
a continuation first read in another window falls back to the two tables every
format gave it before; and two same-width tables either side of a break are
indistinguishable from one, which lands the join — mildly, in every format,
with the rows together and one header fewer. And `tableCells` records cell
*text*, not cell
boxes, so DOCX columns are equal-width and HTML divides the block's own width;
the PDF's real column widths are not available. Markdown is the one format
that must promote row 0 to the header, because its grammar has no table
without one; HTML, EPUB and DOCX make no such claim about the document._
