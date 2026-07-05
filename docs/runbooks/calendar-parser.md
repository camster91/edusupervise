# Calendar Parser — Runbook

Operational guide for `apps/web/server/pdf_calendar_extract.py`, the
Python helper that converts a 5-day-cycle elementary school calendar
PDF (YRDSB template) into a structured JSON list of school-session days.

This script is the calendar-import analog of `pdf_extract.py`, which
parses duty-roster PDFs. Same library, same exit-code contract, same
Node-wrapper pattern.

---

## 1. What it does

Reads a PDF calendar (one page, landscape, tabular grid) and emits one
JSON object per weekday in the school session (September through June
of the next calendar year). For each day it captures:

- The ISO date (`YYYY-MM-DD`)
- The cycle day (`1`-`5`) if it's an instructional day, else `null`
- Whether the day is instructional
- A holiday code (`B`, `E`, `ES`, `M`, or `0`) for non-instructional days

The Node wrapper (`apps/web/server/calendar-parser.server.ts` — to be
written by the backend coder) consumes this JSON, maps the holiday
codes to friendly names (`M` on Sept 1 → "Labour Day"), and writes
the days into Postgres.

The script does **not** do cycle-day scoring or holiday-name mapping —
those are Node-side concerns and would couple this script to a specific
district.

---

## 2. CLI invocation

```bash
# Basic — uses PDF_PARSE_TIMEOUT_MS=8000 default.
python3 pdf_calendar_extract.py /path/to/calendar.pdf

# Tighter timeout (e.g. for the web container's request handler).
PDF_PARSE_TIMEOUT_MS=4000 python3 pdf_calendar_extract.py /path/to/calendar.pdf

# Override school year (default: auto-detect from PDF metadata Title).
SCHOOL_YEAR_START=2026 python3 pdf_calendar_extract.py /path/to/2026-2027-calendar.pdf
```

### Environment variables

| Var                    | Default | Purpose                                                                |
|------------------------|---------|------------------------------------------------------------------------|
| `PDF_PARSE_TIMEOUT_MS` | `8000`  | Hard kill timer. Enforced via `signal.alarm`. Exit `124` on overrun. |
| `SCHOOL_YEAR_START`    | auto    | Override the auto-detected first calendar year. 4-digit int.         |

### Exit codes

| Code | Meaning                | UI surface                                                       |
|------|------------------------|------------------------------------------------------------------|
| `0`  | Success                | Parse OK, proceed to ingest.                                    |
| `1`  | Generic error          | `pdfplumber_crashed` or `pdfplumber_missing`. Show "we hit an error, re-upload". |
| `2`  | Invalid args           | `invalid_args` or `file_not_found`. Node wrapper bug or bad path. |
| `3`  | Scanned PDF            | `scanned_pdf`. UI: "Please re-export from Word/Google Docs or run OCR." |
| `4`  | No usable calendar     | `no_usable_calendar`. UI: "This PDF isn't a 5-day-cycle elementary calendar." |
| `124`| Timeout                | UI: "Parsing took too long, try again or use a smaller PDF."    |

---

## 3. Output JSON schema

### Top-level envelope

```json
{
  "ok": true,
  "calendar": {
    "title": "5-Day Cycle Calendar 2025-2026.xlsx",
    "schoolYear": "2025"
  },
  "days": [ ... ],
  "summary": { ... }
}
```

### Day entry (one per weekday in the school session)

```json
{
  "date": "2025-09-02",
  "month": 9,
  "day": 2,
  "weekday": "Tuesday",
  "cycleDay": 1,
  "isInstructional": true,
  "holidayCode": null
}
```

Field reference:

| Field              | Type           | Notes                                                                |
|--------------------|----------------|----------------------------------------------------------------------|
| `date`             | string         | ISO `YYYY-MM-DD`.                                                    |
| `month`            | int 1-12       | Calendar month number.                                               |
| `day`              | int 1-31       | Calendar day of month.                                               |
| `weekday`          | string         | `"Monday"` .. `"Friday"`. Weekends are not emitted (out-of-month).   |
| `cycleDay`         | int 1-5 / null | The rotation day for instructional days; `null` on holidays/PA days. |
| `isInstructional`  | bool           | `true` iff there's a cycle day (i.e. `cycleDay` is 1-5).            |
| `holidayCode`      | string / null  | One of `B` / `E` / `ES` / `M` / `0` / `null`. See legend below.      |

### Holiday codes

| Code | Meaning                                                              |
|------|----------------------------------------------------------------------|
| `B`  | Board Holiday (winter break, mid-winter break, March break).         |
| `E`  | Elementary Professional Activity Day.                                |
| `ES` | Elementary/Secondary Professional Activity Day.                      |
| `M`  | Mandatory Holiday (Labour Day, Good Friday, Easter Monday, etc.).    |
| `0`  | Day-zero PA day (YRDSB convention: June 24 & 25). Non-cycle, non-instructional. |

