#!/usr/bin/env python3
"""Phase 3 PDF calendar extractor — called by calendar-parser.server.ts via execFile.

Mirrors apps/web/server/pdf_extract.py's shape: dumb extractor, Node
wrapper does the heavier work (holiday-name mapping, DB persistence).

Input: 5-day-cycle elementary school calendar (YRDSB template).
  - One page, landscape, tabular grid: month name + date row + cycle-day
    row (+ optional 3rd row with PA-days-count overflow digit).
  - 29 cols total: 4 metadata + 5 weeks * 5 weekdays (M T W T F each).
  - Cycle-row cells: "1"-"5" (instructional, the cycle day) | "B" (board
    holiday) | "E" (elementary PA) | "ES" (elem/sec PA) | "M" (mandatory
    holiday) | "0" (day-zero PA — June 24 & 25 in YRDSB) | empty.

Failure shape: {"ok": false, "error": "...", "detail": "..."}
Exit codes: 0 success | 1 generic | 2 invalid args | 3 scanned PDF |
            4 no usable calendar | 124 timeout.

Usage:
  python3 pdf_calendar_extract.py /path/to/calendar.pdf

Stdlib-only path with pdfplumber. Hard timeout via signal.alarm.

School year boundary: Sept-Dec = first calendar year, Jan-Jun = second.
Override via env var SCHOOL_YEAR_START (4-digit year).
"""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import time
import traceback
from datetime import date


MONTH_ALIASES = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
HOLIDAY_CODES = {"B", "E", "ES", "M", "0"}  # "0" = day-zero PA day
CYCLE_LABELS = {"1", "2", "3", "4", "5"}
WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                 "Saturday", "Sunday"]
CALENDAR_COLS = 29
CAL_DATE_OFFSET = 4


def _fail(code, detail):
    sys.stdout.write(json.dumps({"ok": False, "error": code, "detail": detail}))
    sys.stdout.flush()


def _cell(row, idx):
    if row is None or idx >= len(row):
        return ""
    v = row[idx]
    return str(v).strip() if v is not None else ""


def _month_idx(name):
    return MONTH_ALIASES.get((name or "").lower())


def _detect_school_year_first(meta):
    """First calendar year. Order: env > Title > CreationDate > 2025."""
    env = os.environ.get("SCHOOL_YEAR_START", "")
    if env.isdigit() and len(env) == 4:
        return int(env)
    title = (meta or {}).get("Title", "") or ""
    m = re.search(r"(\d{4})\s*[-–]\s*(\d{4})", title)
    if m:
        return int(m.group(1))
    cd = (meta or {}).get("CreationDate", "") or ""
    m = re.match(r"D:(\d{4})", cd)
    if m:
        return int(m.group(1))
    return 2025


def _year_for_month(month_idx, first_year):
    if month_idx >= 9:
        return first_year
    if month_idx >= 1:
        return first_year + 1
    return first_year


def _find_calendar_header(table):
    for i, row in enumerate(table):
        if any(_cell(row, j).lower() == "1st week" for j in range(len(row))):
            return i
    return -1


def _parse_calendar_table(table, first_year):
    """Walk (date_row, cycle_row) pairs; skip overflow rows; stop at TOTALS."""
    days = []
    header_idx = _find_calendar_header(table)
    if header_idx < 0:
        return []
    i = header_idx + 2  # +1 = weekday header, +2 = first date row
    while i + 1 < len(table):
        date_row, cycle_row = table[i], table[i + 1]
        m_raw = _cell(date_row, 0)
        if not m_raw:
            i += 1
            continue
        if m_raw.upper().startswith("TOTAL"):
            break
        m_idx = _month_idx(m_raw)
        # Handle "S\neptember" if pdfplumber splits a leading letter into
        # an adjacent cell. Concat with cycle row col 0 and retry.
        if m_idx is None and _cell(cycle_row, 0):
            combined = m_raw + _cell(cycle_row, 0)
            m_idx = _month_idx(combined)
            if m_idx is not None:
                date_row = [combined] + [
                    _cell(date_row, j) for j in range(1, CALENDAR_COLS)
                ]
                cycle_row = table[i + 2] if i + 2 < len(table) else cycle_row
                i += 1
        if m_idx is None:
            i += 1
            continue
        year = _year_for_month(m_idx, first_year)
        for col in range(CAL_DATE_OFFSET, CALENDAR_COLS):
            d_raw, c_raw = _cell(date_row, col), _cell(cycle_row, col)
            if not d_raw and not c_raw:
                continue
            try:
                day_int = int(d_raw)
            except ValueError:
                continue
            try:
                d_obj = date(year, m_idx, day_int)
            except ValueError:
                sys.stderr.write(
                    f"pdf_calendar_extract: bad date {year}-{m_idx:02d}-{d_raw}\n"
                )
                continue
            iso, weekday = d_obj.isoformat(), WEEKDAY_NAMES[d_obj.weekday()]
            if c_raw in CYCLE_LABELS:
                days.append({
                    "date": iso, "month": m_idx, "day": day_int,
                    "weekday": weekday, "cycleDay": int(c_raw),
                    "isInstructional": True, "holidayCode": None,
                })
            elif c_raw in HOLIDAY_CODES:
                days.append({
                    "date": iso, "month": m_idx, "day": day_int,
                    "weekday": weekday, "cycleDay": None,
                    "isInstructional": False, "holidayCode": c_raw,
                })
            else:
                sys.stderr.write(
                    f"pdf_calendar_extract: unknown label '{c_raw}' on {iso}\n"
                )
        i += 2
    return days


