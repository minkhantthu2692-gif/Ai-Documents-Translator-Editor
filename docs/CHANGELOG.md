# Changelog

Notable changes to **AI Documents Translator & Editor**, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Dates are only added when a release is actually
cut — everything under `Unreleased` is work in progress on `main`.

## [Unreleased]

Phase 5 — cloud sync and the troubleshooting assistant.

### Added

- **Bulk project deletion** (Projects page): a checkbox on every project card (grid) and row
  (table), a select-all checkbox in the table header, and a bulk bar that reports the true
  selection count — "N selected · Clear selection · Delete selected" — behind the same
  confirm dialog as a single delete. Backed by `projectRepo.removeMany`, which runs the full
  cascade per project (pages, blocks, translations, jobs, sync tombstones), so a whole shelf
  of finished books leaves in one gesture.
- **Factory reset** (Settings → Cache → "Reset the whole app", in a danger-zone card): one
  button returns the app to its freshly-installed state — every database table (projects,
  pages, blocks, translations, translation memory, glossary, keys, settings, usage, events,
  sync state), the sealed device secret, the cached device id and the persisted UI
  preferences are erased, the page reloads and the defaults re-seed. Guarded twice: the
  danger-zone placement, plus a modal that names what is about to be lost and keeps the
  final button disabled until `RESET` is typed exactly — a trailing space does not arm it.
- **Welcome + first-time setup screen** (`/welcome`, the combined landing/first-run page):
  the first visit asks for the UI language (English/မြန်မာ), the appearance (light, dark or
  system — applied live) and whether cloud sync will be set up later, then "Get started"
  heads to the new-project flow (or straight to the sync settings) while a quiet link skips
  to the dashboard. Only the index route is gated — shared deep links always open — and a
  fresh profile or a factory reset brings the screen back. The smoke suite dismisses it
  automatically.
- **Google Apps Script cloud sync** (`apps-script/Code.gs`, `apps-script/appsscript.json`):
  a stateless web-app backend over a Google Sheet with tabs **Projects**, **Pages**,
  **Blocks**, **Glossary**, **Settings**, **UsageStats**, **ApiKeys** and **SyncLog**;
  shared-secret token
  (`UNAUTHORIZED` on mismatch), `LockService` to serialise writers, chunked writes, tombstoned
  deletes and the actions `ping`, `pushChanges`, `pullChanges`, `listProjects`, `getProject`,
  `upsertBlocks`, `deleteProject`, `backup`, `wipe`.
- **Sync engine** (`src/sync/`): outbox-based delta push, paged pull, last-write-wins merge
  mirroring the server rule (updatedAt → version → deviceId), a local `syncConflicts` log,
  per-entity selective sync, conflict policy (`newest` / `local` / `remote`), auto-sync on an
  interval, offline fail-fast with retry on reconnect, **Sync Now**, test connection, wipe
  cloud and delete local — all in Settings → Data.
- **Settings-side sync controls**: a dedicated **Provider settings** switch (on by default) so
  `ai.*` provider configuration travels independently of theme/language/cache prefs; a separate,
  off-by-default **API keys** switch; a **Download Code.gs** / manifest pair and an in-Settings
  setup guide (Settings → Data), so the backend can be stood up without finding the repository.
- `ping` now reports the entities a deployment can store. Because `Code.gs` validates a whole
  batch before writing anything, an unknown entity would fail *every* push — key rows are held
  in the outbox (with backoff) until the server says it accepts them, so a deployment that
  predates the `ApiKeys` tab cannot take the rest of the sync down with it.
- **Troubleshooting Assistant** (`src/assistant/`): proxy mode through `proxy/` (Node/Express
  `server.js` and `cloudflare-worker.js`) plus an offline rule-based fallback, automatic secret
  redaction (`src/assistant/redact.ts`) and one-click safe actions (`rotate-key`,
  `reduce-batch`, `clear-cache`, `retry`, `open-providers`, `open-data`, `open-logs`).
- **`.env.example`** documenting `VITE_APPS_SCRIPT_URL`, `VITE_APPS_SCRIPT_TOKEN`,
  `VITE_ASSISTANT_PROXY_URL` and `VITE_BASE`.
- **Tooling**: `tools/launcher.html` bilingual start page, `tools/open-app.bat|.sh` one-click
  dev launcher, `tools/push-to-github.bat|.sh` guided commit/push.
- **Live verification harness** (`src/verify/liveRun.test.ts`): an opt-in suite
  (`VERIFY_LIVE=1` plus key/PDF variables in the environment — keys are never written to a
  file) that drives the genuine pipeline end to end against a real provider: key validity,
  live model discovery and chain selection, a first-token preflight through the real adapter,
  three content-rich pages of a real PDF through the real queue (real key pool, budget,
  engine, adapters, terminology), and a merge-integrity re-plan that re-derives the batch
  plan from the finished state and proves nothing was dropped or duplicated. The report
  prints per-batch requests/latency/tokens, retries with their kinds, rate-limit waits,
  model fallbacks and per-key pool state — on success *and* on failure, because a stalled run
  is the one that must be diagnosable. The harness shares the worker's `reasonFor` mapping
  (`src/translate/reasons.ts`, now imported by both), so the queue and the report see the
  production reason codes. The suite skips cleanly when the variables are absent. Before the
  queue starts, a **protocol probe** asks the model two batches (3 and 20 lines) through the
  engine's own system prompt, numbered-line user prompt and strict validator, so a model
  that cannot honour the JSON contract — or that starves its answer with reasoning — is
  exposed in seconds instead of burning a whole retry ladder and the day's free-tier quota;
  and when every key ends up quota-parked or rejected the run fails fast in seconds with
  that state instead of waiting out a deadline that lands tomorrow. The first
  runs against OpenRouter's and Groq's free tiers are what surfaced the translation
  fixes below — and pinned down what "free" means in practice: OpenRouter allows **50 model
  requests per key per day** (adding $10 of credit raises it to 1000), while Groq's free
  tier is token-paced (8000 TPM, 200 000 tokens/day for `gpt-oss-120b`) and sustains real
  documents slowly rather than running out.
- **GitHub Pages deployment**: `.github/workflows/deploy.yml` (type check → tests → build →
  `404.html` SPA fallback → deploy) with a configurable repository variable `VITE_BASE`.
- Schema **v7**: `syncConflicts` (LWW conflict log) and `syncMeta` (pull cursor, push cursors,
  per-device version vector); the token setting is stored sealed and never synced.