### Summary

```json
{
  "totalDays": 215,
  "instructionalDays": 185,
  "paDays": 9,
  "mandatoryHolidays": 8,
  "boardHolidays": 13,
  "dayZeros": 2,
  "monthsCovered": 10
}
```

`totalDays` is the count of weekdays emitted (Mon-Fri in the school
session, weekends excluded). `instructionalDays + paDays + mandatoryHolidays + boardHolidays = totalDays`. Note that `dayZeros` is a subset of `paDays` (the `0`-coded days specifically).

### Sample entry from the YRDSB 2025-2026 fixture

The full output is at `devops/fixtures/sample-calendar-output.json`
(28 KB, 215 days). A few illustrative entries:

```json
[
  {"date": "2025-09-01", "month": 9,  "day": 1,  "weekday": "Monday",
   "cycleDay": null, "isInstructional": false, "holidayCode": "M"},

  {"date": "2025-09-02", "month": 9,  "day": 2,  "weekday": "Tuesday",
   "cycleDay": 1,    "isInstructional": true,  "holidayCode": null},

  {"date": "2025-09-26", "month": 9,  "day": 26, "weekday": "Friday",
   "cycleDay": null, "isInstructional": false, "holidayCode": "ES"},

  {"date": "2025-12-25", "month": 12, "day": 25, "weekday": "Thursday",
   "cycleDay": null, "isInstructional": false, "holidayCode": "M"},

  {"date": "2026-01-05", "month": 1,  "day": 5,  "weekday": "Monday",
   "cycleDay": 1,    "isInstructional": true,  "holidayCode": null},

  {"date": "2026-06-24", "month": 6,  "day": 24, "weekday": "Wednesday",
   "cycleDay": null, "isInstructional": false, "holidayCode": "0"}
]
```

---

## 4. Testing locally

### One-shot parse against a fixture

```bash
# From the repo root (uses docs/fixtures/ as the source).
python3 apps/web/server/pdf_calendar_extract.py \
    docs/fixtures/2025-2026-5Day-Cycle-Calendar.pdf \
    > /tmp/cal.json 2>/tmp/cal.err
echo "exit=$?"; cat /tmp/cal.err
python3 -m json.tool /tmp/cal.json | head -40
python3 -c "import json; d=json.load(open('/tmp/cal.json')); print('days:', len(d['days']), 'summary:', d['summary'])"
```

### Inside the web container

The web container already ships Python 3 + pdfplumber 0.11.4 (Phase 2,
2026-07-04). So:

```bash
docker compose exec web python3 apps/web/server/pdf_calendar_extract.py \
    /app/uploads/<staged-pdf>.pdf > /tmp/cal.json
```

Or, more realistically, the Node wrapper invokes this script via
`execFile` with `PDF_PARSE_TIMEOUT_MS` set. The script writes JSON to
stdout; the wrapper reads stdout.

### Failure-mode smoke tests

```bash
# Scanned PDF (no text layer) — exit 3.
python3 apps/web/server/pdf_calendar_extract.py /path/to/scanned.pdf
# {"ok": false, "error": "scanned_pdf", "detail": "..."}

# Missing arg — exit 2.
python3 apps/web/server/pdf_calendar_extract.py
# {"ok": false, "error": "invalid_args", "detail": "Usage: pdf_calendar_extract.py <pdf-path>"}

# Non-existent file — exit 2.
python3 apps/web/server/pdf_calendar_extract.py /nope.pdf
# {"ok": false, "error": "file_not_found", "detail": "No such file: /nope.pdf"}

# Wrong-shape PDF (e.g. a duty roster) — exit 4.
python3 apps/web/server/pdf_calendar_extract.py docs/fixtures/duty-roster.pdf
# {"ok": false, "error": "no_usable_calendar", "detail": "..."}

# Timeout — exit 124.
PDF_PARSE_TIMEOUT_MS=1 python3 apps/web/server/pdf_calendar_extract.py \
    docs/fixtures/2025-2026-5Day-Cycle-Calendar.pdf
# stderr: "pdf_calendar_extract: timeout" ; exit 124
```

---

## 5. Troubleshooting

### `pdfplumber_missing`

```json
{"ok": false, "error": "pdfplumber_missing", "detail": "No module named 'pdfplumber'"}
```

The script cannot import `pdfplumber`. The web container ships it
(Dockerfile.web, lines 33-37 — Phase 2 install). If you see this in
production, the runtime image was built without the Phase 2 install
step, or the image is stale. Fix:

```bash
docker compose build --no-cache web
docker compose up -d web
docker compose exec web python3 -c "import pdfplumber; print(pdfplumber.__version__)"
# expect: 0.11.4
```

If running outside the container (CI, local dev), install:

```bash
pip3 install --break-system-packages 'pdfplumber==0.11.4'
```

