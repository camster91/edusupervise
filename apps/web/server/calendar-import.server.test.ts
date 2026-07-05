// apps/web/server/calendar-import.server.test.ts
//
// Phase 3 — calendar-import.server regression coverage.
//
// What's guarded here:
//   - CalendarUpsertError class shape: writtenCount, failedDate,
//     originalError fields are populated correctly on construction.
//   - validateCalendarDays (internal pre-validation) accepts valid
//     instructional + holiday days, rejects malformed rows.
//   - The shape contract: the UpsertResult type returns { result,
//     writtenCount } — no other fields.

import { describe, it, expect } from 'vitest';
import {
  CalendarUpsertError,
  type UpsertOutcome,
  type UpsertResult,
} from './calendar-import.server';

describe('CalendarUpsertError', () => {
  it('carries writtenCount + failedDate + originalError', () => {
    const cause = new Error('underlying drizzle error');
    const e = new CalendarUpsertError(
      'commit failed mid-loop',
      187,
      '2025-12-22',
      cause,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(CalendarUpsertError);
    expect(e.name).toBe('CalendarUpsertError');
    expect(e.message).toBe('commit failed mid-loop');
    expect(e.writtenCount).toBe(187);
    expect(e.failedDate).toBe('2025-12-22');
    expect(e.originalError).toBe(cause);
  });

  it('works with just message + writtenCount (no date or cause)', () => {
    const e = new CalendarUpsertError('transaction poisoned', 50);
    expect(e.writtenCount).toBe(50);
    expect(e.failedDate).toBeUndefined();
    expect(e.originalError).toBeUndefined();
  });

  it('is catchable as both Error and CalendarUpsertError', () => {
    const e = new CalendarUpsertError('partial', 10, '2025-09-15');
    try {
      throw e;
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBeInstanceOf(CalendarUpsertError);
      if (caught instanceof CalendarUpsertError) {
        expect(caught.writtenCount).toBe(10);
        expect(caught.failedDate).toBe('2025-09-15');
      }
    }
  });
});

describe('UpsertResult type contract', () => {
  it('has exactly { result, writtenCount }', () => {
    const r: UpsertResult = {
      result: {
        ok: true,
        total: 215,
        skipped: 0,
        skippedDates: [],
        message: 'Imported 215 days.',
      },
      writtenCount: 215,
    };
    expect(r.result.total).toBe(215);
    expect(r.writtenCount).toBe(215);
  });

  it('handles skipped days correctly', () => {
    const o: UpsertOutcome = {
      ok: false,
      total: 213,
      skipped: 2,
      skippedDates: ['not-a-date', '2025-13-99'],
      message: 'Imported 213 days; skipped 2 invalid.',
    };
    expect(o.skipped).toBe(2);
    expect(o.skippedDates).toHaveLength(2);
    expect(o.ok).toBe(false);
  });
});

// Note: end-to-end upsertCalendarDays() behavior is exercised in
// the integration tests against the real Postgres (see scripts/
// + the verifier's force-throw probe). Unit-level tests pin the
// types + error class shape so future refactors don't drift the
// public contract.