def _summary(days):
    by_code, inst = {}, 0
    for d in days:
        code = str(d["cycleDay"]) if d["isInstructional"] else (d["holidayCode"] or "?")
        by_code[code] = by_code.get(code, 0) + 1
        if d["isInstructional"]:
            inst += 1
    return {
        "totalDays": len(days),
        "instructionalDays": inst,
        "paDays": by_code.get("E", 0) + by_code.get("ES", 0) + by_code.get("0", 0),
        "mandatoryHolidays": by_code.get("M", 0),
        "boardHolidays": by_code.get("B", 0),
        "dayZeros": by_code.get("0", 0),
        "monthsCovered": len({d["month"] for d in days}),
    }


def _extract_tables(page):
    """Line strategy first; fall back to text on ambiguous rulings."""
    try:
        tables = page.extract_tables(
            table_settings={"vertical_strategy": "lines",
                            "horizontal_strategy": "lines",
                            "intersection_tolerance": 5}
        ) or []
        if tables:
            return tables
    except Exception:
        pass
    try:
        return page.extract_tables(
            table_settings={"vertical_strategy": "text",
                            "horizontal_strategy": "text",
                            "snap_tolerance": 3}
        ) or []
    except Exception:
        return []


def main():
    if len(sys.argv) < 2:
        _fail("invalid_args", "Usage: pdf_calendar_extract.py <pdf-path>")
        return 2
    pdf_path = sys.argv[1]
    if not os.path.isfile(pdf_path):
        _fail("file_not_found", f"No such file: {pdf_path}")
        return 2

    timeout_ms = os.environ.get("PDF_PARSE_TIMEOUT_MS", "8000")
    try:
        timeout_sec = max(1, int(timeout_ms) // 1000)
    except ValueError:
        timeout_sec = 8
    signal.signal(signal.SIGALRM, lambda *_: (
        sys.stderr.write("pdf_calendar_extract: timeout\n"), sys.exit(124)))
    signal.alarm(timeout_sec)

    try:
        import pdfplumber  # type: ignore[import-not-found]
    except ImportError as err:
        _fail("pdfplumber_missing", str(err))
        return 1

    started = time.monotonic()
    try:
        with pdfplumber.open(pdf_path) as pdf:
            meta = dict(pdf.metadata or {})
            first_year = _detect_school_year_first(meta)
            all_days, total_chars = [], 0
            for page in pdf.pages:
                total_chars += len(page.chars or [])
                for tbl in _extract_tables(page):
                    all_days.extend(_parse_calendar_table(tbl, first_year))
    except Exception as err:  # noqa: BLE001
        sys.stderr.write(traceback.format_exc())
        _fail("pdfplumber_crashed", str(err))
        return 1
    finally:
        signal.alarm(0)

    elapsed_ms = int((time.monotonic() - started) * 1000)
    sys.stderr.write(
        f"pdf_calendar_extract: days={len(all_days)} text_chars={total_chars} "
        f"elapsed_ms={elapsed_ms}\n"
    )

    if total_chars == 0:
        _fail("scanned_pdf", "PDF has no text layer (image-only). Re-export from Word/Google Docs or run OCR first.")
        return 3
    if not all_days:
        _fail("no_usable_calendar",
              "Could not locate the calendar grid (no '1ST WEEK' header row found). "
              "This PDF is not a 5-day-cycle elementary calendar template.")
        return 4

    sys.stdout.write(json.dumps({
        "ok": True,
        "calendar": {"title": (meta or {}).get("Title", "") or "",
                     "schoolYear": str(first_year)},
        "days": all_days,
        "summary": _summary(all_days),
    }))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())