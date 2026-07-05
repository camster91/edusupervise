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
// Why a dedicated module (not inline in the route):
//   - Tests need to call upsertCalendar without booting the route.
//   - Future Phase 4 features (custom rotations, multi-school) reuse it.

import { and, eq, sql } from 'drizzle-orm';
import {
  cycleCalendar,
} from '@edusupervise/db';
import { getDb, withSchoolId } from './db.server';
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

export async function upsertCalendarDays(
  args: UpsertInput,
): Promise<UpsertOutcome> {
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
      ok: false,
      total: 0,
      skipped: skipped.length,
      skippedDates: skipped,
      message: 'No valid days to insert.',
    };
  }

  let written = 0;
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
          note: null,
        })
        .onConflictDoUpdate({
          target: [cycleCalendar.schoolId, cycleCalendar.date],
          set: {
            cycleDay: d.cycleDay,
            isSchoolDay: d.isInstructional,
            isInstructional: d.isInstructional,
            holidayCode: d.holidayCode,
          },
        });
      written += 1;
    }
  });

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

  // Touch getDb() so the import is side-effect-free at module load
  // (avoids the cold-start cost when the route is hit).
  void getDb();

  return {
    ok: skipped.length === 0,
    total: written,
    skipped: skipped.length,
    skippedDates: skipped,
    message:
      skipped.length === 0
        ? `Imported ${written} days.`
        : `Imported ${written} days; skipped ${skipped.length} invalid.`,
  };
}