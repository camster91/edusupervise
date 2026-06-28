/**
 * cycle-math tests — covers every edge case in spec section 12.
 *
 * Pure-function tests, no DB required. All dates are UTC; the cycle
 * math intentionally ignores time-of-day so the tests do not have to
 * worry about DST or timezone shifts.
 */
import { describe, expect, it } from 'vitest';
import {
  addMonthsUtc,
  cycleDayForDate,
  firstMondayOfSeptember,
} from './cycle-math.js';

const SCHOOL = {
  schoolYearStart: new Date(Date.UTC(2026, 8, 7)), // Mon Sep 7 2026
  schoolYearEnd: new Date(Date.UTC(2027, 5, 30)), // Wed Jun 30 2027
  cycleDays: 5,
} as const;

function utc(y: number, m: number, d: number): Date {
  // Month is 0-indexed.
  return new Date(Date.UTC(y, m, d));
}

describe('cycleDayForDate', () => {
  it('returns 1 on the first day of the school year (no calendar override)', () => {
    expect(cycleDayForDate(SCHOOL.schoolYearStart, SCHOOL)).toBe(1);
  });

  it('returns cycleDays on the last cycle-aligned day within the school year', () => {
    // School year starts Sep 7 2026 (Mon). With cycleDays=5, the days
    // are: Sep 7=1, Sep 8=2, Sep 9=3, Sep 10=4, Sep 11=5, Sep 12=1, ...
    expect(cycleDayForDate(utc(2026, 8, 11), SCHOOL)).toBe(5);
  });

  it('wraps modulo after cycleDays (Sep 12 = cycle day 1)', () => {
    expect(cycleDayForDate(utc(2026, 8, 12), SCHOOL)).toBe(1);
    expect(cycleDayForDate(utc(2026, 8, 13), SCHOOL)).toBe(2);
    expect(cycleDayForDate(utc(2026, 8, 18), SCHOOL)).toBe(2); // 11 days after start
  });

  it('returns the right cycle day for the school year END (last in-year day)', () => {
    // schoolYearEnd is Jun 30 2027. Days since Sep 7 2026: ~296 days.
    // 296 % 5 = 1, so cycle day = 2.
    expect(cycleDayForDate(SCHOOL.schoolYearEnd, SCHOOL)).toBe(2);
  });

  it('returns null for a day BEFORE school_year_start', () => {
    expect(cycleDayForDate(utc(2026, 8, 6), SCHOOL)).toBeNull();
    expect(cycleDayForDate(utc(2025, 11, 31), SCHOOL)).toBeNull();
  });

  it('returns null for a day AFTER school_year_end', () => {
    expect(cycleDayForDate(utc(2027, 6, 1), SCHOOL)).toBeNull();
    expect(cycleDayForDate(utc(2027, 11, 31), SCHOOL)).toBeNull();
  });

  it('handles a 6-day cycle (cycleDays=6) for non-traditional calendars', () => {
    const school = { ...SCHOOL, cycleDays: 6 };
    expect(cycleDayForDate(utc(2026, 8, 7), school)).toBe(1);
    expect(cycleDayForDate(utc(2026, 8, 12), school)).toBe(6);
    expect(cycleDayForDate(utc(2026, 8, 13), school)).toBe(1); // wraps
  });

  it('handles a 1-day cycle (every day is cycle day 1)', () => {
    const school = { ...SCHOOL, cycleDays: 1 };
    expect(cycleDayForDate(utc(2026, 8, 7), school)).toBe(1);
    expect(cycleDayForDate(utc(2026, 11, 25), school)).toBe(1);
    expect(cycleDayForDate(utc(2027, 0, 15), school)).toBe(1);
  });

  it('handles a 10-day cycle (max allowed by schools.cycle_days CHECK)', () => {
    const school = { ...SCHOOL, cycleDays: 10 };
    expect(cycleDayForDate(utc(2026, 8, 7), school)).toBe(1);
    expect(cycleDayForDate(utc(2026, 8, 16), school)).toBe(10);
    expect(cycleDayForDate(utc(2026, 8, 17), school)).toBe(1); // wraps
  });

  describe('leap year (Feb 29)', () => {
    // 2024 is a leap year; 2028 is also a leap year.
    it('returns a valid cycle day for Feb 29 in a leap year within the school year', () => {
      const school = {
        schoolYearStart: new Date(Date.UTC(2023, 8, 4)), // Mon Sep 4 2023
        schoolYearEnd: new Date(Date.UTC(2024, 5, 30)), // Sun Jun 30 2024
        cycleDays: 5,
      };
      // Feb 29 2024 is day #178 from Sep 4 2023. 178 % 5 = 3, so cycle day = 4.
      expect(cycleDayForDate(utc(2024, 1, 29), school)).toBe(4);
    });

    it('treats Feb 29 like any other date (no special handling)', () => {
      // The spec says: "the modulo math treats Feb 29 like any other
      // date. If a school's cycle doesn't normally include Feb 29 (most
      // don't, since it's not a school day), it's effectively skipped."
      // Concretely: cycle math just runs the formula. It is the caller's
      // responsibility to mark Feb 29 as a non-school day via the
      // cycle_calendar override if it falls on a weekend.
      const school = {
        schoolYearStart: new Date(Date.UTC(2024, 1, 29)), // Feb 29 2024 (Thursday)
        schoolYearEnd: new Date(Date.UTC(2024, 1, 29)),
        cycleDays: 5,
      };
      // school_year_start = school_year_end = Feb 29. The function
      // should return 1 (days since start = 0, 0 % 5 + 1 = 1).
      expect(cycleDayForDate(utc(2024, 1, 29), school)).toBe(1);
    });
  });

  describe('calendar entry override', () => {
    it('returns the override cycle_day when is_school_day = true', () => {
      const entry = { cycleDay: 3, isSchoolDay: true };
      // The override wins over the formula — even if the date would
      // normally be cycle day 1, we return 3.
      expect(cycleDayForDate(SCHOOL.schoolYearStart, SCHOOL, entry)).toBe(3);
    });

    it('returns null when is_school_day = false (PD day / snow day / holiday)', () => {
      const entry = { cycleDay: 3, isSchoolDay: false };
      expect(cycleDayForDate(SCHOOL.schoolYearStart, SCHOOL, entry)).toBeNull();
    });

    it('returns null when is_school_day = true and cycle_day = null (deferred)', () => {
      // Edge case: the spec allows cycle_day to be NULL even when
      // is_school_day is true. This is a "we know it's a school day but
      // we haven't decided which cycle day yet" placeholder. Return
      // null so the caller doesn't fire reminders on a half-baked day.
      const entry = { cycleDay: null, isSchoolDay: true };
      expect(cycleDayForDate(SCHOOL.schoolYearStart, SCHOOL, entry)).toBeNull();
    });

    it('the override wins even for dates OUTSIDE the school year', () => {
      // The spec lists the override check first. An admin could (rarely)
      // mark a non-school-year date as a school day for summer school.
      const schoolYearDate = utc(2026, 7, 1); // Aug 1 2026, before Sep 7 start
      const entry = { cycleDay: 2, isSchoolDay: true };
      expect(cycleDayForDate(schoolYearDate, SCHOOL, entry)).toBe(2);
    });
  });

  describe('14-month cap boundary', () => {
    // Spec section 12: school_year_end can be at most school_year_start
    // + 14 months. This is enforced at the DB level (CHECK constraint)
    // AND at the rollover UI, but cycle math itself accepts any range.
    // The boundary tests verify the formula behaves sanely at the
    // 14-month edge.
    it('handles a 14-month school year end-to-end without wrapping', () => {
      const school = {
        schoolYearStart: new Date(Date.UTC(2025, 8, 1)), // Sep 1 2025
        schoolYearEnd: new Date(Date.UTC(2026, 9, 31)), // Oct 31 2026 (~14 months)
        cycleDays: 5,
      };
      // Last day in range.
      expect(cycleDayForDate(utc(2026, 9, 31), school)).not.toBeNull();
    });

    it('returns null for the day AFTER a 14-month school year ends', () => {
      const school = {
        schoolYearStart: new Date(Date.UTC(2025, 8, 1)),
        schoolYearEnd: new Date(Date.UTC(2026, 9, 31)),
        cycleDays: 5,
      };
      expect(cycleDayForDate(utc(2026, 10, 1), school)).toBeNull();
    });

    it('the day BEFORE the school year start returns null even for long years', () => {
      const school = {
        schoolYearStart: new Date(Date.UTC(2025, 8, 1)),
        schoolYearEnd: new Date(Date.UTC(2026, 9, 31)),
        cycleDays: 5,
      };
      expect(cycleDayForDate(utc(2025, 7, 31), school)).toBeNull();
    });
  });
});