### `scanned_pdf` (exit 3)

```json
{"ok": false, "error": "scanned_pdf", "detail": "PDF has no text layer (image-only). Re-export from Word/Google Docs or run OCR first."}
```

The PDF is image-only (a scan or fax). pdfplumber found zero text
characters. Ask the user to re-export from the original authoring
tool — for the YRDSB template, that's usually an Excel file → print
to PDF (not "save as PDF" from Excel which can flatten the text).

If a vision-model fallback is needed in the future, this is the
extension point. Currently out of scope per Phase 3.

### `timeout` (exit 124)

The script killed itself via `signal.alarm` because `PDF_PARSE_TIMEOUT_MS`
elapsed. pdfplumber has no internal cancellation, so the alarm is the
only way to bound runtime. Two common causes:

1. **Oversized PDF.** The YRDSB fixture is ~27 KB and parses in ~200 ms.
   A multi-school mega-calendar could push past 4-8 seconds. Bump the
   timeout (`PDF_PARSE_TIMEOUT_MS=20000`) and retry.
2. **Memory pressure in the container.** Check `docker stats web` and
   the container's mem_limit (1.5 GB in `docker-compose.yml`).

### `no_usable_calendar` (exit 4)

```json
{"ok": false, "error": "no_usable_calendar", "detail": "Could not locate the calendar grid (no '1ST WEEK' header row found). This PDF is not a 5-day-cycle elementary calendar template."}
```

The PDF has text but the calendar grid signature is missing. Possible
causes:

1. **Wrong template.** This script only handles 5-day-cycle elementary
   calendars. A 10-day-cycle secondary calendar, a semester-block
   college calendar, or a custom district format will all hit this.
   The Node wrapper should branch on `school_id` / `cycle_type` and
   route to a different extractor.
2. **Layout shift in the source.** The YRDSB template has been stable
   for years, but if a board redesigns their PDF (e.g. drops the
   "1ST WEEK" header), the script needs a follow-up. Look at the
   `pdfplumber` line-strategy output to confirm — see
   `devops/fixtures/probe.json` for what the fixture looks like.
3. **Scanned PDF that snuck past the text-layer check.** Some PDFs
   have minimal text (a single OCR'd line) that registers as
   `text_chars > 0` but the table is still image-based. Future
   improvement: validate that the table has the expected row count
   (10 months × 2 rows = 20+ data rows).

### `unknown label` on stderr

```
pdf_calendar_extract: unknown label 'X' on 2025-09-15
```

A cycle-row cell had a value that isn't in `CYCLE_LABELS` or
`HOLIDAY_CODES`. Currently this is silently treated as
non-instructional (the day is still emitted) but a stderr warning is
logged. The current fixture only emits warnings for legitimate "0"
labels which are now recognized; future template variants may
introduce new codes. Add the new code to `HOLIDAY_CODES` (or a new
map) and re-test.

---

## 6. Container-side

The script lives at `apps/web/server/pdf_calendar_extract.py` inside
the `web` container at the same path. The runtime image already has:

- `python3` (from `apk add --no-cache python3 py3-pip`)
- `pdfplumber==0.11.4` (from `pip3 install --no-cache-dir --break-system-packages 'pdfplumber==0.11.4'`)

Both are installed in `docker/Dockerfile.web`. No additional setup
is needed for the calendar extractor to work — it piggybacks on the
Phase 2 (2026-07-04) install for the duty-roster extractor.

The web container has `tmpfs: ["/tmp", "/var/tmp"]` and a host
bind-mount `/data/uploads:/app/uploads` (mode 2775, set in the
Dockerfile). The Node wrapper stages the uploaded PDF at
`/app/uploads/<job-id>.pdf`, invokes the script with that path, reads
stdout, and parses the JSON. Output is never written to disk by the
Python script — it goes straight to stdout for the Node side.

### Quick health check

```bash
# Confirm python3 + pdfplumber in the container.
docker compose exec web python3 -c "
import pdfplumber
print('pdfplumber:', pdfplumber.__version__)
"

# Confirm the script is reachable.
docker compose exec web ls -la apps/web/server/pdf_calendar_extract.py
docker compose exec web python3 apps/web/server/pdf_calendar_extract.py \
    /dev/null 2>&1
# expect: {"ok": false, "error": "file_not_found", ...}
```

---

## 7. Related files

- `apps/web/server/pdf_extract.py` — duty-roster parser (sibling).
- `apps/web/server/pdf-parser.server.ts` — Node wrapper for duty-roster
  parser. The calendar wrapper will follow the same `execFile` pattern.
- `docker/Dockerfile.web` — installs Python 3 + pdfplumber.
- `docker/docker-compose.yml` — web service definition; tmpfs + uploads.
- `docs/fixtures/2025-2026-5Day-Cycle-Calendar.pdf` — YRDSB 2025-2026
  calendar fixture (the script was developed against this).