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
| 6  | PDF With Tables (simple/complex, merged cells, multi-page) | 🔶→⏳ | **Real table cells ✅** — a run of rows whose columns align becomes one `kind: 'table'` block carrying `tableCells` (rows × columns) as data, and HTML/EPUB draw a real `<table>`, DOCX a real `w:tbl`, Markdown a pipe table, JSON the grid (see below); table rows are explicitly exempt from the column split so merging cells stay one row; **merged cells and multi-page tables ❌**, and a gutter narrower than one em is not read as a column |
| 7  | Academic / Research PDF (footnotes, refs, citations, equations) | 🔶→⏳ | 2-column papers classified `text` ✅ and read in column order ✅; footnote regions ✅ (see below); heading hierarchy ✅ — every heading carries a 1–6 level from a document-wide ladder (see below); equations ❌ (see #23) |
| 8  | Business / Report PDF (reports, invoices, financial) | 🔶 | Paragraph/table extraction ✅; invoice form layout understanding ❌ |
| 9  | Forms / Structured PDF (fillable, checkboxes, signatures) | 🔶 | Field detection/counted in probe ✅, password-style unlock flow ✅; translating labels in phase c; form filling ❌ (out of scope) |
| 10 | Presentation PDF (slides, big headings, text boxes) | 🔶→⏳ | Size-spread/complexity signal ✅; per-slide text-box reading order in phase c |
| 11 | Book / Document PDF (chapters, TOC, headers/footers, page numbers, long docs) | 🔶→⏳ | Header/footer bands, page labels, running heads ✅; long-document chunked translation ✅; footnote regions ✅ |
| 12 | Magazine / Brochure (complex layouts, multi-column, text around images) | 🔶→⏳ | `complex` classification ✅ (columns, overlap, size spread); multi-column reading order ✅; text-around-image structure repair in phase c |
| 13 | Technical PDF (manuals, code snippets, diagrams) | 🔶→⏳ | Extracts as text ✅; **code blocks** ✅ — detected, kept as `kind: 'code'`, indentation rebuilt from the bounding boxes and rendered as code in every format; **blank lines inside a snippet are not recovered** ❌ — a line with no text has no bounding box to measure, so the gap between two statements closes up in the flow formats |
| 14 | Legal PDF (contracts, numbered sections, footnotes) | 🔶→⏳ | Numbered-section/list handling ✅; footnote regions ✅ — `1.`, `1)`, `1` and `(a)` callouts are recognised, so numbered notes are not read as list items |
| 15 | Password-Protected / Encrypted PDF | ✅     | Wizard password prompt, wrong-password explanation, unlocked pre-flight; graceful unsupported-encryption errors; fixture-tested (RC4) |
| 16 | Large PDF (hundreds/thousands of pages) | ✅     | 300-page fixture: worker-side probe/parse, main thread stays responsive, resumable queue, progress UI, chunked translation |
| 17 | Unicode / Multilingual (Burmese, CJK, Arabic, Devanagari, Cyrillic) | 🔶→⏳ | Language detection + Zawgyi/Unicode handling ✅, Myanmar rendering ✅; OCR validated for English end-to-end, other scripts need their tesseract traineddata (mya available, untested) |
| 18 | RTL PDF (Arabic, Hebrew, mixed) | 🔶     | RTL line ordering in grouping ✅; bidi/visual-order edge cases ❌ |
| 19 | PDF With Annotations (comments, highlights, stamps, links) | 🔶→⏳ | Annotation/link counting in probe ✅; `/Annots` `/Link` rectangles now become anchored `<a>` / `[text](url)` / docx `ExternalHyperlink` ✅ (external only — see below); comments, highlights and stamps still carry no text of their own ❌ |
| 20 | Damaged / Invalid PDF | 🔶     | Load/probe failures surface as actionable errors ✅; partial repair ❌ |
| 21 | PDF With Embedded Fonts (subset/custom/fallback) | ✅     | Font inventory (embedded/standard/other) in metadata ✅, subset-prefix cleaning ✅, Myanmar fallback stack in export ✅ |
| 22 | PDF With Complex Layout (text boxes, overlap, sidebars, watermarks) | ⏳→✅   | `complex` class + scoring ✅ (this phase); column/sidebar reading order ✅; text-box + overlap repair in phase c |
| 23 | PDF With Equations / Math content | ❌     | Formulas extract as plain text (lossy); LaTeX/OCR-of-equations not implemented |
| 24 | PDF With Code (syntax, monospace, formatting) | 🔶→⏳ | Monospace face extracted as style ✅; **block-level code formatting** ✅ — a snippet is fenced in Markdown, `<pre>` in EPUB, `Courier New` with real `<w:br/>` in DOCX, and monospace with `white-space: pre-wrap` in HTML/print; **syntax colouring** ❌ — the PDF never hands over which tokens were which colour per glyph, so a snippet is set in one colour like the prose around it |
| 25 | PDF With Hyperlinks (external, internal, TOC, cross-references) | 🔶→⏳ | External links ✅ — rectangle → words → `LinkRef[]` → anchored output in HTML/EPUB/Markdown/DOCX/JSON; URL text preserved as plain text ✅ in every format; **internal `/Dest` links (TOC, cross-references) are deliberately not rendered** ❌ — a destination is a page index, not a URL, and carrying it would invent anchors the target document does not have |

## Phase roadmap for this matrix

| Phase | Delivers | Moves types |
| ----- | -------- | ----------- |
| (a) Classification | `complex` class, complexity scoring, item-level column detection, wizard metadata | 4, 12, 22 classification ✅ |
| (b) Extraction methods | Browser Tesseract OCR auto-runs per window (status lifecycle, confidence, cached recognition), hybrid merge with geometric dedup, run-OCR setting persisted per project, Python sidecar server (protocol v1, 20 tests) | 2, 3 extraction ✅ |
| (b2) Sidecar wiring | `src/sidecar/sidecarClient.ts`: cached `GET /health` probe, `POST /ocr` with page/language/password, per-line confidence added to the server response, lazy render so a sidecar page never rasterises in the browser, automatic fall-back to browser Tesseract on any failure (22 client + 5 pipeline + 1 Python test) | 2 extraction ✅ with a native-OCR fast path |
| (c) Structure preservation | **Reading order ✅** — `src/pdf/readingOrder.ts` cuts rows fused across a column gutter back into one line per column, orders 2–4 columns left to right, and gives a title that spans the fold its own zone ahead of both columns. `fixtures/complex.pdf` (3 columns + rotated watermark) now reads col 1 → col 2 → col 3 → watermark end-to-end. **Footnote regions ✅** — `src/pdf/footnotes.ts` marks them before any merging happens. **Heading hierarchy ✅** — `src/pdf/headings.ts` builds one document-wide ladder of heading font sizes during the probe and every page levels its headings against it; exporters render `h1`–`h6`, `HeadingLevel.HEADING_1–6` and ATX hashes. **Links ✅** — `src/pdf/links.ts` turns every external `/Link` rectangle into the words it covers and every exporter renders them as a real anchor (see below). **Code blocks ✅** — `src/pdf/codeBlocks.ts` calls a run of lines code when two independent readings agree: a monospaced face *and* statement punctuation; a monospaced face *and* nesting (which is what catches YAML and JSON, whose lines carry no punctuation to score); or punctuation alone across several lines with a brace somewhere. `structure.ts` gives it `kind: 'code'`, stamps `skipRule: 'code'` so the model never rewrites a program, and hands the indentation back — see below. **Table cells ✅** — `src/pdf/rowSplit.ts` reads a run of rows whose columns align as one `kind: 'table'` block with `tableCells` as data, and every format draws a real grid rather than tab-separated text — see below. Remaining in this phase: image-anchored extraction, form labels | 4 ✅, reading order for 3 / 7 / 12 ✅, footnotes for 7 / 11 / 14 ✅, heading hierarchy for 7 ✅, links for 19 / 25 ✅, code blocks for 13 / 24 ✅, table cells for 6 ✅; then 5, 9 |
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
the file and the exported HTML; internal `/Dest` links are dropped outright,
because a page index is not a URL and rendering one would invent an anchor the
target document does not have.

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
content.

_Links carry these caveats: anchors only survive if the model keeps the words
or the URL; a page converted to Zawgyi before parsing reports different bytes
than the annotation was cut from, so its anchors are missed; DOCX uses an
explicit `0563C1` underline rather than the `Hyperlink` style, which exists only
inside Word's own stylesheet._

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
layouts with no box to overflow, and the raster export still paints the source
exactly as it was — which is the entire promise of that format.

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
trade that keeps prose out. And `tableCells` records cell *text*, not cell
boxes, so DOCX columns are equal-width and HTML divides the block's own width;
the PDF's real column widths are not available. Markdown is the one format
that must promote row 0 to the header, because its grammar has no table
without one; HTML, EPUB and DOCX make no such claim about the document._
