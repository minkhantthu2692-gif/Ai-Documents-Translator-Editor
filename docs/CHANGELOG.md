# Changelog

Notable changes to **AI Documents Translator & Editor**, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Dates are only added when a release is actually
cut — everything under `Unreleased` is work in progress on `main`.

## [Unreleased]

Phase 5 — cloud sync and the troubleshooting assistant.

### Added

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

