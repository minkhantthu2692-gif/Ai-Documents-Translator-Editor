# PDF translator sidecar

A local Python HTTP sidecar for the browser-based PDF translator. It exposes
four JSON endpoints over raw PDF bytes so the frontend can classify, extract
and OCR documents with PyMuPDF / pdfplumber / tesseract — stdlib HTTP only
(`http.server.ThreadingHTTPServer`), no Flask/FastAPI.

- Base URL: `http://localhost:8790`
- Protocol: **v1** (the frontend calls exactly the routes below)
- All responses: `Content-Type: application/json; charset=utf-8`
  (`json.dumps(..., ensure_ascii=False)`)
- All `POST` endpoints take the **raw PDF bytes as the request body**
  (`Content-Type: application/octet-stream` or `application/pdf`) plus query
  parameters.

## Run

Python 3.12 is **not** on `PATH` in this environment — always use the full
path in PowerShell:

```powershell
# start the server (default http://127.0.0.1:8790)
& "C:\Users\minkh\AppData\Local\Programs\Python\Python312\python.exe" "D:\doc translator\sidecar\server.py"

# sanity check
Invoke-WebRequest -Uri http://localhost:8790/health -UseBasicParsing
```

Dependencies (already installed — see `requirements.txt`):
`pymupdf 1.28.2`, `pdfplumber 0.11.10`, `pytesseract 0.3.13` (+ Pillow),
tesseract binary at `C:\Program Files\Tesseract-OCR\tesseract.exe` with
tessdata (`eng`, `osd`, `mya`) in `C:\Users\minkh\AppData\Local\Tesseract-OCR\tessdata`.

## Test

```powershell
& "C:\Users\minkh\AppData\Local\Programs\Python\Python312\python.exe" "D:\doc translator\sidecar\test_sidecar.py"
```

`test_sidecar.py` generates its PDF fixtures on the fly (PyMuPDF, temp dir),
starts the server in-process on a free port, exercises every endpoint and
prints `N tests, all passed`. Exit code is `0` on success, `1` on failure.

## Environment variables

| Variable          | Default                 | Effect |
|-------------------|-------------------------|--------|
| `PORT`            | `8790`                  | Listen port. |
| `HOST`            | `127.0.0.1`             | Bind address (`0.0.0.0` to expose on the LAN). |
| `ALLOWED_ORIGIN`  | `http://localhost:5173` | Extra CORS origin added to the allowlist. |
| `SIDECAR_DEBUG`   | *(unset)*               | Set to `1` to log requests to stderr. |
| `TESSDATA_PREFIX` | auto-set at startup     | Set to `C:\Users\minkh\AppData\Local\Tesseract-OCR\tessdata` **before any pytesseract call** when that directory exists, so Burmese (`mya`) OCR works. |

**CORS** — `Access-Control-Allow-Origin` echoes the request `Origin` when it is
in `{http://localhost:5173, http://127.0.0.1:5173, ALLOWED_ORIGIN}`; other
origins get no CORS header. `OPTIONS` preflight answers `204` with
`Access-Control-Allow-Methods: GET, POST, OPTIONS` and
`Access-Control-Allow-Headers: content-type`.

## Endpoints

### `GET /health`

```json
{"ok": true, "version": "0.1.0", "python": "3.12.x",
 "libs": {"fitz": true, "pdfplumber": true, "pytesseract": true},
 "tesseract": {"available": true, "langs": ["eng", "mya", "osd"]}}
```

`libs` = whether the import succeeded; `tesseract.available` = whether
`tesseract --version` works; `langs` from `--list-langs` (best effort, `[]` on
failure). OCR probing is fully guarded — `/health` can never crash on a
missing/broken tesseract; it degrades to `{"available": false, "langs": []}`.

### `POST /classify?password=&pages=`

Query parameters:

| Param      | Format              | Default      |
|------------|---------------------|--------------|
| `password` | string              | *(none)*     |
| `pages`    | `0-11,14` (0-based, inclusive) | all pages |

```json
{"ok": true,
 "pages": [{"index": 0, "width": 612.0, "height": 792.0, "rotation": 0,
            "charCount": 123, "textCoverage": 0.04, "imageCount": 1,
            "contentClass": "text",
            "complexity": {"score": 0.1, "reasons": [], "complex": false}}],
 "summary": {"tally": {"text": 1, "scanned": 0, "mixed": 0, "complex": 0, "empty": 0},
             "textLayerPages": 1, "ocrNeededPages": 0, "complexPages": 0}}
```

