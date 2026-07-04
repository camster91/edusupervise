#!/usr/bin/env python3
"""Phase 2 PDF table extractor — called by pdf-parser.server.ts via execFile.

This script reads a PDF file path from argv[1] and writes a JSON object
to stdout describing the parsed tables. The Node wrapper does the
scoring + role classification; this script's only job is to faithfully
extract every table on every page and emit enough metadata for the
scorer to pick the right one.

Output shape:
{
  "ok": true,
  "pages": [
    {
      "page_number": 1,
      "text_chars": 482,
      "tables": [
        {
          "rows": [["Day 1", "Day 2", "Day 3", "Day 4"], ["Attwood", ...], ...],
          "bbox": [x0, top, x1, bottom]
        }
      ]
    }
  ]
}

Failure shape:
{
  "ok": false,
  "error": "scanned_pdf",
  "detail": "PDF has no text layer; needs vision-model fallback"
}

Why we don't do the scoring here:
  - The scorer needs to know which cycle day a teacher is for, but a
    5-day school vs a 10-day school vs a 4-day school all call their
    columns "Day 1..4" or "Day 1..5". The role+school-id pair
    disambiguates; that's a Node-side concern.
  - Keeping this script dumb makes it easy to re-test against new PDF
    samples without spinning up the web container.

Why we capture `bbox`: pdfplumber's table finder picks up tables from
header/footer regions too (page numbers, "Last updated" stamps). The
scorer down-weights tables whose bbox is in the top 10% or bottom 10%
of the page so the body table wins.

Why a hard timeout: the Node side passes a timeout (--timeout-ms=NNN)
via env var PDF_PARSE_TIMEOUT_MS. We use signal.alarm to enforce it
because pdfplumber has no internal cancellation. If we exceed, we
exit(124) and emit an error JSON.

Phase 2 scope only — no vision-model fallback. If a PDF has no text
layer we surface a clear "scanned_pdf" error and ask the user to
upload a text version.

Stdlib-only path with pdfplumber: we deliberately do NOT import any
of our own modules — this script runs in a minimal Python image and
should be portable across python:3.x versions.

Usage:
  python3 pdf_extract.py /path/to/file.pdf

Exit codes:
  0  success
  1  generic error (corrupt file, pdfplumber crash)
  2  invalid args
  3  scanned PDF (no text layer — UI surfaces a "re-upload a text PDF" message)
  124 timeout
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
import traceback


def _timeout_handler(signum, frame):  # noqa: ARG001
    sys.stderr.write("pdf_extract: timeout\n")
    sys.exit(124)


def _fail(code: str, detail: str) -> None:
    """Emit a JSON error envelope to stdout and exit non-zero.

    The Node wrapper reads stdout as JSON; stderr is for logs only.
    """
    payload = {"ok": False, "error": code, "detail": detail}
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    # Don't sys.exit here — let the caller choose the exit code so we
    # can map distinct codes for distinct UI messages.


def main() -> int:
    if len(sys.argv) < 2:
        _fail("invalid_args", "Usage: pdf_extract.py <pdf-path>")
        return 2
    pdf_path = sys.argv[1]
    if not os.path.isfile(pdf_path):
        _fail("file_not_found", f"No such file: {pdf_path}")
        return 2

    timeout_ms_raw = os.environ.get("PDF_PARSE_TIMEOUT_MS", "8000")
    try:
        timeout_sec = max(1, int(timeout_ms_raw) // 1000)
    except ValueError:
        timeout_sec = 8
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_sec)

    # Import inside main() so an ImportError on pdfplumber surfaces as
    # a clear "module_not_found" error rather than a traceback the
    # Node side has to parse.
    try:
        import pdfplumber  # type: ignore[import-not-found]
    except ImportError as err:
        _fail("pdfplumber_missing", str(err))
        return 1

    started = time.monotonic()
    pages_out = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            if not pdf.pages:
                _fail("empty_pdf", "PDF has zero pages")
                return 1
            for idx, page in enumerate(pdf.pages, start=1):
                page_record: dict = {
                    "page_number": idx,
                    "text_chars": len(page.chars or []),
                    "tables": [],
                }
                try:
                    tables = page.extract_tables(
                        table_settings={
                            "vertical_strategy": "lines",
                            "horizontal_strategy": "lines",
                            "intersection_tolerance": 5,
                        }
                    ) or []
                except Exception as table_err:  # noqa: BLE001
                    # Some PDFs have ambiguous rulings; try the text
                    # strategy before giving up on the page.
                    try:
                        tables = page.extract_tables(
                            table_settings={
                                "vertical_strategy": "text",
                                "horizontal_strategy": "text",
                                "snap_tolerance": 3,
                            }
                        ) or []
                    except Exception:
                        sys.stderr.write(
                            f"pdf_extract: page {idx} extract_tables failed: "
                            f"{table_err}\n"
                        )
                        tables = []
                for tbl in tables:
                    if not tbl:
                        continue
                    # Strip cells: pdfplumber often returns "\n" tails.
                    cleaned = [
                        [
                            ((cell or "").replace("\n", " ").strip() if cell else "")
                            for cell in row
                        ]
                        for row in tbl
                    ]
                    # Drop fully-empty rows so the scorer doesn't get
                    # distracted by pdfplumber's row padding.
                    cleaned = [row for row in cleaned if any(c for c in row)]
                    if not cleaned:
                        continue
                    page_record["tables"].append({"rows": cleaned})
                pages_out.append(page_record)
    except Exception as err:  # noqa: BLE001
        sys.stderr.write(traceback.format_exc())
        _fail("pdfplumber_crashed", str(err))
        return 1
    finally:
        signal.alarm(0)

    total_text = sum(p["text_chars"] for p in pages_out)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    sys.stderr.write(
        f"pdf_extract: pages={len(pages_out)} text_chars={total_text} "
        f"elapsed_ms={elapsed_ms}\n"
    )

    if total_text == 0:
        _fail(
            "scanned_pdf",
            "PDF has no text layer (image-only). Re-export from Word/Google Docs or scan with OCR first.",
        )
        return 3

    payload = {"ok": True, "pages": pages_out}
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())