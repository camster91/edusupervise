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
//   - MED-2: per-row try/catch lets us count written rows BEFORE
//     throwing, then attach that count to a CalendarUpsertError so
//     the caller can audit both attemptedDays AND attemptedRows.

import { cycleCalendar } from '@edusupervise/db';
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
  /** Number of rows successfully committed. On partial-failure
   *  throws, this is the count that landed in cycle_calendar; the
   *  operator reads this from the audit row to know how many rows
   *  survived the throw. */
  attemptedRows: number;
}

/** Thrown by upsertCalendarDays when a per-row write fails. Carries
 *  attemptedRows so the caller can audit the partial cursor. */
export class CalendarUpsertError extends Error {
  override readonly name = 'CalendarUpsertError';
  constructor(
    message: string,
    /** How many rows made it into cycle_calendar before this throw. */
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
  for (const d of args.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) {
      skipped.push(d.date);
      continue;
    }
    // Either cycleDay OR holidayCode must be set; reject malformed rows.
    if (d.cycleDay === null && d.holidayCode === null) {
      skipped.push(d.date);
      continue;
    }
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

  // Per-row try/catch: a CHECK violation on row N still allows rows
  // 1..N-1 to commit (the txn rolls back at COMMIT, but our intent
  // here is "count what landed, then throw with the cursor"). Note:
  // because we run inside withSchoolId's transaction wrapper, a per-
  // row throw will poison the transaction and force a ROLLBACK at
  // the wrapper boundary. So `written` here counts LOGICAL writes
  // attempted before the throw, not rows that physically survived.
  // The audit row + a SELECT count(*) on cycle_calendar together
  // give operators the true partial cursor.
  let written = 0;
  try {
    await withSchoolId(args.schoolId, async (tx) => {
      for (const d of valid) {
        await tx
          .insert(cycleCalendar)
          .values({
            schoolId: args.schoolId,
            date: d.date,
            cycleDay: d.cycleDay,
            isSchoolDay: d.isInstructional,
            isInstructional: d.isInstructional,
            holidayCode: d.holidayCode,
            // Forward any parser note (currently unused; defense for
            // future parser changes that may emit annotations like
            // "exam day", "half day", etc.).
            note: d.note ?? null,
          })
          .onConflictDoUpdate({
            target: [cycleCalendar.schoolId, cycleCalendar.date],
            set: {
              cycleDay: d.cycleDay,
              isSchoolDay: d.isInstructional,
              isInstructional: d.isInstructional,
              holidayCode: d.holidayCode,
              note: d.note ?? null,
            },
          });
        written += 1;
      }
    });
  } catch (err) {
    logger.error(
      {
        err,
        schoolId: args.schoolId,
        importedBy: args.importedBy,
        jobId: args.jobId,
        written,
        valid: valid.length,
      },
      'calendar import: upsert threw mid-transaction',
    );
    throw new CalendarUpsertError(
      err instanceof Error ? err.message : String(err),
      written,
      valid[written]?.date,
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