- `charCount` — non-whitespace characters in the text layer.
- `textCoverage` — sum of text-run bounding-box areas ÷ page area, capped at 1
  (sum of span `w×h` from `pymupdf get_text("dict")`; overlapping runs may
  overcount, hence the cap). Rounded to 4 decimals.
- `imageCount` — embedded XObjects (`get_images(full=True)`) and placed/inline
  images (`get_image_info()`), taking the larger count.
- `contentClass` rules (mirrors `src/pdf/pageClassify.ts`):
  `hasText = charCount >= 8 && textCoverage >= 0.002`.
  If `hasText`: `complex` when `complexity.complex`, else `mixed` when
  `imageCount > 0`, else `text`. Otherwise: `scanned` when images exist, else
  `text` for stray characters, else `empty`.
- `complexity` — score 0..1 (2 decimals) + reasons, computed from PyMuPDF data:
  `columns3` +0.5 (≥3 text columns detected by recursively splitting at wide,
  low-crossing x-gutters; `multicolumn` +0.1 for exactly 2), `overlap` +0.45
  (≥12% of lines overlap another line by ≥15% of the smaller box), `rotation`
  +0.3 / +0.1 (≥25% of lines tilted >5°, else a non-zero page rotation),
  `size-spread` +0.15 (largest ÷ median font ≥ 3), `tables` +0.1 (≥4
  table-like rows), `images` +0.1 (≥4 images). `complex = score >= 0.45`.
- `summary.textLayerPages = tally.text + tally.mixed + tally.complex`,
  `ocrNeededPages = tally.scanned`, `complexPages = tally.complex`.

### `POST /extract?password=&pages=&mode=auto|text`

`mode` defaults to `auto`.

```json
{"ok": true, "ms": 123,
 "pages": [{"index": 0, "width": 612.0, "height": 792.0, "rotation": 0,
            "extractionMethod": "text", "contentClass": "text",
            "blocks": [{
                "order": 0, "kind": "paragraph", "region": "body",
                "text": "...", "bbox": {"x": 72, "y": 135, "w": 300, "h": 14},
                "fontSize": 12.0, "fontFamily": "Helvetica",
                "alignment": "left", "skipRule": null, "listMarker": null,
                "lines": [{"text": "...", "bbox": {"x": 72, "y": 135, "w": 300, "h": 14},
                           "fontFamily": "Helvetica", "fontSize": 12.0,
                           "bold": false, "italic": false, "color": "#000000",
                           "rotation": 0}],
                "table": null}]}]}
```

Behaviour:

- **Coordinates** are top-left origin, `page.rect` display space (page rotation
  applied) — the same convention as the frontend. Boxes are rounded to 2dp.
- **Extraction**: `page.get_text("dict", sort=True)` → spans → lines → blocks.
  Bold/italic from the font name (`bold|black|heavy|semibold` /
  `italic|oblique`), colour from the span colour int → `#rrggbb`, subset
  prefixes stripped (`ABCDEF+Font` → `Font`).
- **Reading order** is column-aware: gutters are detected on the span x-extents
  (same sweep as `/classify`, capped at 4 columns), blocks are assigned to a
  column by centre x, then ordered left column → next column, top-to-bottom
  inside a column.
- **region** — `header` when the block top is above 8% of the page height,
  `footer` below 92%, and the text is ≤ 120 chars; otherwise `body`.
- **kind** — `heading`: ≤ 80 chars, block font size ≥ 1.35× the body median and
  no trailing period; `list`: first line starts with a bullet/number marker
  (`listMarker` holds the marker); `caption`: ≤ 120 chars starting with
  `Figure|Fig.|Table|Image`; `table`: blocks produced from pdfplumber;
  otherwise `paragraph`.
- **alignment** — `center` when the block centre is within 5% of the page
  centre *and* the block is narrower than 60% of the page; `right` when the
  right edge is within 5% of the right margin *and* the left edge starts past
  40% of the page; otherwise `left`.
- **fontSize** = median of the block's line sizes, **fontFamily** = most
  common family.
- **Tables (pdfplumber)** — each page also runs `page.find_tables()`; every
  found table becomes one `kind: "table"` block with
  `table: {"rows": [[cell, ...], ...]}` (`None` cells → `""`) and `lines: []`,
  and any pymupdf text block lying inside the table bbox is removed so text is
  never duplicated. If pdfplumber cannot import/open/parse the file or
  `find_tables` throws, extraction degrades to plain text blocks (no tables).