describe('firstMondayOfSeptember', () => {
  it('returns Sep 1 when Sep 1 falls on a Monday (2025)', () => {
    // 2025-09-01 is a Monday.
    expect(firstMondayOfSeptember(2025)).toEqual(utc(2025, 8, 1));
  });

  it('returns Sep 7 when Sep 1 falls on a Sunday (2024)', () => {
    // 2024-09-01 is a Sunday → first Monday is Sep 2.
    expect(firstMondayOfSeptember(2024)).toEqual(utc(2024, 8, 2));
  });

  it('returns Sep 7 when Sep 1 falls on a Tuesday (2026)', () => {
    // 2026-09-01 is a Tuesday → first Monday is Sep 7.
    expect(firstMondayOfSeptember(2026)).toEqual(utc(2026, 8, 7));
  });

  it('returns Sep 6 when Sep 1 falls on a Wednesday (2027)', () => {
    // 2027-09-01 is a Wednesday → first Monday is Sep 6.
    expect(firstMondayOfSeptember(2027)).toEqual(utc(2027, 8, 6));
  });

  it('always returns a date in September', () => {
    for (let y = 2020; y < 2040; y++) {
      const d = firstMondayOfSeptember(y);
      expect(d.getUTCMonth()).toBe(8); // September
      expect(d.getUTCDate()).toBeGreaterThanOrEqual(1);
      expect(d.getUTCDate()).toBeLessThanOrEqual(7);
    }
  });
});