- Documentation: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`,
  `docs/CONTRIBUTING.md`, `docs/CHANGELOG.md`, `docs/LICENSE`, `README.md`, `README.my.md`.
- **Heading hierarchy** in PDF extraction (phase (c) of `docs/PDF_TYPES_SUPPORT.md`): the probe
  builds one document-wide ladder of heading font sizes (`src/pdf/headings.ts`) and every page
  levels its headings 1–6 against it, so a section keeps its depth even on pages where its
  chapter title is absent. HTML emits `h1`–`h6`, DOCX `HeadingLevel.HEADING_1–6`, EPUB chapter
  headings and Markdown ATX hashes — each offset past the structural headings that builder
  already prints and clamped at six, with `.block` neutralising the browser's default heading
  styles so the printed page is unchanged.
- **Clickable links** in PDF extraction (phase (c) of `docs/PDF_TYPES_SUPPORT.md`): every
  external `/Link` annotation becomes a `LinkRef[]` on the block it sits over
  (`src/pdf/links.ts`), anchored on the words the rectangle actually covered. HTML and EPUB emit
  `<a href rel="noopener noreferrer" target="_blank">`, Markdown `[text](url)` with the label's
  brackets escaped, DOCX an `ExternalHyperlink` run that keeps the surrounding font, size,
  weight, italics and direction, and JSON carries the pairs for a round trip. Destinations are
  allow-listed before anything else sees them — `javascript:`, `data:` and `file:` are dropped,
  a scheme-less `www.…` is promoted to `https://`, and a URL over 2048 characters is refused.
  Internal `/Dest` links (TOC, cross-references) are deliberately not rendered: a page index is
  not a URL.
- **Layout auto-adjust when a translation grows** (phase (d) of
  `docs/PDF_TYPES_SUPPORT.md`): `src/editor/layout.ts` re-measures a block the moment a
  translation lands — on the bulk queue, on inline re-apply and on accept-suggestion, but never
  while a person is typing — and takes the largest size in `[6pt, originalFontSize]` whose
  wrapped text still fits the original bbox. A size the reader pinned by hand is left alone, and
  a block that will not fit even at the floor keeps the document's own size and is flagged
  rather than shrunk into illegibility. A Layout card in Settings → General turns it off.
- **Reflow of what auto-fit could not shrink**: `src/export/reflow.ts` pushes the blocks under a
  block that outgrew its box down by exactly the growth, within their own column, chaining
  through a stack and stopping at the page edge (`@page` is fixed, so nothing is printed half off
  the next sheet). Growth in column one leaves column two untouched, a full-width band that grew
  moves both columns under it, and an overlap the source PDF already had is left for the reader.
  HTML now emits `min-height` where it emitted `height`, so a box is a floor the translation may
  grow into rather than a ceiling it paints over. Formats with no geometry — DOCX, EPUB,
  Markdown — and the raster export are unchanged, the raster pair by default only (see the
  opt-in below). The editor canvas runs the same pass through
  `reflowForPage`, so a page cannot look broken on screen and clean in the file it prints to. A browser that
  will not give the export a canvas to measure with now says so: reflow falls back to an estimated character
  width, and the export raises an `EXPORT_LAYOUT_ESTIMATED` warning (EN + MY) instead of placing blocks
  silently. The other silent case is gone too: a block the bottom edge stopped — the page box is fixed, so the
  push runs out of room — is counted and reported as `EXPORT_LAYOUT_CLIPPED` (EN + MY) rather than left
  to overlap in quiet.
- **Adjust layout for the raster pair** (Fix 2 of the phase (d) follow-ups): Raster PDF and the
  PNG/JPG pack painted every block at the `y` the PDF gave it, so a translation that would not fit
  even at the 6pt floor printed over the block below. `ExportOptions.adjustLayout` — off by
  default, offered as "Adjust layout when a translation grows" in the Export dialog for exactly
  those two formats — runs the same push-down through `layoutBlocks` in `src/export/composite.ts`,
  measured against the size the paint will actually use (auto-fit has already shrunk the block, so
  only text still overflowing at the floor spends a push), and reports `EXPORT_LAYOUT_ESTIMATED`
  and `EXPORT_LAYOUT_CLIPPED` the way the HTML and print paths do. Left off, the sheet is exactly
  as geometry-exact as it was.
- **Code blocks** in PDF extraction (phase (c) of `docs/PDF_TYPES_SUPPORT.md`, types 13 and 24):
  `src/pdf/codeBlocks.ts` calls a run of lines code when two independent readings agree — a
  monospaced face *and* statement punctuation, a monospaced face *and* nesting (which is what
  catches YAML and JSON, whose lines carry no punctuation to score), or punctuation alone across
  several lines with a brace somewhere. The block is given `kind: 'code'` and stamped
  `skipRule: 'code'`, so the translator never rewrites a program even when no single line would
  have tripped the per-line rule on its own. Indentation is the one thing extraction throws away
  — `groupItemsIntoLines` collapses whitespace because prose does not care where a word began —
  so it is measured back off the bounding boxes: in a monospaced face `bbox.w` over the character
  count is the exact advance width, and `links.ts` already makes the same trade in the other
  direction. `canMerge` used to refuse two lines whose left edges differed by more than half a
  character, less than a single indent step, which shredded every nested snippet into one block
  per nesting level; it now widens that tolerance when both lines are monospaced, and a `;` no
  longer reads as the end of a sentence. Every exporter renders the result as code: fenced in
  Markdown (with the fence widened past any backtick run inside), `<pre>` and a monospace stack in
  EPUB, `Courier New` with real `<w:br/>` breaks in DOCX, and monospace with `white-space:
  pre-wrap` in the HTML and print paths. The editor canvas draws the same face, so the page cannot
  look wrong on screen and right in the file.
- **Real table cells** in PDF extraction (type 6 of `docs/PDF_TYPES_SUPPORT.md`): the old row
  detector split `line.text` on `/\s{2,}|\t/`, but `groupItemsIntoLines` collapses every
  whitespace run to one space before the structure pass ever sees a line — so it could not match
  a real PDF, and table detection had been firing only on lines a test built by hand.
  `src/pdf/rowSplit.ts` reads it geometrically instead: pdf.js emits one text item per show-text
  operator, so a cell arrives as its own run at its own x, and a gap of a full em on a shared
  baseline cannot be a word space (no face sets one that wide). Cut positions are clustered and a
  cut becomes a column only when most of the rows agree, because a table is *aligned* columns;
  right-aligned columns drift, so rows are matched within half a character rather than exactly;
  and a row that comes out less than half filled is prose beside a table, not a row of it. The
  block gains `tableCells` — rows × columns, rectangular — beside `text`, which keeps its
  ` \t ` form byte for byte so the model, the prompts and the translation cache are untouched;
  `BlockRecord` takes it as an optional field, so no schema version bump and an older row simply
  has none. Every format draws the grid now: a `<table>` with real cells in HTML (both layouts,
  ruled from the stylesheet), a `<table>` in EPUB, a real `w:tbl` with `w:tc` cells in DOCX, a
  pipe table in Markdown, the grid itself in JSON — and each one falls back to the paragraph the
  text has become when a translation comes back with no cell separators left in it. The one
  deliberate exception is `looksLikeTableRow`, which feeds `cutAtBands`: a fused column line and
  a table row are indistinguishable by gap (28pt against 26pt) or by run count, so that guard
  accepts the whitespace form or geometry restricted to runs narrower than eight ems — a cell is
  a label, a column's run is a span of prose — which is what keeps types 3, 7 and 12 cutting
  columns while a real table survives whole. `fixtures/table.pdf` (new, generated by
  `scripts/make-fixtures.mjs`) is two pages drawn cell by cell, one row leaving a middle cell
  empty, with prose on either side that must stay prose.