- **extractionMethod** (from `contentClass`):
  `text`/`complex` → `"text"`, `mixed` → `"hybrid"`, `scanned` → `"ocr"`,
  `empty` → `"none"`.
  - Scanned page + `mode=auto` + tesseract available → page rendered at
    **300 DPI**, OCR'd via `pytesseract.image_to_data`, words grouped into
    lines by baseline proximity (~half x-height, left-to-right), synthesised
    into `fontFamily: "OCR"` lines/blocks.
  - Scanned page + tesseract unavailable → `blocks: []`,
    `extractionMethod: "ocr"`, `"ocrAvailable": false` (the flag appears on
    scanned pages only).
  - `mode=text` → pure text extraction; scanned pages return `blocks: []`
    (no OCR) regardless of availability.

### `POST /ocr?password=&page=0&lang=eng,mya`

Single-page OCR (page is a 0-based index, default `0`), rendered at 300 DPI.

```json
{"ok": true, "page": 0, "text": "line one\nline two", "confidence": 87.2,
 "lines": [{"text": "line one", "bbox": {"x": 72.1, "y": 118.4, "w": 41.2, "h": 15.8},
            "confidence": 91.4}],
 "words": [{"text": "line", "bbox": {"x": 72.1, "y": 118.4, "w": 41.2, "h": 15.8}}],
 "ms": 456}
```

- `confidence` — mean word confidence (0 when unavailable); `words` includes
  every tesseract word with `conf >= 0`, rectangles in page points.
- `lines` — the same recognition grouped into lines (union of the member word
  rects, `text` joined with single spaces, `confidence` the mean of the
  member words). This is what the frontend reads: its structure pass filters
  lines against a confidence floor, and word-level confidence alone would
  force it to re-do this grouping client-side. Empty lines are omitted, so
  `text` and `lines` always agree. Added in phase b2 — additive, so older
  clients that only read `words` are unaffected.
- `lang` — comma list passed to tesseract; each token is validated against the
  installed languages (unknown token → `400 BAD_REQUEST` listing the available
  ones).
- Validation order: page format → document open (password) → page range →
  OCR capability → language, so a locked PDF always answers
  `PASSWORD_REQUIRED` even when OCR is missing.

## Errors

All errors share one shape:

```json
{"ok": false, "code": "PASSWORD_REQUIRED", "message": "..."}
```

| Status | Code | When |
|--------|------|------|
| 400 | `BAD_REQUEST` | Empty body, bad `mode`, non-integer `page`, unknown OCR language, malformed `Content-Length`/chunked body. |
| 400 | `PASSWORD_REQUIRED` | PDF needs a password or the password is wrong (never a 500). |
| 400 | `PAGE_RANGE` | `pages` malformed/out of range, or `/ocr` page index outside the document. |
| 400 | `UNSUPPORTED` | Request body could not be opened as a PDF. |
| 404 | `NOT_FOUND` | Unknown path (any method). |
| 413 | `PAYLOAD_TOO_LARGE` | Body larger than 200 MB (checked before reading; connection is closed). |
| 500 | `NOT_AVAILABLE` | Capability missing — e.g. tesseract/OCR not available for `/ocr`. |
| 500 | `INTERNAL` | Unexpected failure; `message` carries the exception detail (tracebacks go to the server console, never to the client). |

Notes on protocol corners where v1 did not pin a value:

- `404` and `413` needed codes — `NOT_FOUND` and `PAYLOAD_TOO_LARGE` are used
  (the v1 code list only covered 400/500 cases).
- `UNSUPPORTED` is reserved for "this body is not an openable PDF".
- `alignment` never emits `justified` (v1 rules only yield left/center/right).

## Capability / fallback summary

- **OCR missing** — `/health` reports `tesseract.available: false` (never
  crashes); `/ocr` answers `500 NOT_AVAILABLE`; `/extract` still returns
  scanned pages with `extractionMethod: "ocr"`, `blocks: []` and
  `ocrAvailable: false`; classification is unaffected.
- **pdfplumber missing/failing** — `/extract` skips tables entirely; text
  extraction continues. Table detection uses pdfplumber's default (ruling-line)
  strategy, so *ruled* tables get cell geometry; borderless tables fall back to
  the normal text blocks.
- **pymupdf missing** — document endpoints answer `500 NOT_AVAILABLE`.
- **Encrypted PDFs** — handled by every endpoint via the optional `password`
  query parameter (`doc.authenticate`); wrong/missing passwords are always
  `400 PASSWORD_REQUIRED`.
- **Burmese OCR** — `TESSDATA_PREFIX` is pointed at the extra tessdata dir at
  startup, so `lang=mya` works when `mya` is listed in `/health`.
- **Big requests** — bodies over 200 MB are rejected with `413` before the
  server reads them.
