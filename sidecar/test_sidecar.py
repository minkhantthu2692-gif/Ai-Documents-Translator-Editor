#!/usr/bin/env python
"""Self-contained test suite for the PDF translator sidecar (protocol v1).

Fixtures are generated on the fly with PyMuPDF in a temp directory (no
binary fixtures are committed), the server is started in-process on a free
port, and every endpoint is exercised over real HTTP.

Run::

    python test_sidecar.py

Exits non-zero on any failure and prints an "N tests, all passed" summary.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# Load server.py as a module (side-effect: TESSDATA_PREFIX bootstrap).
_SPEC = importlib.util.spec_from_file_location(
    "sidecar_server", os.path.join(HERE, "server.py")
)
sidecar = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(sidecar)

import pymupdf  # noqa: E402 - after server import on purpose

SERVER_HOST = "127.0.0.1"
ORIGIN = "http://localhost:5173"
LOCKED_PASSWORD = "secret123"

BASE = ""  # set once the in-process server is up


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------


def http(method, path, body=None, content_type="application/pdf", origin=ORIGIN,
         timeout=120):
    """Perform one request → (status, lowercase headers, parsed JSON)."""
    request = urllib.request.Request(BASE + path, data=body, method=method)
    if content_type:
        request.add_header("Content-Type", content_type)
    if origin:
        request.add_header("Origin", origin)
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        response = exc
    raw = response.read()
    status = response.getcode()
    headers = {key.lower(): value for key, value in response.headers.items()}
    payload = json.loads(raw.decode("utf-8")) if raw else None
    return status, headers, payload


def post(path, body, **kwargs):
    return http("POST", path, body, **kwargs)


# --------------------------------------------------------------------------
# Fixtures (generated on the fly)
# --------------------------------------------------------------------------

HELLO_LINES = [
    "Hello sidecar translation test.",
    "This paragraph exercises the text layer extraction path.",
    "Another body line for coverage, ordering and block checks.",
    "A final sentence keeps the fixture comfortably above thresholds.",
]


def build_fixtures(directory):
    """Create hello/columns/scan/locked/multi PDFs; returns {name: path}."""
    paths = {}

    # (a) hello.pdf — one text page with a heading-sized first line.
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 96), "Sidecar Translation Test", fontsize=24, fontname="hebo")
    y = 150
    for line in HELLO_LINES:
        page.insert_text((72, y), line, fontsize=12)
        y += 22
    paths["hello"] = os.path.join(directory, "hello.pdf")
    doc.save(paths["hello"])
    doc.close()

    # (b) columns.pdf — 3 columns with wide gutters (line width ≈ 105pt).
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    for column, x0 in enumerate((40, 226, 412)):
        for row in range(10):
            page.insert_text(
                (x0, 70 + row * 24),
                f"C{column} row {row} sample words here",
                fontsize=8,
            )
    paths["columns"] = os.path.join(directory, "columns.pdf")
    doc.save(paths["columns"])
    doc.close()

    # (c) scan.pdf — image-only page (text rendered to a pixmap, re-placed).
    source = pymupdf.open()
    text_page = source.new_page(width=612, height=792)
    text_page.insert_text((72, 120), "Hello sidecar translation test.", fontsize=36)
    text_page.insert_text((72, 180), "Scanned OCR sample line two.", fontsize=36)
    text_page.insert_text((72, 240), "Third line of scanned text.", fontsize=36)
    pixmap = text_page.get_pixmap(dpi=200)
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_image(pymupdf.Rect(0, 0, 612, 792), pixmap=pixmap)
    paths["scan"] = os.path.join(directory, "scan.pdf")
    doc.save(paths["scan"])
    doc.close()
    source.close()

    # (d) locked.pdf — AES-256 encrypted, user password required.
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 100), "Encrypted sidecar fixture body text.", fontsize=12)
    page.insert_text((72, 130), "Second locked line for extraction checks.", fontsize=12)
    paths["locked"] = os.path.join(directory, "locked.pdf")
    doc.save(
        paths["locked"],
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        user_pw=LOCKED_PASSWORD,
        owner_pw=LOCKED_PASSWORD,
    )
    doc.close()

    # (e) multi.pdf — 3 pages for pages= range testing.
    doc = pymupdf.open()
    for index in range(3):
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 90), f"Multi page {index + 1} heading", fontsize=20)
        page.insert_text(
            (72, 140), f"Body text for page {index + 1} of the range fixture.", fontsize=12
        )
        page.insert_text(
            (72, 170), f"Second paragraph line on page {index + 1}.", fontsize=12
        )
    paths["multi"] = os.path.join(directory, "multi.pdf")
    doc.save(paths["multi"])
    doc.close()

    return paths


def read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------


class SidecarTestCase(unittest.TestCase):
    """Exercises every protocol-v1 endpoint against a live in-process server."""

    server = None
    thread = None
    pdfs = {}
    health = {}
    ocr = False
    port = 0

    # -- lifecycle -------------------------------------------------------
    @classmethod
    def setUpClass(cls):
        global BASE
        cls.directory = tempfile.mkdtemp(prefix="sidecar-test-")
        cls.pdfs = {name: read_bytes(path) for name, path in build_fixtures(cls.directory).items()}

        cls.server = sidecar.create_server(SERVER_HOST, 0)  # free port
        cls.port = cls.server.server_address[1]
        BASE = f"http://{SERVER_HOST}:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

        deadline = time.time() + 20
        last_error = None
        while time.time() < deadline:
            try:
                status, _headers, payload = http(
                    "GET", "/health", content_type=None, timeout=5
                )
                if status == 200 and payload.get("ok"):
                    cls.health = payload
                    break
            except Exception as exc:  # server still starting
                last_error = exc
                time.sleep(0.1)
        else:  # pragma: no cover - startup failure
            raise AssertionError(f"sidecar did not become healthy: {last_error}")
        cls.ocr = bool(cls.health["tesseract"]["available"])

    @classmethod
    def tearDownClass(cls):
        if cls.server is not None:
            cls.server.shutdown()
            cls.server.server_close()
        shutil.rmtree(cls.directory, ignore_errors=True)

    # -- helpers ---------------------------------------------------------
    def classify(self, name, query=""):
        status, _headers, payload = post(f"/classify{query}", self.pdfs[name])
        return status, payload

    def extract(self, name, query=""):
        status, _headers, payload = post(f"/extract{query}", self.pdfs[name])
        return status, payload

    # -- /health ---------------------------------------------------------
    def test_health(self):
        status, headers, payload = http("GET", "/health", content_type=None)
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("content-type", ""))
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["version"], "0.1.0")
        self.assertRegex(payload["python"], r"^\d+\.\d+\.\d+$")
        self.assertTrue(payload["libs"]["fitz"])
        self.assertTrue(payload["libs"]["pdfplumber"])
        self.assertTrue(payload["libs"]["pytesseract"])
        self.assertIsInstance(payload["tesseract"]["available"], bool)
        self.assertIsInstance(payload["tesseract"]["langs"], list)

    # -- /classify -------------------------------------------------------
    def test_classify_hello_is_text(self):
        status, payload = self.classify("hello")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["pages"]), 1)
        page = payload["pages"][0]
        for key in (
            "index", "width", "height", "rotation", "charCount",
            "textCoverage", "imageCount", "contentClass", "complexity",
        ):
            self.assertIn(key, page)
        self.assertEqual(page["contentClass"], "text")
        self.assertGreaterEqual(page["charCount"], 100)
        self.assertGreaterEqual(page["textCoverage"], 0.002)
        self.assertFalse(page["complexity"]["complex"])
        for key in ("score", "reasons", "complex"):
            self.assertIn(key, page["complexity"])

        summary = payload["summary"]
        tally = summary["tally"]
        self.assertEqual(tally["text"], 1)
        self.assertEqual(sum(tally.values()), 1)
        self.assertEqual(summary["textLayerPages"], 1)
        self.assertEqual(summary["ocrNeededPages"], 0)
        self.assertEqual(summary["complexPages"], 0)

    def test_classify_columns_is_complex(self):
        status, payload = self.classify("columns")
        self.assertEqual(status, 200)
        page = payload["pages"][0]
        complexity = page["complexity"]
        self.assertTrue(complexity["complex"], complexity)
        self.assertIn("columns3", complexity["reasons"])
        self.assertGreaterEqual(complexity["score"], 0.45)
        self.assertEqual(page["contentClass"], "complex")

    def test_classify_scan_is_scanned(self):
        status, payload = self.classify("scan")
        self.assertEqual(status, 200)
        page = payload["pages"][0]
        self.assertEqual(page["contentClass"], "scanned")
        self.assertGreaterEqual(page["imageCount"], 1)
        self.assertEqual(page["charCount"], 0)

    def test_classify_multi_tally_sums(self):
        status, payload = self.classify("multi")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["pages"]), 3)
        summary = payload["summary"]
        tally = summary["tally"]
        self.assertEqual(sum(tally.values()), 3)
        self.assertEqual(summary["textLayerPages"], tally["text"] + tally["mixed"] + tally["complex"])
        self.assertEqual(summary["ocrNeededPages"], tally["scanned"])
        self.assertEqual(summary["complexPages"], tally["complex"])

    def test_classify_page_subset(self):
        status, payload = self.classify("multi", "?pages=0-1")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["pages"]), 2)
        self.assertEqual([page["index"] for page in payload["pages"]], [0, 1])
        self.assertEqual(sum(payload["summary"]["tally"].values()), 2)

    def test_classify_bad_pages_range(self):
        status, payload = self.classify("multi", "?pages=9-10")
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "PAGE_RANGE")
        self.assertIn("message", payload)

        status, payload = self.classify("hello", "?pages=abc")
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "PAGE_RANGE")

    # -- /extract --------------------------------------------------------
    def test_extract_hello_blocks(self):
        status, payload = self.extract("hello")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertIsInstance(payload["ms"], int)
        self.assertEqual(len(payload["pages"]), 1)
        page = payload["pages"][0]
        self.assertEqual(page["extractionMethod"], "text")
        self.assertEqual(page["contentClass"], "text")
        self.assertTrue(page["blocks"], "expected text blocks")

        full_text = "\n".join(block["text"] for block in page["blocks"])
        self.assertIn("Hello sidecar translation test.", full_text)

        self.assertEqual(
            [block["order"] for block in page["blocks"]],
            list(range(len(page["blocks"]))),
        )
        for block in page["blocks"]:
            self.assertIsNone(block["table"])
            self.assertIsNone(block["skipRule"])
            self.assertIn(block["kind"], ("heading", "paragraph", "list", "table", "caption", "shape"))
            self.assertIn(block["region"], ("body", "header", "footer"))
            self.assertIn(block["alignment"], ("left", "center", "right", "justified"))
            self.assertIsInstance(block["fontSize"], (int, float))
            self.assertTrue(block["fontFamily"])
            # top-left origin: every box sits inside the page
            bbox = block["bbox"]
            self.assertGreaterEqual(bbox["x"], 0)
            self.assertGreaterEqual(bbox["y"], 0)
            self.assertLessEqual(bbox["y"] + bbox["h"], page["height"] + 1)
            self.assertLessEqual(bbox["x"] + bbox["w"], page["width"] + 1)
            for line in block["lines"]:
                self.assertGreaterEqual(line["bbox"]["y"], 0)
                self.assertLessEqual(
                    line["bbox"]["y"] + line["bbox"]["h"], page["height"] + 1
                )
                self.assertRegex(line["color"], r"^#[0-9a-f]{6}$")
                self.assertIsInstance(line["rotation"], (int, float))

    def test_extract_scan_mode_auto(self):
        status, payload = self.extract("scan")
        self.assertEqual(status, 200)
        page = payload["pages"][0]
        self.assertEqual(page["contentClass"], "scanned")
        self.assertEqual(page["extractionMethod"], "ocr")
        if self.ocr:
            self.assertTrue(page["ocrAvailable"])
            self.assertTrue(page["blocks"], "expected OCR blocks")
            text = "\n".join(block["text"] for block in page["blocks"]).lower()
            self.assertIn("hello", text)
        else:
            self.assertFalse(page["ocrAvailable"])
            self.assertEqual(page["blocks"], [])

    def test_extract_scan_mode_text_skips_ocr(self):
        status, payload = self.extract("scan", "?mode=text")
        self.assertEqual(status, 200)
        page = payload["pages"][0]
        self.assertEqual(page["extractionMethod"], "ocr")
        self.assertEqual(page["blocks"], [])

    def test_extract_pages_subset(self):
        status, payload = self.extract("multi", "?pages=0-1")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["pages"]), 2)
        self.assertEqual([page["index"] for page in payload["pages"]], [0, 1])
        for page in payload["pages"]:
            self.assertTrue(page["blocks"])

    def test_extract_invalid_mode(self):
        status, payload = self.extract("hello", "?mode=widget")
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "BAD_REQUEST")

    # -- password handling ----------------------------------------------
    def test_locked_pdf_requires_password(self):
        status, payload = self.classify("locked")
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "PASSWORD_REQUIRED")
        self.assertIn("message", payload)

        status, payload = self.extract("locked")
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "PASSWORD_REQUIRED")

        status, _headers, payload = post(
            "/ocr?page=0", self.pdfs["locked"], content_type="application/pdf"
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "PASSWORD_REQUIRED")

    def test_locked_pdf_with_password(self):
        status, payload = self.classify("locked", f"?password={LOCKED_PASSWORD}")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["pages"][0]["contentClass"], "text")

        status, payload = self.extract("locked", f"?password={LOCKED_PASSWORD}")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["pages"][0]["blocks"])

        status, payload = self.classify("locked", "?password=wrong-one")
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "PASSWORD_REQUIRED")

    # -- /ocr ------------------------------------------------------------
    def test_ocr_endpoint(self):
        status, _headers, payload = post("/ocr?page=0&lang=eng", self.pdfs["scan"])
        if not self.ocr:
            self.assertEqual(status, 500)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], "NOT_AVAILABLE")
            return
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["page"], 0)
        self.assertTrue(payload["text"].strip())
        self.assertGreater(payload["confidence"], 0)
        self.assertGreaterEqual(len(payload["words"]), 1)
        self.assertIsInstance(payload["ms"], int)
        word = payload["words"][0]
        self.assertIn("text", word)
        for key in ("x", "y", "w", "h"):
            self.assertIn(key, word["bbox"])
        # Lines are what the frontend's structure pass reads: text + page-point
        # box + a mean confidence it can filter on.
        self.assertGreaterEqual(len(payload["lines"]), 1)
        line = payload["lines"][0]
        self.assertTrue(line["text"].strip())
        self.assertGreater(line["confidence"], 0)
        for key in ("x", "y", "w", "h"):
            self.assertIn(key, line["bbox"])
        # Every word the response reports belongs to some line.
        self.assertEqual(
            sum(len(part.split()) for part in payload["text"].split("\n")),
            sum(len(entry["text"].split()) for entry in payload["lines"]),
        )

    def test_ocr_unknown_language(self):
        status, _headers, payload = post("/ocr?page=0&lang=zz", self.pdfs["scan"])
        if not self.ocr:
            self.assertEqual(status, 500)
            self.assertEqual(payload["code"], "NOT_AVAILABLE")
            return
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "BAD_REQUEST")
        self.assertIn("Available", payload["message"])

    def test_ocr_page_out_of_range(self):
        status, _headers, payload = post("/ocr?page=42", self.pdfs["scan"])
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "PAGE_RANGE")

    # -- CORS / routing / limits ----------------------------------------
    def test_options_preflight(self):
        status, headers, _payload = http("OPTIONS", "/classify", body=None)
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("access-control-allow-origin"), ORIGIN)
        self.assertIn("POST", headers.get("access-control-allow-methods", ""))
        self.assertIn(
            "content-type", headers.get("access-control-allow-headers", "").lower()
        )

    def test_unknown_path_returns_json_404(self):
        for path in ("/", "/nope"):
            status, headers, payload = http("GET", path, content_type=None)
            self.assertEqual(status, 404)
            self.assertIn("application/json", headers.get("content-type", ""))
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], "NOT_FOUND")
            self.assertIn("message", payload)

        status, _headers, payload = post("/nope", self.pdfs["hello"])
        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")

    def test_payload_too_large_returns_413(self):
        request = (
            "POST /classify HTTP/1.1\r\n"
            f"Host: {SERVER_HOST}:{self.port}\r\n"
            "Content-Type: application/octet-stream\r\n"
            f"Content-Length: {300 * 1024 * 1024}\r\n"
            "\r\n"
        ).encode("ascii")
        with socket.create_connection((SERVER_HOST, self.port), timeout=10) as sock:
            sock.sendall(request)
            chunks = []
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
        head, _, body = b"".join(chunks).decode("latin-1").partition("\r\n\r\n")
        self.assertTrue(head.startswith("HTTP/1.1 413"), head)
        payload = json.loads(body)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "PAYLOAD_TOO_LARGE")


def main() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SidecarTestCase)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    total = result.testsRun
    failed = len(result.failures) + len(result.errors)
    print()
    if result.wasSuccessful():
        print(f"{total} tests, all passed")
        return 0
    print(f"{total} tests, {failed} failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
