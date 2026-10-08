#!/usr/bin/env python
"""
Local HTTP sidecar for the browser-based PDF translator.

A stdlib-only ``ThreadingHTTPServer`` exposing four endpoints the frontend
calls with raw PDF bytes in the request body:

    GET  /health    capability probe (libraries, tesseract, languages)
    POST /classify  per-page content classification + layout complexity
    POST /extract   ordered blocks/lines (text layer, pdfplumber tables, OCR)
    POST /ocr       single-page OCR via tesseract

Run::

    python server.py            # PORT / HOST / ALLOWED_ORIGIN env override

Protocol v1 (all responses are ``application/json; charset=utf-8``,
errors are ``{"ok": false, "code": "...", "message": "..."}``):

    400 BAD_REQUEST        malformed request (mode, page index, empty body …)
    400 PASSWORD_REQUIRED  PDF is encrypted and the password is missing/wrong
    400 PAGE_RANGE         ``pages`` parameter malformed or out of range
    400 UNSUPPORTED        body could not be opened as a PDF
    400 NOT_FOUND          unknown path
    413 PAYLOAD_TOO_LARGE  body larger than 200 MB
    500 NOT_AVAILABLE       capability missing (e.g. OCR/tesseract)
    500 INTERNAL           unexpected failure (detail in ``message``)
"""

from __future__ import annotations

import io
import json
import math
import os
import platform
import re
import shutil
import sys
import time
import traceback
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# --------------------------------------------------------------------------
# Environment bootstrap — must happen before any pytesseract call so the
# extra tessdata (eng, osd, mya) is picked up and Burmese OCR works.
# --------------------------------------------------------------------------

DEFAULT_TESSDATA_DIR = os.path.join(
    r"C:\Users\minkh\AppData\Local", "Tesseract-OCR", "tessdata"
)
DEFAULT_TESSERACT_EXE = os.path.join(
    r"C:\Program Files", "Tesseract-OCR", "tesseract.exe"
)

if os.path.isdir(DEFAULT_TESSDATA_DIR):
    os.environ["TESSDATA_PREFIX"] = DEFAULT_TESSDATA_DIR

# Third-party imports are guarded: /health reports what failed instead of
# crashing, and endpoints degrade (or refuse with NOT_AVAILABLE).
try:  # pragma: no cover - import guard
    import pymupdf
except Exception:  # pragma: no cover - import guard
    pymupdf = None

try:  # pragma: no cover - import guard
    import pdfplumber
except Exception:  # pragma: no cover - import guard
    pdfplumber = None

try:  # pragma: no cover - import guard
    import pytesseract
except Exception:  # pragma: no cover - import guard
    pytesseract = None

if (
    pytesseract is not None
    and shutil.which("tesseract") is None
    and os.path.isfile(DEFAULT_TESSERACT_EXE)
):
    # Bare `python` is not on PATH here; point pytesseract at the binary.
    pytesseract.pytesseract.tesseract_cmd = DEFAULT_TESSERACT_EXE

FITZ_OK = pymupdf is not None
PDFPLUMBER_OK = pdfplumber is not None
PYTESSERACT_OK = pytesseract is not None

# --------------------------------------------------------------------------
# Protocol constants (protocol v1)
# --------------------------------------------------------------------------

VERSION = "0.1.0"
DEFAULT_PORT = 8790
DEFAULT_HOST = "127.0.0.1"
DEFAULT_ORIGIN = "http://localhost:5173"
BASELINE_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}

MAX_BODY = 200 * 1024 * 1024  # 200 MB
OCR_DPI = 300

# Page classification thresholds — mirror src/pdf/pageClassify.ts.
MIN_TEXT_CHARS = 8
MIN_TEXT_COVERAGE = 0.002

# Layout-complexity weights/thresholds — mirror src/pdf/layoutComplexity.ts.
COMPLEX_THRESHOLD = 0.45
OVERLAP_PAIR_SHARE = 0.15
OVERLAP_MIN_RATIO = 0.12
ROTATED_MIN_RATIO = 0.25
TABLE_MIN_ROWS = 4
SIZE_SPREAD_MIN = 3
IMAGE_MIN_COUNT = 4
MAX_COLUMNS = 4
MIN_COLUMN_ITEMS = 8

WEIGHTS = {
    "columns3": 0.5,
    "multicolumn": 0.1,
    "overlap": 0.45,
    "rotation": 0.3,
    "rotationPageOnly": 0.1,
    "size-spread": 0.15,
    "tables": 0.1,
    "images": 0.1,
}

# Extraction heuristics — mirror src/pdf/structure.ts + protocol spec.
REGION_BAND = 0.08  # header above 8% / footer below 92% of page height
REGION_TEXT_MAX = 120  # only short text can live in the header/footer bands
HEADING_MAX_CHARS = 80
HEADING_SIZE_RATIO = 1.35
CAPTION_MAX_CHARS = 120

BOLD_RE = re.compile(r"bold|black|heavy|semibold", re.IGNORECASE)
ITALIC_RE = re.compile(r"italic|oblique", re.IGNORECASE)
LIST_MARKER_RE = re.compile(r"^([•‣▪◦●⁃\-–—]|\(?\d{1,4}[.)])\s+")
CAPTION_RE = re.compile(r"^(?:Figure|Fig\.|Table|Image)\b", re.IGNORECASE)

CONTENT_CLASSES = ("text", "scanned", "mixed", "complex", "empty")


