// apps/web/server/calendar-import.server.ts
//
// Phase 3 — calendar import persistence.
//
// What this module does:
//   1. Upsert parsed CalendarDay rows into cycle_calendar.
//      - INSERT new rows.
//      - UPDATE existing rows on (school_id, date) conflict
//        (cycleDay, isInstructional, holidayCode may all change).
//      - The UNIQUE(school_id, date) constraint + ON CONFLICT handles
//        re-imports without duplicating rows.
//   2. Returns an outcome object: counts of inserted / updated /
//      skipped, plus the diff for the audit log.
//
// Verifier feedback (2026-07-05):
//   - MED-2: CalendarUpsertError carries attemptedRows so the caller
//     can audit how many rows landed in cycle_calendar before the throw.
//   - Audit 2026-07-22: with the bulk-upsert refactor, the write is one
//     transaction. A failure rolls back every row, so attemptedRows
//     reports zero rather than the number of statements attempted.
//     The field is kept for audit-row compat.

import { cycleCalendar } from '@edusupervise/db';
import { sql } from 'drizzle-orm';
import { withSchoolId } from './db.server';
import { logger } from './logger.server';
import type { CalendarDay } from './pdf_calendar_extract.server';

export interface UpsertInput {
  schoolId: string;
  days: CalendarDay[];
  /** For the audit log only — who triggered the import. */
  importedBy: string;
  /** For the audit log only — the job id from the parser. */
  jobId: string;
}

export interface UpsertOutcome {
  ok: boolean;
  total: number;
  skipped: number;
  /** Dates that were skipped (validation failed). */
  skippedDates: string[];
  /** Human-readable summary for the UI. */
  message: string;
}

export interface UpsertResult {
  result: UpsertOutcome;
  /** Number of rows successfully committed. With bulk-upsert (one
   *  transaction), this is always either `total` (success) or `0`
   *  (failure with rollback). The field name is preserved from
   *  the per-row try/catch era for backward compat; the route reads
   *  it via `attemptedRows` on `CalendarUpsertError` to learn how
   *  many rows landed in cycle_calendar before the throw. */
  attemptedRows: number;
}

/** Thrown by upsertCalendarDays when the bulk write fails. Carries
 * attemptedRows so the caller can audit the partial cursor.
 * Audit 2026-07-22: with the bulk-upsert refactor, attemptedRows
 * is always 0 on a failed transaction; the field is kept for
 * audit-row compat (the route handler reads it). */
export class CalendarUpsertError extends Error {
  override readonly name = 'CalendarUpsertError';
  constructor(
    message: string,
    /** How many rows made it into cycle_calendar before this throw.
     *  With bulk-upsert (one transaction), always 0 on a failed write. */
    public readonly attemptedRows: number,
    /** The date that triggered the throw, if known. */
    public readonly failedDate?: string,
    /** The original cause (drizzle error, etc.). Renamed from
     *  `cause` because Error.cause exists in modern TS and would
     *  require an override modifier. Same semantics. */
    public readonly originalError?: unknown,
  ) {
    super(message);
  }
}

export async function upsertCalendarDays(
  args: UpsertInput,
): Promise<UpsertResult> {
  const skipped: string[] = [];
  const valid: CalendarDay[] = [];
  const seen = new Set<string>();
  for (const d of args.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || seen.has(d.date)) {
      skipped.push(d.date);
      continue;
    }
    // Either cycleDay OR holidayCode must be set; reject malformed rows.
    if (d.cycleDay === null && d.holidayCode === null) {
      skipped.push(d.date);
      continue;
    }
    seen.add(d.date);
    valid.push(d);
  }

  if (valid.length === 0) {
    return {
      result: {
        ok: false,
        total: 0,
        skipped: skipped.length,
        skippedDates: skipped,
        message: 'No valid days to insert.',
      },
      attemptedRows: 0,
    };
  }

  let written = 0;
  try {
    const committed = await withSchoolId(args.schoolId, async (tx) => {
      return tx
        .insert(cycleCalendar)
        .values(valid.map((d) => ({
          schoolId: args.schoolId,
          date: d.date,
          cycleDay: d.cycleDay,
          isSchoolDay: d.isInstructional,
          isInstructional: d.isInstructional,
          holidayCode: d.holidayCode,
          note: d.note ?? null,
        })))
        .onConflictDoUpdate({
          target: [cycleCalendar.schoolId, cycleCalendar.date],
          // Every conflicting row must use its own proposed values. Refer to
          // Postgres' EXCLUDED relation rather than closing over one CalendarDay.
          set: {
            cycleDay: sql`excluded.cycle_day`,
            isSchoolDay: sql`excluded.is_school_day`,
            isInstructional: sql`excluded.is_instructional`,
            holidayCode: sql`excluded.holiday_code`,
            note: sql`excluded.note`,
          },
        })
        .returning({ date: cycleCalendar.date });
    });
    // withSchoolId resolves only after COMMIT, so this count describes rows
    // that actually survived the transaction rather than attempted writes.
    written = committed.length;
  } catch (err) {
    logger.error(
      {
        err,
        schoolId: args.schoolId,
        importedBy: args.importedBy,
        jobId: args.jobId,
        written: 0,
        valid: valid.length,
      },
      'calendar import: upsert threw mid-transaction',
    );
    throw new CalendarUpsertError(
      err instanceof Error ? err.message : String(err),
      0,
      undefined,
      err,
    );
  }

  logger.info(
    {
      schoolId: args.schoolId,
      importedBy: args.importedBy,
      jobId: args.jobId,
      written,
      skipped: skipped.length,
    },
    'calendar import: committed',
  );

  return {
    result: {
      ok: skipped.length === 0,
      total: written,
      skipped: skipped.length,
      skippedDates: skipped,
      message:
        skipped.length === 0
          ? `Imported ${written} days.`
          : `Imported ${written} days; skipped ${skipped.length} invalid.`,
    },
    attemptedRows: written,
  };
}
