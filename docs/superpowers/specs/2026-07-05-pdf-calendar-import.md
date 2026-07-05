# PDF calendar import — feature spec (2026-07-05)

## Why this exists

Teachers send Cameron their school's instructional calendar as a PDF
(months x day-of-week grid with PA-day / holiday codes). Right now the
only way to populate `cycle_calendar` is to type every date in one-by-one.

## What ships

A teacher uploads their school calendar PDF → system populates
`cycle_calendar` (date, cycleDay, isSchoolDay=false on PA/holidays).

## Out of scope (later)

- Auto-skip reminders on non-instructional days (depends on #1)
- Auto-compute cycle day per duty (depends on #1)

## Acceptance

- Calendar PDF upload via multipart (CSRF + role-gated to school_admin).
- Parser extracts: month, day-of-month, weekday, cycle-day-number,
  holiday-code (B/E/ES/M).
- Migration 0013 adds `is_instructional` + `holiday_code` to
  `cycle_calendar` (defaults: existing rows set is_instructional=true).
- Idempotent re-upload (same PDF → no rows changed; same school +
  different PDF → merges by date).
- Audit row per import.
- 8-12 unit tests + 1 smoke script.

## File layout (tentative)

- `apps/web/server/pdf_calendar_extract.py` — Python pdfplumber script
- `apps/web/server/pdf-calendar-parser.server.ts` — TS wrapper (parallel
  to `pdf-parser.server.ts`)
- `apps/web/app/routes/api.onboarding.upload-calendar.ts` — multipart
  action with CSRF + role check
- `apps/web/app/routes/onboarding.teacher._index.tsx` — UI: add
  Upload school calendar button when calendar is empty
- `packages/db/migrations/0013_cycle_calendar_columns.sql` — schema

## Status

- Fixture saved: `docs/fixtures/2025-2026-5Day-Cycle-Calendar.pdf`
- Spec pending Cameron review (scope confirmation first)