class ApiError(Exception):
    """Client-facing error carrying an HTTP status and a protocol code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def allowed_origins():
    """Origins allowed by CORS: the two dev-server defaults + ALLOWED_ORIGIN."""
    return BASELINE_ORIGINS | {os.environ.get("ALLOWED_ORIGIN", DEFAULT_ORIGIN)}


# --------------------------------------------------------------------------
# Capability probing — /health must never crash, so every probe degrades.
# --------------------------------------------------------------------------

_TESSERACT_STATE = {"checked": 0.0, "info": None}


def tesseract_info():
    """Return {"available": bool, "langs": [str], "version": str}.

    Successes are cached forever; failures are retried every 5 seconds so a
    late-starting tesseract install is picked up without hammering the binary.
    """
    state = _TESSERACT_STATE
    cached = state["info"]
    now = time.monotonic()
    if cached is not None and (cached["available"] or now - state["checked"] < 5.0):
        return cached

    result = {"available": False, "langs": [], "version": ""}
    if PYTESSERACT_OK:
        try:
            result["version"] = str(pytesseract.get_tesseract_version())
            result["available"] = True
        except Exception:
            result = {"available": False, "langs": [], "version": ""}
        else:
            try:
                langs = [
                    str(lang).strip()
                    for lang in pytesseract.get_languages(config="")
                    if str(lang).strip()
                ]
                result["langs"] = sorted(langs)
            except Exception:
                result["langs"] = []
    state["info"] = result
    state["checked"] = now
    return result


def ocr_available() -> bool:
    """True when tesseract can actually run on this machine."""
    return bool(tesseract_info()["available"])


def default_ocr_lang() -> str:
    """Best tesseract language string for automatic page OCR."""
    langs = tesseract_info()["langs"]
    if "eng" in langs:
        return "eng"
    if langs:
        return langs[0]
    return "eng"


def health_payload() -> dict:
    """GET /health body — never raises."""
    try:
        libs = {
            "fitz": FITZ_OK,
            "pdfplumber": PDFPLUMBER_OK,
            "pytesseract": PYTESSERACT_OK,
        }
    except Exception:  # pragma: no cover - defensive
        libs = {"fitz": False, "pdfplumber": False, "pytesseract": False}
    try:
        tess = tesseract_info()
    except Exception:  # pragma: no cover - OCR probing must never crash /health
        tess = {"available": False, "langs": []}
    return {
        "ok": True,
        "version": VERSION,
        "python": platform.python_version(),
        "libs": libs,
        "tesseract": {
            "available": bool(tess.get("available", False)),
            "langs": list(tess.get("langs") or []),
        },
    }


# --------------------------------------------------------------------------
# Geometry helpers (top-left origin, page.rect space, rotation applied)
# --------------------------------------------------------------------------


def rotation_matrix(page):
    """Matrix mapping unrotated extraction coordinates into page.rect space.

    PyMuPDF returns text coordinates of the *unrotated* page while
    ``page.rect`` reflects ``/Rotate``; multiplying by ``rotation_matrix``
    puts both in the display space the frontend uses. Identity (None) for
    upright pages.
    """
    try:
        if int(page.rotation or 0) % 360 == 0:
            return None
        return page.rotation_matrix
    except Exception:  # pragma: no cover - defensive
        return None


def map_rect(page, bbox, matrix):
    """Map an unrotated (x0, y0, x1, y1) box into display/page space."""
    x0, y0, x1, y1 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    if matrix is None:
        return (x0, y0, x1, y1)
    rect = pymupdf.Rect(x0, y0, x1, y1) * matrix
    return (rect.x0, rect.y0, rect.x1, rect.y1)


def rect_dict(rect) -> dict:
    """Public {"x","y","w","h"} box, rounded to 2 decimals."""
    x0, y0, x1, y1 = rect
    return {
        "x": round(float(x0), 2),
        "y": round(float(y0), 2),
        "w": round(max(0.0, float(x1) - float(x0)), 2),
        "h": round(max(0.0, float(y1) - float(y0)), 2),
    }


def line_tilt(direction, page_rotation: float) -> float:
    """Tilt of a text line from horizontal, folded into [-90, 90)."""
    dx, dy = 1.0, 0.0
    if direction and len(direction) >= 2:
        try:
            dx, dy = float(direction[0]), float(direction[1])
        except (TypeError, ValueError):
            dx, dy = 1.0, 0.0
    if dx == 0.0 and dy == 0.0:
        return 0.0
    angle = math.degrees(math.atan2(dy, dx)) + float(page_rotation or 0)
    return (angle + 90.0) % 180.0 - 90.0


def median(values):
    """Median of a non-empty list of numbers (0.0 for an empty list)."""
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return float(ordered[middle - 1] + ordered[middle]) / 2.0


def dominant_value(values):
    """Most frequent value (first wins ties)."""
    values = [v for v in values if v]
    if not values:
        return ""
    return Counter(values).most_common(1)[0][0]


# --------------------------------------------------------------------------
# Column detection — item-level gutter sweep mirroring layoutComplexity.ts
# --------------------------------------------------------------------------


def best_gutter(boxes, page_width):
    """Widest low-crossing empty x-band, or None.

    ``boxes`` are (x, w) extents of raw text runs. The band must be at least
    ``max(6pt, 2% of page width)`` wide, carry ≥3 runs on each side and be
    crossed by at most ``max(2, 10% of runs)`` runs (headers/watermarks).
    """
    if len(boxes) < MIN_COLUMN_ITEMS or page_width <= 0:
        return None
    min_gap = max(6.0, page_width * 0.02)
    events = []
    for x, w in boxes:
        if w <= 0:
            continue
        events.append((float(x), True))
        events.append((float(x) + float(w), False))
    # At equal coordinates a closing run goes first so touching runs do not
    # count as crossing the band between them.
    events.sort(key=lambda event: (event[0], 0 if not event[1] else 1))

    total = len(events)
    active = opened = closed = 0
    best = None
    max_crossings = max(2, len(boxes) // 10)
    index = 0
    while index < total:
        start = events[index][0]
        while index < total and events[index][0] == start:
            if events[index][1]:
                active += 1
                opened += 1
            else:
                active -= 1
                closed += 1
            index += 1
        if index >= total:
            break
        width = events[index][0] - start
        on_left = closed
        on_right = len(boxes) - opened
        if (
            width >= min_gap
            and on_left >= 3
            and on_right >= 3
            and active <= max_crossings
        ):
            candidate = (start + width / 2.0, width, active)
            if (
                best is None
                or active < best[2]
                or (active == best[2] and width > best[1])
            ):
                best = candidate
    return best


def _split_boxes(boxes, page_width):
    """Recursive best-gutter splitting → list of (position, gutter width)."""
    if len(boxes) < MIN_COLUMN_ITEMS:
        return []
    gutter = best_gutter(boxes, page_width)
    if not gutter:
        return []
    position = gutter[0]
    left = [b for b in boxes if b[0] + b[1] / 2.0 <= position]
    right = [b for b in boxes if b[0] + b[1] / 2.0 > position]
    if len(left) < 3 or len(right) < 3:
        return []
    return (
        _split_boxes(left, page_width)
        + [(position, gutter[1])]
        + _split_boxes(right, page_width)
    )


def count_columns(boxes, page_width, max_columns=MAX_COLUMNS) -> int:
    """Text column count (1..max_columns) from raw run boxes."""
    if max_columns <= 1 or page_width <= 0:
        return 1
    return min(len(_split_boxes(boxes, page_width)) + 1, max_columns)


def split_positions(boxes, page_width, max_columns=MAX_COLUMNS):
    """Gutter x positions defining the reading-order columns (≤ max_columns)."""
    splits = _split_boxes(boxes, page_width)
    if len(splits) + 1 > max_columns:
        splits = sorted(splits, key=lambda entry: -entry[1])[: max_columns - 1]
    return sorted(position for position, _width in splits)


# --------------------------------------------------------------------------
# Layout complexity + page classification — mirror pageClassify/layoutComplexity
# --------------------------------------------------------------------------


def overlap_ratio(rects) -> float:
    """Share of lines whose box overlaps another line's box by ≥15% of the
    smaller box; overlap only counts once ≥12% of lines are involved."""
    total = len(rects)
    if total < 2:
        return 0.0
    involved = set()
    for i in range(total - 1):
        ax0, ay0, ax1, ay1 = rects[i]
        area_a = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
        if area_a <= 0:
            continue
        for j in range(i + 1, total):
            bx0, by0, bx1, by1 = rects[j]
            inter_w = min(ax1, bx1) - max(ax0, bx0)
            if inter_w <= 0:
                continue
            inter_h = min(ay1, by1) - max(ay0, by0)
            if inter_h <= 0:
                continue
            area_b = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
            smaller = min(area_a, area_b)
            if smaller > 0 and inter_w * inter_h >= smaller * OVERLAP_PAIR_SHARE:
                involved.add(i)
                involved.add(j)
    return len(involved) / total


def looks_like_table_row(text: str) -> bool:
    """Short cells separated by wide gaps — the text-level table row pattern."""
    parts = [part for part in re.split(r"\s{2,}|\t", text) if part.strip()]
    if len(parts) < 2:
        return False
    cells = [part.strip() for part in parts]
    all_short = all(len(cell) <= 60 for cell in cells)
    wide_gap = bool(re.search(r"\s{3,}|\t", text)) or "  " in text
    return all_short and wide_gap and len(cells) >= 2


def analyze_complexity(width, rotation, span_boxes, lines, image_count) -> dict:
    """Score layout signals into {"score", "reasons", "complex"} (0..1, 2dp)."""
    columns = count_columns(span_boxes, width, MAX_COLUMNS)
    rects = [line["rect"] for line in lines]
    overlap = overlap_ratio(rects)
    rotated = (
        sum(1 for line in lines if abs(line["tilt"]) > 5) / len(lines)
        if lines
        else 0.0
    )
    table_rows = sum(1 for line in lines if looks_like_table_row(line["text"]))
    sizes = [line["size"] for line in lines if line["size"] > 0]
    median_size = median(sizes)
    largest = max(sizes) if sizes else 0
    size_ratio = (largest / median_size) if median_size > 0 and largest > 0 else 1.0

    reasons = []
    score = 0.0

    def add(reason, weight):
        nonlocal score
        score += weight
        if reason not in reasons:
            reasons.append(reason)

    if columns >= 3:
        add("columns3", WEIGHTS["columns3"])
    elif columns == 2:
        add("multicolumn", WEIGHTS["multicolumn"])
    if overlap >= OVERLAP_MIN_RATIO:
        add("overlap", WEIGHTS["overlap"])
    if rotated >= ROTATED_MIN_RATIO:
        add("rotation", WEIGHTS["rotation"])
    elif int(rotation or 0) % 360 != 0:
        add("rotation", WEIGHTS["rotationPageOnly"])
    if size_ratio >= SIZE_SPREAD_MIN:
        add("size-spread", WEIGHTS["size-spread"])
    if table_rows >= TABLE_MIN_ROWS:
        add("tables", WEIGHTS["tables"])
    if image_count >= IMAGE_MIN_COUNT:
        add("images", WEIGHTS["images"])

    return {
        "score": round(min(1.0, score), 2),
        "reasons": reasons,
        "complex": score >= COMPLEX_THRESHOLD,
    }


def classify_content(char_count, coverage, image_count, complexity) -> str:
    """hasText = ≥8 chars AND ≥0.2% coverage; complex outranks mixed."""
    has_text = char_count >= MIN_TEXT_CHARS and coverage >= MIN_TEXT_COVERAGE
    if has_text:
        if complexity.get("complex"):
            return "complex"
        return "mixed" if image_count > 0 else "text"
    if image_count > 0:
        return "scanned"
    return "text" if char_count > 0 else "empty"


def count_images(page) -> int:
    """Embedded XObjects and placed/inline images (max of both views)."""
    embedded = 0
    try:
        embedded = len(page.get_images(full=True))
    except Exception:
        embedded = 0
    placed = 0
    try:
        placed = len(page.get_image_info())
    except Exception:
        placed = 0
    return max(embedded, placed)


def page_signals(page, index) -> dict:
    """Classify-level signals for one page (also feeds /extract).

    Runs a single ``get_text("dict", sort=True)`` pass and derives:
    char count, text coverage, span x-extents (for column gutters), line
    boxes/sizes/tilts (for complexity) and the text dict for extraction.
    """
    matrix = rotation_matrix(page)
    rotation = int(page.rotation or 0)
    width = float(page.rect.width)
    height = float(page.rect.height)
    area = width * height

    text_dict = page.get_text("dict", sort=True)
    char_count = 0
    coverage_area = 0.0
    span_boxes = []
    lines = []

    for block in text_dict.get("blocks") or []:
        if block.get("type", 0) != 0:
            continue  # image blocks are counted via imageCount
        for line in block.get("lines") or []:
            spans = line.get("spans") or []
            if not spans:
                continue
            line_text = "".join(span.get("text") or "" for span in spans)
            for span in spans:
                text = span.get("text") or ""
                if not text:
                    continue
                char_count += len("".join(text.split()))
                box = span.get("bbox") or (0, 0, 0, 0)
                span_w = float(box[2]) - float(box[0])
                span_h = float(box[3]) - float(box[1])
                if span_w <= 0 or span_h <= 0:
                    continue
                coverage_area += span_w * span_h
                if text.strip():
                    x0, _y0, x1, _y1 = map_rect(page, box, matrix)
                    if x1 - x0 > 0:
                        span_boxes.append((x0, x1 - x0))
            if not line_text.strip():
                continue
            dominant = max(
                spans, key=lambda span: len((span.get("text") or "").strip())
            )
            x0, y0, x1, y1 = map_rect(page, line.get("bbox") or (0, 0, 0, 0), matrix)
            lines.append(
                {
                    "rect": (x0, y0, x1, y1),
                    "size": float(dominant.get("size") or 0),
                    "tilt": line_tilt(line.get("dir"), rotation),
                    "text": line_text.strip(),
                }
            )

    coverage = min(1.0, coverage_area / area) if area > 0 else 0.0
    image_count = count_images(page)
    complexity = analyze_complexity(width, rotation, span_boxes, lines, image_count)
    content_class = classify_content(char_count, coverage, image_count, complexity)

    return {
        "index": int(index),
        "width": width,
        "height": height,
        "rotation": rotation,
        "charCount": char_count,
        "textCoverage": round(coverage, 4),
        "imageCount": image_count,
        "contentClass": content_class,
        "complexity": complexity,
        # internal extras consumed by /extract (stripped before responding)
        "_matrix": matrix,
        "_spanBoxes": span_boxes,
        "_textDict": text_dict,
    }


def public_page_class(signals) -> dict:
    """Strip the internal helpers from a page signal dict."""
    return {k: v for k, v in signals.items() if not k.startswith("_")}


# --------------------------------------------------------------------------
# Document helpers
# --------------------------------------------------------------------------


def open_document(data: bytes, password):
    """Open raw PDF bytes; authenticate when needed (never raises 500 for a
    wrong/missing password)."""
    if not FITZ_OK:  # pragma: no cover - import guard
        raise ApiError(500, "NOT_AVAILABLE", "PyMuPDF (pymupdf) is not installed")
    if not data:
        raise ApiError(400, "BAD_REQUEST", "Request body is empty; POST the raw PDF bytes")
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise ApiError(400, "UNSUPPORTED", f"Could not open the body as a PDF: {exc}")
    if doc.needs_pass:
        try:
            ok = doc.authenticate(password or "")
        except Exception as exc:
            doc.close()
            raise ApiError(
                400, "PASSWORD_REQUIRED", f"PDF password rejected: {exc}"
            ) from None
        if not ok:
            doc.close()
            raise ApiError(
                400,
                "PASSWORD_REQUIRED",
                "This PDF needs a password (or the password is wrong)",
            )
    return doc


def parse_pages(spec, total: int):
    """Parse ``pages`` ("0-11,14", 0-based inclusive) → page index list.

    Missing/blank selects every page. Anything malformed or out of range is
    a PAGE_RANGE error.
    """
    if spec is None or spec.strip() == "":
        return list(range(total))
    indices = []
    for chunk in spec.split(","):
        segment = chunk.strip()
        if not segment:
            continue
        start = end = None
        if "-" in segment:
            bits = segment.split("-")
            if len(bits) == 2:
                start, end = bits
        else:
            start = end = segment
        try:
            first = int((start or "").strip())
            last = int((end or "").strip())
        except ValueError:
            first = last = None
        if first is None or last < first or first < 0 or last >= total:
            upper = max(total - 1, 0)
            raise ApiError(
                400,
                "PAGE_RANGE",
                f"Invalid pages range {segment!r}; expected 0-based pages "
                f"like '0-11,14' within 0..{upper}",
            )
        indices.extend(range(first, last + 1))
    if not indices:
        raise ApiError(
            400, "PAGE_RANGE", f"pages={spec!r} selected no pages of a {total}-page PDF"
        )
    return indices


# --------------------------------------------------------------------------
# OCR helpers
# --------------------------------------------------------------------------


def group_words(words):
    """Group OCR words into lines by baseline proximity (~half x-height).

    Returns (words in reading order, [line words, ...]) with each line sorted
    left-to-right.
    """
    ordered = sorted(words, key=lambda w: (w["rect"][3], w["rect"][0]))
    groups = []
    for word in ordered:
        baseline = word["rect"][3]
        height = word["rect"][3] - word["rect"][1]
        if groups:
            group = groups[-1]
            tolerance = max(1.0, 0.5 * group["height"])
            if abs(baseline - group["baseline"]) <= tolerance:
                group["words"].append(word)
                count = len(group["words"])
                group["baseline"] += (baseline - group["baseline"]) / count
                group["height"] += (height - group["height"]) / count
                continue
        groups.append({"baseline": baseline, "height": height, "words": [word]})
    for group in groups:
        group["words"].sort(key=lambda w: w["rect"][0])
    ordered_words = [word for group in groups for word in group["words"]]
    return ordered_words, [group["words"] for group in groups]


def render_words(page, lang: str, dpi=OCR_DPI) -> dict:
    """Render one page at *dpi*, OCR it → {"words": [...], "lines": [[..]]}.

    Word rectangles are in page points (display space, top-left origin);
    ``conf`` is tesseract's per-word confidence.
    """
    if not PYTESSERACT_OK:  # pragma: no cover - import guard
        raise ApiError(500, "NOT_AVAILABLE", "pytesseract is not installed")
    if not ocr_available():
        raise ApiError(500, "NOT_AVAILABLE", "Tesseract OCR is not available on this machine")
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - pillow ships with pytesseract
        raise ApiError(500, "NOT_AVAILABLE", f"Pillow is required for OCR: {exc}") from None
    try:
        pixmap = page.get_pixmap(dpi=dpi)
        image = Image.open(io.BytesIO(pixmap.tobytes("png")))
        data = pytesseract.image_to_data(
            image, lang=lang, output_type=pytesseract.Output.DICT
        )
    except ApiError:
        raise
    except Exception as exc:
        if type(exc).__name__ == "TesseractNotFoundError":
            raise ApiError(
                500, "NOT_AVAILABLE", "Tesseract OCR is not available on this machine"
            ) from None
        raise ApiError(500, "INTERNAL", f"OCR failed: {type(exc).__name__}: {exc}") from None

    scale = 72.0 / float(dpi)
    words = []
    texts = data.get("text") or []
    for i in range(len(texts)):
        text = (texts[i] or "").strip()
        if not text:
            continue
        try:
            conf = float((data.get("conf") or [])[i])
        except (TypeError, ValueError, IndexError):
            conf = -1.0
        if conf < 0:
            continue
        try:
            x = float(data["left"][i]) * scale
            y = float(data["top"][i]) * scale
            w = float(data["width"][i]) * scale
            h = float(data["height"][i]) * scale
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if w <= 0 or h <= 0:
            continue
        words.append({"text": text, "rect": (x, y, x + w, y + h), "conf": conf})

    ordered_words, line_groups = group_words(words)
    return {"words": ordered_words, "lines": line_groups}


def validate_langs(lang_param):
    """Turn the ``lang`` query value into a validated tesseract language list."""
    requested = [part.strip() for part in (lang_param or "eng").split(",") if part.strip()]
    if not requested:
        requested = ["eng"]
    available = tesseract_info()["langs"]
    if available:
        unknown = [lang for lang in requested if lang not in available]
        if unknown:
            raise ApiError(
                400,
                "BAD_REQUEST",
                "Unknown OCR language(s): "
                + ", ".join(unknown)
                + ". Available: "
                + (", ".join(available) or "none"),
            )
    return requested


# --------------------------------------------------------------------------
# Extraction: raw blocks → ordered, classified public blocks
# --------------------------------------------------------------------------


def _line_entry(page, line, matrix, rotation):
    """Public Line dict for one pymupdf line, or None when it has no text."""
    spans = line.get("spans") or []
    text = "".join(span.get("text") or "" for span in spans)
    if not spans or not text.strip():
        return None
    dominant = max(spans, key=lambda span: len((span.get("text") or "").strip()))
    font_name = dominant.get("font") or ""
    # Strip the subset prefix of embedded fonts: "ABCDEF+Font" → "Font".
    family = font_name.split("+", 1)[-1] if "+" in font_name else font_name
    color = dominant.get("color", 0) or 0
    rect = map_rect(page, line.get("bbox") or (0, 0, 0, 0), matrix)
    if rect[2] - rect[0] <= 0 and rect[3] - rect[1] <= 0:
        return None
    return {
        "text": text,
        "rect": rect,
        "fontFamily": family or "Helvetica",
        "fontSize": round(float(dominant.get("size") or 0), 2),
        "bold": bool(BOLD_RE.search(font_name)),
        "italic": bool(ITALIC_RE.search(font_name)),
        "color": "#%06x" % (int(color) & 0xFFFFFF),
        "rotation": round(line_tilt(line.get("dir"), rotation), 2),
    }


def _wrap_block(lines) -> dict:
    """Internal block dict (rect + lines + text) from its lines."""
    x0 = min(line["rect"][0] for line in lines)
    y0 = min(line["rect"][1] for line in lines)
    x1 = max(line["rect"][2] for line in lines)
    y1 = max(line["rect"][3] for line in lines)
    return {
        "rect": (x0, y0, x1, y1),
        "lines": lines,
        "text": "\n".join(line["text"] for line in lines),
        "table_rows": None,
    }


def text_blocks(page, text_dict, matrix, rotation) -> list:
    """pymupdf dict blocks → internal blocks (spans → lines → blocks)."""
    blocks = []
    for block in text_dict.get("blocks") or []:
        if block.get("type", 0) != 0:
            continue
        lines = []
        for line in block.get("lines") or []:
            entry = _line_entry(page, line, matrix, rotation)
            if entry:
                lines.append(entry)
        if lines:
            blocks.append(_wrap_block(lines))
    return blocks


def _open_plumber(data: bytes, password):
    """Lazily-opened pdfplumber document handle (None on any failure)."""
    return {"data": data, "password": password, "doc": None, "failed": False}


def _close_plumber(state):
    doc = state.get("doc") if state else None
    if doc is not None:
        try:
            doc.close()
        except Exception:
            pass


def plumber_tables(state, index) -> list:
    """pdfplumber find_tables() for one page → [{"rect", "rows"}]; [] on
    import/parse failure (degrade: no table blocks)."""
    if not state or state.get("failed") or not PDFPLUMBER_OK:
        return []
    if state["doc"] is None:
        try:
            kwargs = {"password": state["password"]} if state.get("password") else {}
            state["doc"] = pdfplumber.open(io.BytesIO(state["data"]), **kwargs)
        except Exception:
            state["failed"] = True
            return []
    try:
        page = state["doc"].pages[index]
        found = page.find_tables()
        tables = []
        for table in found:
            rows_raw = table.extract()
            rows = [
                ["" if cell is None else str(cell) for cell in row] for row in rows_raw
            ]
            if not rows:
                continue
            bbox = table.bbox
            tables.append(
                {"rect": (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
                 "rows": rows}
            )
        return tables
    except Exception:
        return []


def _block_inside_table(block_rect, table_rect) -> bool:
    """True when ≥50% of the block (or its centre) sits inside the table."""
    x0, y0, x1, y1 = block_rect
    tx0, ty0, tx1, ty1 = table_rect
    inter_w = max(0.0, min(x1, tx1) - max(x0, tx0))
    inter_h = max(0.0, min(y1, ty1) - max(y0, ty0))
    area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    if area > 0 and inter_w * inter_h / area >= 0.5:
        return True
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    return tx0 <= cx <= tx1 and ty0 <= cy <= ty1


def _table_block(table) -> dict:
    rows = table["rows"]
    text = "\n".join(" \t ".join(row) for row in rows)
    return {
        "rect": table["rect"],
        "lines": [],
        "text": text,
        "table_rows": rows,
    }


def _ocr_block_list(word_lines) -> list:
    """OCR line word-groups → internal blocks (merge small vertical gaps)."""
    blocks = []
    for words in word_lines:
        text = " ".join(word["text"] for word in words)
        if not text.strip():
            continue
        rects = [word["rect"] for word in words]
        rect = (
            min(r[0] for r in rects),
            min(r[1] for r in rects),
            max(r[2] for r in rects),
            max(r[3] for r in rects),
        )
        heights = sorted(r[3] - r[1] for r in rects)
        line = {
            "text": text,
            "rect": rect,
            "fontFamily": "OCR",
            "fontSize": round(heights[len(heights) // 2], 2),
            "bold": False,
            "italic": False,
            "color": "#000000",
            "rotation": 0.0,
        }
        if blocks:
            previous = blocks[-1]["lines"][-1]
            gap = rect[1] - previous["rect"][3]
            limit = 0.9 * max(previous["rect"][3] - previous["rect"][1], 1.0)
            if gap <= limit:
                block = blocks[-1]
                block["lines"].append(line)
                block["text"] += "\n" + text
                block["rect"] = (
                    min(block["rect"][0], rect[0]),
                    min(block["rect"][1], rect[1]),
                    max(block["rect"][2], rect[2]),
                    max(block["rect"][3], rect[3]),
                )
                continue
        blocks.append(_wrap_block([line]))
    return blocks


def _order_blocks(blocks, splits):
    """Column-aware reading order: left column first, then top-to-bottom."""
    def key(block):
        rect = block["rect"]
        centre = (rect[0] + rect[2]) / 2.0
        column = sum(1 for split in splits if centre > split)
        return (column, rect[1], rect[0])

    blocks.sort(key=key)


def _region_of(block, height: float) -> str:
    """Header/footer only for short text in the top/bottom 8% bands."""
    if len(block["text"]) <= REGION_TEXT_MAX:
        if block["rect"][1] < height * REGION_BAND:
            return "header"
        if block["rect"][1] > height * (1.0 - REGION_BAND):
            return "footer"
    return "body"


def _alignment_of(rect, width: float) -> str:
    x0, x1 = rect[0], rect[2]
    box_width = x1 - x0
    centre = (x0 + x1) / 2.0
    if width > 0 and abs(centre - width / 2.0) <= 0.05 * width and box_width < 0.6 * width:
        return "center"
    if width > 0 and abs(x1 - width) <= 0.05 * width and x0 > 0.4 * width:
        return "right"
    return "left"


def _kind_of(block, block_size: float, body_median: float) -> str:
    flat = " ".join(block["text"].split())
    if (
        flat
        and len(flat) <= HEADING_MAX_CHARS
        and body_median > 0
        and block_size >= HEADING_SIZE_RATIO * body_median
        and not block["text"].rstrip().endswith(".")
    ):
        return "heading"
    if LIST_MARKER_RE.match(block["text"].lstrip()):
        return "list"
    if len(flat) <= CAPTION_MAX_CHARS and CAPTION_RE.match(flat):
        return "caption"
    return "paragraph"


def _public_line(line) -> dict:
    return {
        "text": line["text"],
        "bbox": rect_dict(line["rect"]),
        "fontFamily": line["fontFamily"],
        "fontSize": line["fontSize"],
        "bold": line["bold"],
        "italic": line["italic"],
        "color": line["color"],
        "rotation": line["rotation"],
    }


def materialize_blocks(blocks, width, height, fallback_family: str) -> list:
    """Regions → body median → kind/alignment/typography → ordered blocks."""
    for block in blocks:
        block["region"] = _region_of(block, height)

    body_sizes = [
        line["fontSize"]
        for block in blocks
        if block["region"] == "body"
        for line in block["lines"]
        if line["fontSize"] > 0
    ]
    if not body_sizes:
        body_sizes = [
            line["fontSize"] for block in blocks for line in block["lines"] if line["fontSize"] > 0
        ]
    body_median = median(body_sizes)

    public = []
    for order, block in enumerate(blocks):
        lines = block["lines"]
        sizes = [line["fontSize"] for line in lines if line["fontSize"] > 0]
        block_size = median(sizes) if sizes else 0.0
        if block["table_rows"] is not None:
            kind = "table"
            list_marker = None
            table = {"rows": block["table_rows"]}
        else:
            kind = _kind_of(block, block_size, body_median)
            list_marker = None
            if kind == "list":
                match = LIST_MARKER_RE.match(block["text"].lstrip())
                list_marker = match.group(1) if match else None
            table = None
        font_size = block_size or body_median or 0.0
        family = dominant_value([line["fontFamily"] for line in lines]) or fallback_family
        public.append(
            {
                "order": order,
                "kind": kind,
                "region": block["region"],
                "text": block["text"],
                "bbox": rect_dict(block["rect"]),
                "fontSize": round(float(font_size), 2),
                "fontFamily": family,
                "alignment": _alignment_of(block["rect"], width),
                "skipRule": None,
                "listMarker": list_marker,
                "lines": [_public_line(line) for line in lines],
                "table": table,
            }
        )
    return public


def build_text_page(page, signals, plumber_state, index) -> list:
    """Text-layer blocks + pdfplumber tables → ordered public blocks."""
    matrix = signals["_matrix"]
    blocks = text_blocks(page, signals["_textDict"], matrix, signals["rotation"])
    tables = plumber_tables(plumber_state, index)
    fallback = dominant_value(
        [line["fontFamily"] for block in blocks for line in block["lines"]]
    ) or "Helvetica"
    if tables:
        table_blocks = [_table_block(table) for table in tables]
        blocks = [
            block
            for block in blocks
            if not any(
                _block_inside_table(block["rect"], table["rect"]) for table in table_blocks
            )
        ]
        blocks.extend(table_blocks)
    splits = split_positions(signals["_spanBoxes"], signals["width"], MAX_COLUMNS)
    _order_blocks(blocks, splits)
    return materialize_blocks(blocks, signals["width"], signals["height"], fallback)


def build_ocr_page(page, signals, lang) -> list:
    """Scanned page → OCR lines → ordered public blocks."""
    result = render_words(page, lang, OCR_DPI)
    blocks = _ocr_block_list(result["lines"])
    splits = split_positions(signals["_spanBoxes"], signals["width"], MAX_COLUMNS)
    _order_blocks(blocks, splits)
    return materialize_blocks(blocks, signals["width"], signals["height"], "OCR")


# --------------------------------------------------------------------------
# Endpoint handlers
# --------------------------------------------------------------------------


def handle_classify(data: bytes, query: dict) -> dict:
    doc = open_document(data, query.get("password"))
    try:
        indices = parse_pages(query.get("pages"), doc.page_count)
        pages = []
        for index in indices:
            signals = page_signals(doc.load_page(index), index)
            pages.append(public_page_class(signals))
    finally:
        doc.close()

    tally = {name: 0 for name in CONTENT_CLASSES}
    for page in pages:
        tally[page["contentClass"]] += 1
    summary = {
        "tally": tally,
        "textLayerPages": tally["text"] + tally["mixed"] + tally["complex"],
        "ocrNeededPages": tally["scanned"],
        "complexPages": tally["complex"],
    }
    return {"ok": True, "pages": pages, "summary": summary}


def handle_extract(data: bytes, query: dict) -> dict:
    mode = (query.get("mode") or "auto").strip()
    if mode not in ("auto", "text"):
        raise ApiError(400, "BAD_REQUEST", "mode must be one of: auto, text")

    doc = open_document(data, query.get("password"))  # password errors first
    plumber_state = _open_plumber(data, query.get("password"))
    started = time.perf_counter()
    pages = []
    try:
        indices = parse_pages(query.get("pages"), doc.page_count)
        for index in indices:
            page = doc.load_page(index)
            signals = page_signals(page, index)
            content_class = signals["contentClass"]
            entry = {
                "index": signals["index"],
                "width": signals["width"],
                "height": signals["height"],
                "rotation": signals["rotation"],
                "extractionMethod": "text",
                "contentClass": content_class,
                "blocks": [],
            }
            if content_class == "empty":
                entry["extractionMethod"] = "none"
            elif content_class == "scanned":
                entry["extractionMethod"] = "ocr"
                entry["ocrAvailable"] = ocr_available()
                if mode == "auto" and entry["ocrAvailable"]:
                    try:
                        entry["blocks"] = build_ocr_page(page, signals, default_ocr_lang())
                    except Exception:
                        traceback.print_exc()
                        entry["blocks"] = []
            elif content_class == "mixed":
                entry["extractionMethod"] = "hybrid"
                entry["blocks"] = build_text_page(page, signals, plumber_state, index)
            else:  # text / complex
                entry["extractionMethod"] = "text"
                entry["blocks"] = build_text_page(page, signals, plumber_state, index)
            pages.append(entry)
    finally:
        doc.close()
        _close_plumber(plumber_state)

    return {
        "ok": True,
        "pages": pages,
        "ms": int((time.perf_counter() - started) * 1000),
    }


def handle_ocr(data: bytes, query: dict) -> dict:
    page_raw = query.get("page") or "0"
    try:
        index = int(page_raw)
    except ValueError:
        raise ApiError(400, "BAD_REQUEST", f"page must be an integer, got {page_raw!r}") from None

    # Document-level problems (password, corrupt body) win over capability
    # checks so a locked PDF always answers PASSWORD_REQUIRED.
    doc = open_document(data, query.get("password"))
    started = time.perf_counter()
    try:
        if index < 0 or index >= doc.page_count:
            raise ApiError(
                400,
                "PAGE_RANGE",
                f"page={index} out of range for a {doc.page_count}-page PDF",
            )
        if not ocr_available():
            raise ApiError(
                500, "NOT_AVAILABLE", "Tesseract OCR is not available on this machine"
            )
        langs = validate_langs(query.get("lang"))
        page = doc.load_page(index)
        result = render_words(page, ",".join(langs), OCR_DPI)
        ordered_words = result["words"]
        text = "\n".join(
            " ".join(word["text"] for word in line) for line in result["lines"]
        )
        confidences = [word["conf"] for word in ordered_words]
        confidence = round(sum(confidences) / len(confidences), 1) if confidences else 0.0
        words = [
            {"text": word["text"], "bbox": rect_dict(word["rect"])}
            for word in ordered_words
        ]
        return {
            "ok": True,
            "page": index,
            "text": text,
            "confidence": confidence,
            "words": words,
            "ms": int((time.perf_counter() - started) * 1000),
        }
    finally:
        doc.close()


POST_ROUTES = {
    "/classify": handle_classify,
    "/extract": handle_extract,
    "/ocr": handle_ocr,
}


# --------------------------------------------------------------------------
# HTTP plumbing
# --------------------------------------------------------------------------


class SidecarHandler(BaseHTTPRequestHandler):
    """Routes protocol-v1 requests; every response is JSON with CORS."""

    protocol_version = "HTTP/1.1"
    server_version = f"pdf-translator-sidecar/{VERSION}"
    sys_version = ""

    def log_message(self, fmt, *args):  # noqa: D102 - quiet by default
        if os.environ.get("SIDECAR_DEBUG"):
            sys.stderr.write(f"[sidecar] {self.address_string()} - {fmt % args}\n")

    # -- CORS ------------------------------------------------------------
    def _cors_origin(self):
        origin = self.headers.get("Origin")
        if origin and origin in allowed_origins():
            return origin
        return None

    # -- responses -------------------------------------------------------
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_error(self, status, code, message):
        self._send_json({"ok": False, "code": code, "message": message}, status)

    def _send_preflight(self):
        self.send_response(204)
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()

    # -- body ------------------------------------------------------------
    def _read_body(self) -> bytes:
        encoding = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in encoding:
            return self._read_chunked()
        length_header = self.headers.get("Content-Length")
        if not length_header:
            return b""
        try:
            length = int(length_header)
        except ValueError:
            raise ApiError(400, "BAD_REQUEST", "Invalid Content-Length header") from None
        if length < 0:
            raise ApiError(400, "BAD_REQUEST", "Negative Content-Length header") from None
        if length > MAX_BODY:
            raise ApiError(
                413, "PAYLOAD_TOO_LARGE", f"Request body exceeds {MAX_BODY} bytes"
            )
        body = bytearray()
        while len(body) < length:
            chunk = self.rfile.read(length - len(body))
            if not chunk:
                break
            body.extend(chunk)
        return bytes(body)

    def _read_chunked(self) -> bytes:
        body = bytearray()
        while True:
            size_line = self.rfile.readline(65536).strip()
            if b";" in size_line:
                size_line = size_line.split(b";", 1)[0]
            try:
                size = int(size_line, 16)
            except ValueError:
                raise ApiError(400, "BAD_REQUEST", "Malformed chunked body") from None
            if size == 0:
                while True:  # consume trailers
                    trailer = self.rfile.readline(65536)
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                break
            if len(body) + size > MAX_BODY:
                raise ApiError(
                    413, "PAYLOAD_TOO_LARGE", f"Request body exceeds {MAX_BODY} bytes"
                )
            body.extend(self.rfile.read(size))
            self.rfile.read(2)  # trailing CRLF
        return bytes(body)

    # -- routing ---------------------------------------------------------
    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_OPTIONS(self):
        self._handle("OPTIONS")

    def _handle(self, method: str):
        try:
            if method == "OPTIONS":
                self._send_preflight()
                return
            url = urlparse(self.path)
            path = url.path
            if method == "GET":
                if path == "/health":
                    self._send_json(health_payload())
                else:
                    raise ApiError(404, "NOT_FOUND", f"No such endpoint: GET {path}")
                return
            handler = POST_ROUTES.get(path)
            if handler is None:
                raise ApiError(404, "NOT_FOUND", f"No such endpoint: POST {path}")
            query = {
                key: values[0]
                for key, values in parse_qs(url.query, keep_blank_values=True).items()
            }
            body = self._read_body()
            self._send_json(handler(body, query))
        except ApiError as exc:
            if exc.status == 413:
                # Body unread → drop the connection instead of desyncing.
                self.close_connection = True
            try:
                self._send_error(exc.status, exc.code, exc.message)
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # never leak a traceback to the client
            traceback.print_exc()
            try:
                self._send_error(500, "INTERNAL", f"{type(exc).__name__}: {exc}")
            except (BrokenPipeError, ConnectionResetError):
                pass


def create_server(host=None, port=None) -> ThreadingHTTPServer:
    """Bind a sidecar server (PORT/HOST env defaults; port 0 picks a free port)."""
    if host is None:
        host = os.environ.get("HOST", DEFAULT_HOST)
    if port is None:
        port = int(os.environ.get("PORT", str(DEFAULT_PORT)))
    return ThreadingHTTPServer((host, port), SidecarHandler)


def main() -> int:
    host = os.environ.get("HOST", DEFAULT_HOST)
    port = int(os.environ.get("PORT", str(DEFAULT_PORT)))
    server = create_server(host, port)
    origin = os.environ.get("ALLOWED_ORIGIN", DEFAULT_ORIGIN)
    print(
        f"pdf-translator sidecar v{VERSION} on http://{host}:{server.server_port} "
        f"(allowed origins: {', '.join(sorted(allowed_origins()))}; "
        f"ALLOWED_ORIGIN={origin})"
    )
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nsidecar stopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