describe('addMonthsUtc', () => {
  it('adds 1 month to a mid-month date', () => {
    expect(addMonthsUtc(utc(2026, 0, 15), 1)).toEqual(utc(2026, 1, 15));
  });

  it('clamps to the last day of the target month when source day does not exist', () => {
    // Jan 31 + 1 month = Feb 28 (or 29 in leap years).
    expect(addMonthsUtc(utc(2026, 0, 31), 1)).toEqual(utc(2026, 1, 28));
    // Jan 31 + 1 month in a leap year = Feb 29.
    expect(addMonthsUtc(utc(2024, 0, 31), 1)).toEqual(utc(2024, 1, 29));
    // Aug 31 + 1 month = Sep 30 (Sep has 30 days).
    expect(addMonthsUtc(utc(2026, 7, 31), 1)).toEqual(utc(2026, 8, 30));
  });

  it('handles year rollover (Dec + 1 month = next Jan)', () => {
    expect(addMonthsUtc(utc(2026, 11, 15), 1)).toEqual(utc(2027, 0, 15));
  });

  it('handles multi-month additions (10 months for school year)', () => {
    // Sep 7 2026 + 10 months = Jul 7 2027.
    expect(addMonthsUtc(utc(2026, 8, 7), 10)).toEqual(utc(2027, 6, 7));
  });
});
