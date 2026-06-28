/**
 * Cycle math — see spec section 12.
 *
 * Each school has a `cycle_days` (1..10, typically 5) and a school year
 * `[school_year_start, school_year_end]`. For any date, the cycle day
 * is either:
 *   1. Explicitly set in `cycle_calendar` (admin override) — null if the
 *      day is a non-school day (PD day, snow day, holiday).
 *   2. Computed as `(daysSinceStart % cycleDays) + 1` if the date is in
 *      `[school_year_start, school_year_end]` and no override exists.
 *   3. `null` if the date is outside the school year.
 *
 * The function is pure — no I/O, no Date.now() — so it is trivially
 * testable and safe to call from any request handler.
 *
 * Time-of-day is intentionally NOT considered. A duty that runs at 8:30
 * AM on cycle_day 1 fires for every date whose cycle_day resolves to 1,
 * regardless of what time of day the function is called at. Callers that
 * need a specific cycle_day at a specific hour (e.g. "what cycle day is
 * noon tomorrow?") pass a Date with the relevant calendar day.
 */

export interface School {
  /** First day of the school year. */
  schoolYearStart: Date;
  /** Last day of the school year. */
  schoolYearEnd: Date;
  /** Cycle length in days. 1..10. */
  cycleDays: number;
}

/**
 * Optional calendar override. If provided, this wins over the formula.
 *
 * - `isSchoolDay: false` → return `null` (non-school day).
 * - `isSchoolDay: true`  → return `cycleDay` (may be null if the override
 *   is recording a school day with a deferred cycle_day — the spec says
 *   `cycle_day INTEGER, -- 1..cycle_days; null = non-school day` but the
 *   DB also allows `is_school_day = true` with `cycle_day = null` as a
 *   "we don't know yet" placeholder; we preserve that semantics here).
 */
export interface CalendarEntry {
  cycleDay: number | null;
  isSchoolDay: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Return the cycle day (1..cycleDays) for `date` at `school`, honoring an
 * optional `calendarEntry` override. Returns `null` for non-school days
 * or dates outside the school year.
 *
 * Date comparison is at the CALENDAR DAY level (UTC midnight), not
 * millisecond timestamp level. The caller passes a Date constructed from
 * the same calendar date they care about — the function does not look
 * at hours / minutes / seconds.
 *
 * @example
 *   const school = {
 *     schoolYearStart: new Date('2026-09-01T00:00:00Z'),
 *     schoolYearEnd:   new Date('2027-06-30T00:00:00Z'),
 *     cycleDays: 5,
 *   };
 *   cycleDayForDate(new Date('2026-09-01T00:00:00Z'), school);  // 1
 *   cycleDayForDate(new Date('2026-09-05T00:00:00Z'), school);  // 5
 *   cycleDayForDate(new Date('2026-09-06T00:00:00Z'), school);  // 1 (wraps)
 *   cycleDayForDate(new Date('2026-08-31T00:00:00Z'), school);  // null (before start)
 */
export function cycleDayForDate(
  date: Date,
  school: School,
  calendarEntry?: CalendarEntry,
): number | null {
  // 1. Explicit calendar entry wins.
  if (calendarEntry) {
    return calendarEntry.isSchoolDay ? calendarEntry.cycleDay : null;
  }

  // 2. Out-of-school-year → no cycle day.
  const dateDay = toUtcDay(date);
  const startDay = toUtcDay(school.schoolYearStart);
  const endDay = toUtcDay(school.schoolYearEnd);
  if (dateDay < startDay || dateDay > endDay) {
    return null;
  }

  // 3. Default: modulo math from school_year_start.
  // Math.floor is safe here because dateDay >= startDay and both are
  // aligned to UTC midnight — the difference is always a whole number
  // of days.
  const daysSinceStart = Math.floor(
    (dateDay.getTime() - startDay.getTime()) / MS_PER_DAY,
  );
  // The spec defines cycle day as 1-indexed. `(0 % N) + 1 = 1`, so the
  // first day of the school year is always cycle day 1.
  return (daysSinceStart % school.cycleDays) + 1;
}

/**
 * Snap a Date to UTC midnight. We strip the time-of-day so the modulo
 * math is stable across DST shifts and timezones. `school_year_start`
 * and `school_year_end` are DATE columns in Postgres (no time component),
 * so the runtime values are UTC midnight by construction; the cycle_calendar
 * `date` column is also UTC.
 *
 * If the caller passes a Date constructed from a local-time string
 * (e.g. `new Date('2026-09-01')` in a non-UTC zone), we still want the
 * calendar day in the **UTC** sense. The function normalizes to UTC
 * midnight so two callers in different timezones that mean the same
 * calendar day agree on the cycle day.
 */
function toUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * First Monday of September in `year` (UTC). Helper used by the seed
 * script to compute a deterministic school_year_start.
 *
 * September always has at least 4 Mondays. The earliest possible first
 * Monday is Sep 1 (when Sep 1 is a Monday); the latest is Sep 7.
 */
export function firstMondayOfSeptember(year: number): Date {
  // Sep 1 of `year` in UTC.
  const sep1 = new Date(Date.UTC(year, 8, 1));
  // getUTCDay(): 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
  const dayOfWeek = sep1.getUTCDay();
  // Days to add to reach the first Monday.
  // - If Sep 1 is Monday (1): add 0.
  // - If Sep 1 is Sunday (0): add 1.
  // - If Sep 1 is Tuesday (2): add 6.
  // - ... etc.
  // Formula: (1 - dayOfWeek + 7) % 7 — works for any input.
  const offset = (1 - dayOfWeek + 7) % 7;
  return new Date(Date.UTC(year, 8, 1 + offset));
}

/**
 * Add `months` calendar months to a UTC date, clamped to the last day of
 * the target month if the source day does not exist in the target month
 * (e.g. Jan 31 + 1 month = Feb 28 or Feb 29).
 *
 * Used to compute `school_year_end = school_year_start + 10 months` in
 * the seed script. Spec section 12 says the year can be up to 14 months
 * (covers southern-hemisphere + split-year calendars); the seed uses 10
 * to match the typical North-American school year.
 */
export function addMonthsUtc(d: Date, months: number): Date {
  const newMonth = d.getUTCMonth() + months;
  const newYear = d.getUTCFullYear() + Math.floor(newMonth / 12);
  const normalizedMonth = ((newMonth % 12) + 12) % 12;
  // Last day of target month: day 0 of the month AFTER target = last day
  // of target. Clamp the source day to that.
  const lastDayOfTarget = new Date(Date.UTC(newYear, normalizedMonth + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDayOfTarget);
  return new Date(Date.UTC(newYear, normalizedMonth, day));
}