- **The local sidecar as a second reader for PDF text** (`POST /extract`): a PyMuPDF answer for a
  page pdf.js could not read, and nothing more. Measured on the 300-page fixture the sidecar
  takes ~1.3 s for one 12-page parse window where pdf.js takes ~20 ms — pdfplumber's
  `find_tables` and the classify-level signal sweep run on every page — so wiring it in as the
  *first* reader would have been a 45–80× pessimization. It is reached only after `extractPage`
  throws, or after it read text it could not turn into a single block (`needsSidecarFallback`),
  which is the one silent failure worth a second opinion: a genuinely blank or scanned page comes
  back empty *correctly* and is left alone. An ordinary document never calls it, and the analysis
  worker keeps the file's bytes in memory only while `/health` says a sidecar is reachable. The
  seam is deliberately narrow — `assemblePage` in `src/pdf/pdfExtract.ts` is the single tail both
  engines feed. Sidecar lines are rewritten as pdf.js-shaped runs one em tall (PyMuPDF spans
  ascender-to-descender, pdf.js spans one em, and `canMerge`'s gap threshold has to mean the same
  thing on either path) and pushed through the same `groupItemsIntoLines` → `structurePage` →
  links passes, so reading order, footnotes, code, tables, headings and link anchors remain
  implemented exactly once, in TypeScript, and the sidecar's own
  `kind`/`region`/`alignment`/`order` are ignored. A page it cannot answer for is *declined by
  name* rather than by exception — `page-rotation` (display space vs. the browser's user space),
  `line-rotation` (an axis-aligned box cannot carry a −45° title), `pdfplumber-table` (the
  in-table prose has been removed and the cells arrived with no rectangles), `extraction-method`
  (a scan, which the app's own OCR pipeline owns) — and the browser's result stands.
  `fixtures/sidecar/*.json` (new) are recordings of a live server for six fixtures, replayed by
  `src/sidecar/extractParity.test.ts` and asserted identical block for block: same kinds,
  regions, text, `tableCells`, link anchors and boxes within 3 pt; regenerate with
  `node scripts/record-sidecar-extract.mjs`.
- **Image-anchored extraction** in PDF parsing (phase 9a of `docs/PDF_TYPES_SUPPORT.md`, types 5
  and 12): every block now carries `figures: FigureRef[]` — the pictures the page painted beside
  it, each a rectangle plus the raster's native pixel size. Nothing in pdf.js will say where a
  picture is: an image operator hands over an object id, and the rectangle is whatever the current
  transformation matrix does to the unit square. `src/pdf/imageOps.ts` therefore walks the
  operator list the way the renderer does, keeping a graphics-state stack through `save` /
  `transform` / `restore`, giving a form XObject its own frame on that stack, and emitting one box
  per tile for the fused `repeat` and mask-group operators — composing every `cm` with the newest
  transform on the left, because `CTM' = M × CTM` is what makes a nested frame land outside its
  parent's scale rather than inside it. `paintSolidColorImageMask` is skipped deliberately: pdf.js
  also uses it to render stroked text. `src/pdf/figures.ts` then decides which rectangles are
  figures and who owns each — a run over 8pt or under 600pt² is a rule or an icon, over 60% of the
  sheet is a wash or a scan, a centre in the top or bottom 10% band is a running head (which is
  what keeps a letterhead logo out of the body), and more than 70% of the rectangle covered by type
  means the picture is *behind* the page rather than next to it. Pairing is staged: a numbered
  caption (`Figure 1.`, `Fig. 2`, `Plate IV`…) within four caption-fonts below or above, else the
  nearest body block within half the page height sharing a third of a column — so `mixed.pdf`'s
  running head, which reads `Figure 1 - …` and matches the pattern as well as any caption, still
  loses to the paragraph four hundred points nearer. The pass resets `figures` first, so it is
  idempotent, and caps each block at twelve pictures so a tiled pattern cannot pile every tile onto
  one paragraph. Because the local sidecar has no operator list, `recoverWithSidecar` reads pdf.js's
  `getOperatorList()` for the placements even though the text came from PyMuPDF — both engines are
  fed the same geometry, and the parity test now compares `figures` for it. The field reaches
  `DbBlock.figures` (optional, no schema bump) and `ExportBlock.figures`, and JSON exports it.
  `fixtures/figure.pdf` (new, generated by `scripts/make-fixtures.mjs`) paints six images across two
  pages of which exactly two survive: a captioned figure and an uncaptioned one anchored to the
  paragraph below it. HTML/PDF/print are unchanged and continue to show figures as page art.
- **Figures embedded in DOCX, EPUB and Markdown** (phase 9b of `docs/PDF_TYPES_SUPPORT.md`,
  completing types 5 and 12): the boxes phase 9a recorded are now cropped out of the page and
  placed beside their own text. The crop is cut from the **same background render the HTML and PDF
  exports already use** (`renderPageImages({ mode: 'background' })`), so a picture looks identical
  in a DOCX and in the browser preview and there is one code path to maintain. It is cut inside
  `renderPage` (`cutOut`, `src/pdf/pageRender.ts`) immediately after the render and *before* the
  page blob is encoded — a figure request asks for crops only, so whole pages never cross the worker
  boundary just to be discarded — and only the pages that carry a picture are rendered at all: a
  300-page report with four diagrams costs four raster passes. Crops are PNG, not WebP, because
  `docx`'s `ImageRun` accepts `jpg|png|gif|bmp` and EPUB readers are still uneven about WebP.
  `src/export/figureArt.ts` is the shared vocabulary the three builders agree on: `figureKey`
  names a crop identically in the renderer and in the builder, `figureSize` gives a picture the
  printed size it had on the page (a PDF point is 96/72 of a CSS pixel, which is what DOCX and CSS
  both measure in) and shrinks only an over-wide one, proportionally, and `figureGoesBefore`
  decides which side of its block a figure belongs on by comparing midpoints — a picture painted
  *above* its caption stays above it, one below the paragraph it was paired with stays below. EPUB
  declares every crop in the package manifest under `OEBPS/images/figure-N.png` (an `<img>` whose
  target is missing from the manifest will not open in every reader) and drops art no chapter
  references; DOCX packs it into `word/media` with the caption as its accessibility description;
  Markdown inlines it as a data URI, because Markdown has no asset folder. `figureRequirement`
  scopes all of it to exactly those three formats — HTML/PDF/bilingual-PDF/the raster PDF/the
  image pack already carry the whole rendered page, JSON carries the geometry, and text/CSV/TSV
  are not documents — and `includeImages: false` turns it off. A crop that fails to render is
  skipped and reported as an `EXPORT_FAILED` issue rather than embedding a zero-byte file or a
  broken link.
- **Form labels** (phase 10 of `docs/PDF_TYPES_SUPPORT.md`, completing type 9): the printed
  words beside a fillable form's boxes were always ordinary content-stream text and always
  translated; what nothing else in the pipeline could reach was the text a **widget** itself
  carries and never prints — its `/TU` tooltip (what a screen reader announces) and a choice
  field's `/Opt` option captions (what a reader picks from, and invisible in a PDF because you
  cannot open a dropdown there). `src/pdf/formFields.ts` turns each described widget into one
  `kind: 'form-field'` block — `BlockKind` gained a value, no new field on the block — hanging
  directly under its own box, so the text enters the same queue, is editable in the workspace
  and reaches every exporter with no exporter knowing about forms. It is italic and grey in
  every format so it cannot be mistaken for the label printed above it, it runs through the same
  `classifyLine` / `tokenizePlaceholders` passes as printed text, and it is attached *after*
  links and figures so no anchor and no figure is re-paired against one: the printed blocks keep
  their text, geometry and anchors and only their `order` moves to make room. The box grows right
  and down to hold its lines (a dropdown's four captions must not be squeezed into a 16 pt
  rectangle) and moves above the widget when the page has no room below it. A widget with nothing
  to say — a bare push button, a hidden field, an undescribed text box — contributes nothing.
  `fixtures/form.pdf` (new, generated by `scripts/make-fixtures.mjs`) carries ten widgets across
  two pages and six come out as blocks. Known gap: pdf.js returns widget annotations only, so a
  radio group's `/TU` on its *parent* field is not reached.
- **Annotation notes** (phase (c) follow-up of `docs/PDF_TYPES_SUPPORT.md`, completing type 19):
  a reviewed PDF keeps its marginalia in the annotation dictionary rather than in the content
  stream, so a sticky note's message, the reason a passage was highlighted, a `/FreeText`
  callout's body — drawn only by its *appearance* stream — and a stamp's legend were text
  nothing in the pipeline could reach: counted in the probe, then dropped. `src/pdf/annotations.ts`
  turns each into one `kind: 'annotation'` block and runs **after** links, figures and field
  labels, because a note is *about* a block and needs the finished list to find it. A note over
  a passage is filed immediately after it at that block's own `x` and width, so it reads as a
  remark under the passage rather than landing between two of its lines; a note with no block
  under it — a sticky note in the margin, a stamp in the corner — hangs under its own rectangle
  as a form label hangs under its widget. Wrapping happens only when the sentence will not fit
  the column or would run off the right edge, on word boundaries, from an estimate set a shade
  generous (a line a little short costs points of empty space, a line a character wide costs an
  overlap). Italic and grey in a `.annotation` class of its own, the same `classifyLine` /
  `tokenizePlaceholders` passes as printed text, and bound *backward* in `buildUnits` so one
  request translates a note together with the passage it marks. Deliberately silent: a `/Link`
  (that is `links.ts`), a `/Widget` (that is `formFields.ts`), a `/Popup` — which repeats its
  parent's `/Contents` at a different rectangle — an annotation behind `/F 2`, a blank one and
  any drawn twice; the author (`/T`) and date (`/M`) are never prefixed, because a name is not
  for translating. `fixtures/annotations.pdf` (new) carries nine annotations on one page: four
  become blocks, five must produce none, and every printed line stays exactly where it was.
- **Merged table cells** (phase (c) follow-up of `docs/PDF_TYPES_SUPPORT.md`, type 6 of 25):
  PDF has no "this cell spans two columns" operator, so a merge is only ever geometry — one
  show-text run that starts inside a column and runs past the next one's left edge. `spansOf`
  in `src/pdf/rowSplit.ts` claims the crossed boundary for the cell that starts it and leaves
  the covered column blank; the answer travels *beside* the grid as `tableSpans` (page block →
  block row → export block), never inside it, so rows stay rectangular and `text` is
  byte-identical — the model and the translation cache see no change at all. HTML and EPUB
  emit `colspan`, DOCX `w:gridSpan`, JSON the spans; Markdown has no merge in its grammar, so
  it prints the covered cell empty and the row keeps its columns. A renderer applies a span
  only to a printed grid of the shape it was measured on (`tableSpansFor`): a model free to
  answer with a different number of columns gets a flat table rather than one drawn a column
  out of step. Ambiguity is answered at the smallest level that can answer it: a
  merge covering a column another run on the same row already sits in draws *that
  row* flat — every cell its own column, which is what it was before — while its
  neighbours keep theirs; a block whose rows are *mostly* merged (the shape of
  prose beside a table) and a row still under half filled once a merge counts for
  the columns it covers each reject the block, exactly as they did before. No
  vertical merges: `LineRun` is one rectangle on one baseline and cannot say a
  cell two rows tall from two cells of the same width. `fixtures/table-spans.pdf`
  (new) draws a header across both figure columns with no operator anywhere
  recording the merge; a merged cell wider than eight ems is still cut at the
  gutter by reading order before the detector sees it, which is a limit of that
  guard rather than of the spans.
- **Multi-page tables** (phase (c) follow-up of `docs/PDF_TYPES_SUPPORT.md`, type 6 of 25):
  a table that runs off the foot of a page arrives as two halves, and the orphaned row on the
  next page is usually a *single* line — the shape `tableForLines` refuses by rule — so it
  degraded to the paragraph it looked like (`West 200 210`); even when it did read as a table,
  Markdown promoted its first row to a header it did not have and DOCX emitted a second `w:tbl`
  with a seam where the page broke. Two readings join it. The **hint**:
  `continuationHintFor` hands the page just parsed's last body table — at least two cells wide,
  its bottom past 55% of the page — the `{width, left}` the row above was printed at, and
  `tableForLines` consults it only after ordinary detection has already failed, only when every
  line splits into exactly that many cell-sized runs starting at that left edge; such a block
  gets `spans: null` (one line proves no merge) and the hint is offered only to the page's
  first *body* block, a running head above it not being content. The **mark**:
  `markTableContinuations` runs in `collect.ts` at export — the one moment every page is in
  order at once — when consecutive pages *end* and *begin* with same-width tables past the
  middle of the page, which is the discrimination the shape of the evidence allows and the
  reason a wrong join cannot easily be: it would put another table's rows under this table's
  header. With the mark set, DOCX holds its table open and appends the next page's rows — one
  `w:tbl`, the page break spent on the join (Word paginates a tall table itself), `Page N`
  printed *after* the joined rows because a heading cannot sit inside a table — Markdown
  appends to the part that already has its header without promoting, pads a short row rather
  than cutting cells, and keeps quoted source rows in the quoted half; JSON carries
  `tableContinuation` beside the grid. HTML, EPUB, plain text and the delimited formats build
  tables row by row with no page in sight, so nothing there changes. A miss costs exactly the
  two tables every format gave before this. Known gaps: the hint travels within a parse window
  only — a continuation first read in another window is not rescued back — and two same-width
  tables either side of a break are indistinguishable from one, which lands the join mildly
  (rows together, one header fewer). `fixtures/table-continued.pdf` (new) is a page ending in
  a three-column table and the next opening with its orphaned row above three prose lines that
  must stay prose.
- **UI Phase 4/4 — per-project backup file** (`src/db/projectFile.ts`; one button per project
  on the Projects page). Where the whole-DB backup moves a device, an `aidt-project` JSON
  file moves **one project** between devices: the project row, its pages, its blocks
  (translated text, styles, geometry, table grids, figures, links and annotation blocks all
  intact) and its project-scoped glossary terms. **Import is always additive** — every row is
  re-identified (fresh ids, page and block wiring remapped onto the new project, rows owned
  by the importing device), so a file can never overwrite local work and importing the same
  file twice simply gives two copies. An imported project always lands in the active list
  (archive state is not carried — a restored project you cannot find is one you think you
  lost), keeps its translated progress verbatim, and warns when the referenced PDF was not
  included (JSON carries no blobs; the user still has the file). Revisions, jobs, events, the
  outbox, the translation cache and device-global glossary terms stay behind — device-local,
  or already carried by the block rows. Untrusted files are validated whole, before any
  write: format marker, schema version, string ids, every row scoped to the file's own
  project, every block's page present in the file — a half-wired or foreign file is rejected
  with the database untouched. UI: **Import project** beside **New project**, a **Download**
  icon per project row/card, success/failure toasts plus bilingual events, and a plain
  warning when the PDF is not part of the file. `src/db/projectFile.test.ts` (new, 7 tests)
  covers scope, remap, additivity, the active-list guarantee and every rejection path.
- **Phase (e) — the "in phase c" promises for slides and magazines, verified against
  fixtures** (`fixtures/slide.pdf` and `fixtures/magazine.pdf`, both new; four tests in
  `pdfExtract.test.ts`). Types 10 (presentation) and 12 (magazine/brochure) have carried a
  forward reference since the matrix was written; both are now closed against real
  extraction. The slide — one wide 36 pt title spanning two free-floating text boxes whose
  eleven-point lines share baselines, exactly the fusion trap column detection exists for —
  comes out as heading → left box → right box, each box one whole five-line block, never
  row-by-row across both boxes. The magazine — a photo inside the column with copy flowing
  around it — comes out as intro paragraph (the flow-around line stays part of the paragraph
  above the photo) → the four narrow beside-photo lines at their own x origin → the closing
  paragraph, with the photo anchored to one block instead of becoming a block of its own;
  the page probes `mixed` with the text layer intact. Both rows move 🔶→⏳ to ✅.
- **Phase (e) — internal `/Dest` links (TOC, cross-references) render as in-document
  anchors** (type 25, previously a documented refusal; `fixtures/links-internal.pdf` new).
  `links.ts` captures every `/Link` carrying a destination beside the URI ones, and
  `resolveDestination` (in `pdfExtract.ts`, threaded from the analysis worker's open pdf.js
  doc) maps a named destination through `getDestination` and a ref through `getPageIndex` to
  a 0-based page index — bounded to 32 per page, `null` (link dropped) for every failure,
  because a jump to the wrong page is worse than no jump at all. `LinkRef` gains an optional
  `destPage`; `linkSegments` turns it into `#page-N` (1-based, the numbering every page
  heading already uses), offering the words only — the anchor never appears in source text,
  so it is never searched for in prose. HTML page sections gain `id="page-N"` and an
  internal anchor skips `target="_blank"` (a contents page must not open a window per
  entry); EPUB page headings gain the same id and a cross-chapter jump is prefixed with the
  owning `chap_M.xhtml`; Markdown lands on the `## Page N` slug; DOCX prints the words
  without a hyperlink, because Word resolves those through bookmarks we do not write. The
  sidecar retry resolves with the same helper, so a recovered page keeps both kinds of
  link. Twenty tests: `internalDestinations` units, end-to-end over the new fixture (a
  direct `[ref /XYZ …]`, a named `/Dests` entry and an external URI on one page, plus the
  no-resolver behavior older readers rely on), `linkSegments` internals, and one test per
  exporter. Matrix type 25 moves 🔶→⏳ to ✅.
- **Phase (e) — syntax colouring for code snippets at export** (type 24's last open
  item). The PDF never records which tokens were which colour per glyph, so
  `src/export/highlight.ts` re-derives them from the printed text with a small
  language-agnostic lexer: line/block/`#` comments (with `#include`-style preprocessor
  directives kept out of the comment pile), all four quoting styles (single, double,
  backtick, triple-quote; escapes; a template literal may cross lines, an unterminated
  quote stops at the newline), numeric literals in every spelling, a curated keyword
  set guarded so a word behind a dot is never one (`obj.map`, `p.then`), and any bare
  word that opens a call as a function. One shared VS Code-light palette: HTML and
  EPUB paint `.tok-*` spans with the CSS shipped in both stylesheets, DOCX colours
  each token's run in `Courier New` keeping the line breaks (`<w:br/>`) exactly where
  the snippet broke, and Markdown keeps its fence plain because CommonMark has no
  inline colour and a fence labelled with a guessed language would misrender with
  authority. The lexer never sees the language (extraction records only `kind:
  'code'`), so the reading is plausible rather than the original's — documented in the
  matrix. A snippet that still carries annotation links keeps them and goes unpainted
  in HTML and DOCX: an anchor and a tokenisation cannot both own the text. Tokens
  concatenate back to the input byte-for-byte, the invariant every escaper leans on
  (16 lexer tests in `highlight.test.ts`; one test per exporter). Matrix type 24 moves
  🔶→⏳ to ✅.
- **Phase (e) — OSD for rotated scans (type 2's last open item)**. Tesseract's own
  orientation channel is unreachable through tesseract.js v7: the `osd` dump field
  stays empty on every page-segmentation mode tried, so `src/ocr/orientation.ts`
  decides orientation by *trial*. The page is recognised as rendered first (with
  tesseract.js's `rotateAuto`, which deskews — confidence 41→88 on a 2°-skewed
  fixture, exact angle reported); a first pass under 50 is re-recognised with the
  raster turned 90/180/270 on a fresh canvas using integer quarter-turn matrices
  — the turn that reaches the bar stops the search, the best attempt ships, and a
  pass that cannot turn (no `OffscreenCanvas`, a sub-region `rectangle`)
  degrades to today's behaviour instead of failing the page. The measurements
  behind the threshold are pinned from `scripts/osd-probe.mjs`, now committed as
  the reproducible evidence: upright 72, 90°-clockwise 72 (tesseract reads a
  top-to-bottom vertical line, so a clockwise turn needs no trial),
  counter-clockwise and upside-down 15 → quarter-turn trials lift them (the
  180° trial reads 74). Boxes come back in whichever frame was recognised, so
  `mapBoxBack` inverts both transforms — trial rotation and deskew, about the
  frame's centre, centres mapping to centres across the swap — and the caller
  always sees line boxes in the original render frame, the contract
  `ocrStructure` leans on; the pipeline passes the rendered pixel size to make
  that inversion exact and counts orientation fixes into the OCR summary log.
  The OCR cache key gains `#osd`, so a page re-selected after a failure
  re-recognises with trials instead of finding its own pre-OSD garbage. The
  tests are policy and frame round trips in `orientation.test.ts` (asserted
  against the real matrix, not a re-derivation) plus wiring tests through the
  real `recognizeOcr` seam. Matrix type 2 moves to OSD ✅, with the
  synthetic-fixture caveat carried in the limitations.
- **Phase (e) — damaged-PDF structural repair (type 20)**. pdf.js already heals a
  great deal on its own — it re-indexes every object when `startxref` is missing
  or its entries point at garbage, tolerates a missing header or junk before it —
  so what remained were three shapes it refuses outright: a destroyed xref *table*
  whose `startxref` still points at it, a `/Root` naming an object that does not
  exist, and a lost trailer. `src/pdf/repair.ts` fixes all three with one
  append-only move: a byte scan of `N G obj` headers rebuilds a classic xref
  table (last occurrence of a duplicated number wins — the incremental-update
  rule, generation kept), appended with a fresh trailer (`/Root` retargeted at
  the last `<< /Type /Catalog >>` the scan saw, `/Info` carried when its object
  survived), a new `startxref` and `%%EOF`; original bytes are never touched, so
  a wrong guess cannot corrupt anything further, and no catalog readable by the
  scan means `null` and the honest failure the caller already knew how to report.
  The analysis worker runs it once, only after pdf.js itself has failed, and the
  result rides `opened.repaired` into `parse.repair`, a bilingual info event with
  what was done. Probes pinned the design (which shapes pdf.js self-heals, and
  that a blanked `startxref` is *not* an escape — its indexer only adopts a
  trailer when it meets a parseable `xref` keyword); tests are byte-level plus
  the three damaged fixtures opened back through the real pdf.js in
  `repair.test.ts`. Matrix type 20: partial repair ❌ → structural repair ✅
  (content-level damage stays with the sidecar path).

- **Phase (e) — display equations (types 7 and 23, the last fully-❌ matrix
  row)**. Inline maths was already safe — `placeholders.ts` swaps `$x+y$` and
  bare `1 + 1 = 2` for tokens before the model sees the line — but a display
  equation arrives as several unremarkable fragments: TeX sets a superscript on
  its own baseline and a fraction as three lines, so the structure pass gets
  `x`, a raised `2`, a rule and `n`, each alone indistinguishable from a letter
  or a number, interleaved with the prose by reading order.
  `src/pdf/equations.ts` marks the run on the ordered body before any merging —
  a line opens it by scoring maths (mathematical face, glyphs like ∑∫², a caret
  between short tokens; two five-letter words veto it, which is what keeps "the
  α particle decay" prose) and fragments hang off their anchor by geometry,
  whichever side of the line reading order delivered them — and assembles it
  back: `x` + raised `2` reads `x^2` (braced when multi-character), a dropped
  mark `x_1`, a centred part below stays on its own line, which is how a
  fraction reads. `structure.ts` gives the run `kind: "equation"` (the schema
  widened) and `skipRule: "formula"`, so the translator never touches it: the
  source stands as its own translation in every format, exactly like code — and
  the exporters needed no change, an unknown kind already rendering as a
  paragraph that carries its line breaks. A stack part must look like maths as
  well as hang near, or the prose under a tight leading would chain into the
  formula. 23 geometry tests plus the existing structure suites green; no LaTeX
  emitted, no real academic PDF reviewed. Matrix 23: ❌ → 🔶, and with it type
  7's last ❌.

- **Phase (e) — RTL bidi (types 18, the last 🔶 row with an active ❌)**. Two
  rules in `lineGrouping.ts`, both about what pdf.js hands back for Arabic
  and Hebrew pages. A line's direction is now a character-weighted vote
  across its runs instead of an all-or-nothing `every(dir === "rtl")`: one
  `ltr` run — a quoted number, a borrowed Latin word — used to send the whole
  line back to left-to-right order, which is *visual* order for an RTL
  line, so the Arabic came out reversed around it; the mirror case (an
  English sentence borrowing one Arabic word) now keeps its own order by
  the same vote rather than by luck. And shaped presentation forms — the
  same letters pre-shaped for their neighbours, which pdf.js reads straight
  out of the font's encoding (`ﻻ` instead of `لا`) — are decomposed back
  to base letters as each line is built: the text becomes searchable,
  glossary-matchable, and tokenizable by the model, and exports stop
  growing a form for every join. The decomposition is compatibility
  (NFKC) applied to the three presentation-form blocks only — never a
  blanket normalize that would rewrite micro signs and fractions in every
  LTR document. Three direction tests + one normalization test; what stays
  out of scope: bidi reordering inside a single pdf.js run, and any
  review against a real Arabic or Hebrew PDF.
- **Phase (e) — invoice form layout (type 8, the row that said ❌ and had no
  code behind it)**. The probe first: an invoice fixture written the way an
  invoicing program writes one — every cell its own show-text operator —
  driven through the real `extractPage`, and it showed the line-items table
  shattered: `Consulting hours, September` is thirteen ems, the eight-ems
  guard read a column line crossing a gutter, and the cut landed mid-row —
  one paragraph per column, quantities parted from what they quantify. The
  tie the line cannot break alone is broken by its neighbours
  (`gridRowIds` in `rowSplit.ts`): a line with at most one clause-width run
  and two or more cell boundaries whose left edges another line also starts
  runs at is a row of a grid, because a table's columns recur down the page
  and a clause's word gaps do not — prose in N columns carries N−1 clause
  spans and never reaches the recurrence test, which is the magazine
  fixture's protection. The totals carried a second defect: flattened,
  `Subtotal | Tax (8.5%) | Total Due` over its amounts reads as one short
  mathematical line, so the whole block skipped as `formula` and its labels
  went out untranslated — a table is now judged cell by cell
  (`tableDecision`), kept in the model unless every cell would be left out
  anyway, and a table of pure figures skips as `number` rather than costing
  a round trip that only echoed the digits back. Six grid tests, one
  structure test, and `fixtures/invoice.pdf` end to end through pdf.js;
  residuals: the letterhead's right-aligned address is kinded by size, and
  no PDF an invoicing program actually wrote has been reviewed. Matrix 8:
  ❌ → ✅ (with those limits).
- **Hardening: the workspace’s missing test floor**. `BlockLayer`,
  `SplitView` and `WorkspaceEditor` had no component tests, and
  `compositePage` — the paint half of every raster export — had none
  either. The block layer is pinned for positioning, translation-first
  text, click and additive selection, the inline editor’s commit and
  Escape, and its badges, with blocks seeded through the repository so
  the layer sees exactly what the app builds; the split view for its
  grouping, view modes, zoomed pane geometry, artwork fallback and
  gesture routing; the editor end to end — a click reaching the store,
  an inline edit travelling through the command stack into Dexie and
  back out under Ctrl+Z, Ctrl+F, the zoom keys, and the session’s own
  lifecycle on unmount. `react-virtuoso` renders its items flat in
  these tests: its windowing is its library’s contract and jsdom has
  no layout to measure it with. And `compositePage` now paints
  against a fake `OffscreenCanvas` that records every call — the
  white sheet, the background blit, one `fillText` per wrapped line,
  right/RTL anchoring, the list marker on the first line, jpeg
  options through to the blob, a background that will not decode, one
  unrenderable block not taking the page with it — plus both paths of
  `workerMeasurer` (canvas when one exists, the 0.52em estimate
  when it does not, which is jsdom’s own). Suite: 1468/1468.

### Fixed

- **"You are offline" is no longer claimed while the device is online** (Oct 2026): that copy
  was attached to every failure that could not be classified, so one rejected `fetch` - DNS, a
  captive portal, a firewall rule, a browser extension, the provider briefly down, or the
  translation worker crashing - told the user their connection was the problem. A rejected
  request proves nothing of the kind. `ProviderError` kinds `network`/`timeout` and the worker's
  crash handler now report a new `PROVIDER_UNREACHABLE` code (bilingual, with a "check the
  connection and retry" action and no suggestion to switch provider) unless `navigator.onLine`
  is genuinely false, and the two `translateQueue` fallbacks go through `reasonFor` instead of
  hard-coding `NETWORK_OFFLINE`. Regression suite: `src/translate/reasons.test.ts`.
- **A finished parse no longer offers Pause/Cancel forever** (Oct 2026): the job queue
  persists after every item, but the phase that ends a run is set *after* that write, so the
  stored snapshot always said `running`. On the next visit the Pages panel displayed it,
  found nothing left to re-queue - so the queue emitted no events to correct it - and offered
  two buttons that could not pause anything, over "8 / 8 pages parsed". The queue now persists
  the terminal phase (`done`/`failed`/`cancelled`) as well, the panel adopts the *live*
  snapshot when a restore re-queues no windows, and a finished parse shows an explicit
  "Parsed" badge instead of an empty toolbar. Regression suite:
  `src/components/workspace/PageThumbnails.test.tsx` (a stored `running` with no work left must
  not render the controls; a stored `running` that still has windows must).
- **Google Sheets cloud sync audited end to end — client *and* backend — and the two are now
  proven against each other instead of against a mock that could drift** (Oct 2026):
  `src/sync/appsScriptRuntime.ts` evaluates the shipped `apps-script/Code.gs` byte-for-byte
  inside an in-memory Apps Script runtime (sheets, ranges, plain-text coercion, locks, script
  properties), and two suites drive it: `appsScriptBackend.test.ts` (22 cases — handshake,
  a byte-exact round trip for every syncable entity, formula/bullet/phone lookalikes,
  last-write-wins, tombstones, deleteProject cascade incl. orphans and future-stamped rows,
  pull paging with tied timestamps across a page boundary, budget-driven partial push resuming
  from `nextCursor`, the secret-settings guard, validation, cell overflow, legacy migration
  in place, wipe, the pruned token-free SyncLog, LOCK_TIMEOUT) and `syncRealBackend.test.ts`
  (the engine end to end through the real backend: two Dexie databases, a whole document
  round trip, a delete propagating, a concurrent edit resolved with the loser recoverable
  from `syncConflicts`, wipe, and the capability handshake). Suite: 1513 passed / 6 skipped.
- **The spreadsheet stops being a JSON dump.** Three tabs carried columns that matched no
  client field and were therefore always empty, while the values they were meant to hold sat
  inside the `data` JSON: Blocks had `type` (the record calls it `kind`), Glossary had
  `source`/`target`/`note`/`locale` (the record uses `sourceTerm`/`targetTerm`/`notes`, and
  has no locale at all), UsageStats had `metric`/`value`/`projectId` (the record is
  provider/model/day plus six counters). Blocks now carry `kind`, `sourceText`,
  `translatedText`, `status`; Glossary carries `sourceTerm`, `targetTerm`, `sourceLang`,
  `targetLang`, `notes`, `caseSensitive`; UsageStats carries `provider`, `model`, `day` and
  the counters; Settings gains `group`. A person opening the sheet can read and filter what
  the app holds. `glossary.projectId` deliberately stays in `data`: a global entry carries
  `projectId: null`, and a blank cell cannot tell "global" from "empty string".
- **A deployed spreadsheet now upgrades in place instead of failing** (found by the migration
  test): schema changes are rename-in-place or append-only — the `data` column never moves.
  `createMissingSheets_` compares each header row against `LEGACY_HEADERS_`, renames the old
  columns onto their new names, appends the ones that are missing, and leaves every existing
  cell exactly where it was; `rowToRecord_` falls back to `data` for any declared column that
  is still blank, so rows written before the columns existed keep reading correctly. A
  hand-edited header row fails loudly (INTERNAL) rather than being guessed at.
- **`deleteProject` no longer orphans rows or lets a future-dated clock win**: it walks the
  whole subtree (project, pages, blocks) even when the project row itself is missing — the
  half-pushed state a crash leaves behind — and stamps each tombstone at `max(now,
  stored.updatedAt + 1)`, so a device whose clock runs ahead can never resurrect the row on
  the next pull. NOT_FOUND is reported only when nothing matched at all; deleting an already
  tombstoned project succeeds.
- **`wipe` reports what it actually cleared** (found by the real backend): the backend
  returns a per-tab count, but the client typed it as a single number and logged
  `[object Object] row(s) cleared`. `WipeResponse.cleared` is now
  `Record<string, number>`, and `wipeCloud` sums it and names the tabs in the event detail.
- **`SyncClient.backup()` used a cursor the backend cannot read**: it sent a bare number
  where Code.gs expects `{ sheetIndex, offset }`, so a paged backup walk restarted at the
  first tab every time. Typed as `BackupCursor`/`BackupResponse` and matched to
  `actionBackup_`.
- **The auto-sync switches in Settings now tell the truth**: `SyncCard` fell back to
  auto-sync off and a 15-minute interval while the engine's own defaults are on and 5
  minutes, so a fresh profile showed a scheduler that was in fact already running.
- **The SyncLog is bounded** (grows one row per request, forever): past `LOG_MAX_ROWS_`
  (15000) it is trimmed back to 5000 — one prune per 10000 requests rather than a write on
  every one — and the wipe documentation now names ApiKeys, which it does clear.
- **A reasoning model can no longer burn its whole answer on thinking** (found by the live
  harness, Oct 2026 — the biggest translation bug of the sweep): `maxOutputFor` capped the
  completion at `batch.tokens × 1.6` with a 256-token floor, and reasoning models spend
  completion tokens *before any answer token exists* — gpt-oss-120b burned a 256-token
  single-line cap entirely on reasoning and answered with an empty body. Validation saw
  `empty` at every rung of the retry ladder (batch → halve → repair → fragments), the ladder
  gave up, and 60 of 64 live-translated lines kept their English source (5 % contained
  Burmese). Two changes: the completion cap now adds `REASONING_HEADROOM_TOKENS` (2048) on
  top of the proportional size so thinking *and* translation fit, and the engine sends a
  reasoning-effort knob — `reasoning_effort` on Groq, `reasoning: {effort}` on OpenRouter —
  but only to models flagged `reasoning` in the model registry, because providers 400 on
  unknown parameters (Groq rejects a bare `reasoning` property; live-checked 11 Oct 2026).
  `High` quality asks for `medium` effort, everything else for `low`; a non-reasoning model
  simply stops at EOS and never spends the allowance. After the fix the same Groq run
  finished 3 batches in 5 requests / 78 s (was 250 requests / 568 s with the ladder burning
  out), 83 % of the translations contained Burmese (was 5 %), and kept-original fell from ×60
  to zero.
- **Groq's chain drops a retired preview**: `qwen/qwen3.6-27b` answered 404 on 11 Oct 2026
  (Groq retires previews at short notice); the chain now leads gpt-oss-120b → gpt-oss-20b →
  qwen3.8-27b, all live, and the entry notes why.
- **A routine TPM 429 can no longer park a healthy key for an hour** (found by the live
  harness, Oct 2026): one `resetAt` was read off the *requests* header family — which Groq
  stamps `1h6m14.4s` on every response — and `applyRateInfo` fed it into the *token* bucket.
  Once real usage crossed the free tier's 8000 TPM, the pool refused the key until the
  requests window rolled while the token window (`x-ratelimit-reset-tokens: 1.027s`) was
  ignored: a run that flew for 23 lines then sat silent. `RateLimitInfo` now carries
  `tokensResetAt` from the token-family headers, the TPM bucket is paced by that alone, and
  for a non-quota 429 the same server deadline caps the exponential backoff (floor 1s) —
  a streak of rejections no longer parks a key for minutes when the server says the window
  rolls in a second. `Retry-After` stays authoritative and is never shortened.
- **A 403 no longer condemns the key.** `unauthorized` and `forbidden` shared one switch arm,
  so OpenRouter's model-gate 403 ("only available on agentic harnesses" — a *model* refusal,
  not a credential refusal) poisoned the only healthy key and ended the run with "every
  configured key was rejected". 401 stays the dead-key signal; 403 now walks the fallback
  chain like a 404 and only marks the key invalid once every model has been refused.
- **"Test key" can no longer bless a revoked OpenRouter key.** OpenRouter answers
  `GET /models` without any credential, so the old probe reported `ok — 458 models` for a
  dead key. The adapter config takes an optional `authProbePath`; OpenRouter uses its
  authenticated, free `GET /auth/key`, which answers 200 for a live key and 401 for the dead
  one. Groq and OpenAI already authenticate `/models` and keep the old probe.
- **OpenRouter's bundled chain no longer leads with a model this app may not call.**
  `thinkingmachines/inkling:free` headed the fallback chain — and so was the default model
  for new runs — but it is gated to agentic harnesses, so every run paid a 403 before
  anything else. The chain now leads with `nvidia/nemotron-3-super-120b-a12b:free` (200 on a
  live probe), keeps the other nvidia free routes, and leaves the two gemma routes last:
  their free pool rate-limits upstream sometimes, which the 429 path rides out.
- **The smoke script stops racing itself**: the IndexedDB row check polls briefly for the
  settings/events writes the route pass fires in the background (a single-shot read saw
  zero rows with a healthy app under CPU load), the undo-drain check drains a stack the
  bold-toggle retry may have filled rather than assuming exactly one entry, and the Chrome
  profile cleanup retries the `EPERM` instead of throwing out of `finally` and crashing an
  otherwise-passing run.

### Security

- Settings rows whose id or field looks like a credential (`key`, `token`, `secret`,
  `password`, `authorization`) are filtered out client-side and rejected server-side with
  `SECRET_NOT_ALLOWED`, on whatever toggles are set — `sync.tokens` and friends can never
  travel. The guard covers the `Settings` tab; a *boolean* value is never treated as a
  credential, so the `apiKeys: true` switch inside `sync.entities` is not caught by it.
- **Provider keys sync only if you ask for it.** A separate, off-by-default **API keys** switch
  writes each key's readable value to the `ApiKeys` tab of your own Sheet; the UI states that
  plainly before it is switched on. Only identifying fields travel (provider, label, models,
  enabled, last four, secret, createdAt) — counters, cooldowns and probe results stay local so
  one device cannot clobber another's. The sealed payload is opened while the request is built,
  so no readable secret reaches IndexedDB, the outbox or a log line; a delete tombstone carries
  no payload; and an incoming key is re-sealed locally before storage, with a remote `cipher`
  never trusted.
- The sync token is stored sealed, shown only as its last four characters, and is never
  written to logs.
- **A synced document can no longer write a formula into your Sheet.** Sheets parses a cell on
  the way in, so a block whose text opened with `=IMPORTDATA(...)` would have become a live
  formula that phones home from the reader's own spreadsheet — and an equation page, a hyphen
  bullet, a phone number or a date all trip the same parse as ordinary content. Every
  request-derived value now goes through `writePlain_`, which formats the destination range as
  Plain Text before `setValues`, so the parse never happens. Unlike the usual apostrophe-prefix
  mitigation nothing is added to or stripped from the value, so a hyphen bullet survives the
  round trip exactly. `src/sync/appsScript.test.ts` reads `Code.gs` and fails if a data write
  ever bypasses the helper again.

## 0.1.0 — initial release

Phases 1–4: the local-first application, PDF import, the translation engine and export.

### Added

- **Phase 1 — document model and editor**
  - Projects → pages → blocks model on Dexie (IndexedDB) with versioned schema migrations.
  - Block editor with undo/redo history, find & replace, split view, block inspector,
    revisions and templates.
  - Bilingual UI (English + Myanmar) via react-i18next, light/dark/system theme, responsive
    layout from desktop down to a mobile bottom tab bar.
  - Settings (General, Cache, Data, Providers, Assistant, About) and a Logs page with
    machine-readable reason codes, suggested fixes and JSON export.
  - Event/state model: every state change emits
    `{timestamp, state, pageIndex, lineIndex, reasonCode, messageMy, messageEn,
    technicalDetail, fixActions[]}`.
- **Phase 2 — PDF import and analysis**
  - PDF pick with pre-flight validation (password-protected, corrupt, too large, too many
    pages, no text layer) and a password prompt with retry.
  - pdf.js parsing in a Web Worker: page rendering, layout extraction into blocks, line
    grouping, page classification, thumbnails and a render cache.
  - OCR (tesseract.js) for scanned pages with offline language packs, plus document metadata.
- **Phase 3 — translation engine**
  - BYOK providers: Google Gemini, OpenRouter, Groq and any OpenAI-compatible endpoint, with
    model discovery and a bundled fallback model list.
  - Sealed API-key storage (WebCrypto AES-GCM + PBKDF2) with device-bound or passphrase vault
    modes, a key pool with rotation, cooldowns and rate-limit buckets.
  - Batching of 15–25 lines or ~1500 tokens, a repair ladder that halves a failing batch then
    falls back to line-by-line without dropping or reordering lines, adaptive concurrency
    (AIMD), glossary/terminology enforcement, translation memory, confidence and quality flags.
  - Job queue with pause/resume/cancel and resume-after-refresh; usage statistics.
- **Phase 4 — export and data**
  - Exporters: DOCX, EPUB, PDF via print, raster PDF, bilingual PDF, HTML, Markdown, TXT,
    JSON, CSV/TSV and zipped per-page images, built in an export worker with progress.
  - JSON backup / restore for every table (API keys travel sealed; PDF bytes are excluded).
  - Usage charts, writing assistant toggle, knowledge/glossary UI with CSV import.

### Security

- API keys are sealed with WebCrypto before storage, opened only inside the translation
  worker, never synced and never exported in plaintext.
- HTML paths are gated through DOMPurify (`src/editor/sanitize.ts`) or `escapeHtml`; the app
  ships no `dangerouslySetInnerHTML`.
- No telemetry or analytics of any kind; all data stays in the browser unless the user turns
  on cloud sync.

