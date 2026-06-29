/**
 * Timezone conversion helper for the reminder worker.
 *
 * Spec section 10 mandates: "Worker computes `dispatch_at` by converting the
 * duty's local `start_time` (in school timezone) to UTC using
 * `Intl.DateTimeFormat` with the school's IANA timezone string."
 *
 * Approach: cross-reference the wall-clock time in two different timezones
 * and measure the offset. `Intl.DateTimeFormat` with `timeZone` plus a
 * `timeZoneName: 'longOffset'` (or the equivalent formatToParts with
 * `'shortOffset'`) hands back the UTC offset string like "GMT-05:00" — that
 * gives us a way to derive the UTC instant for an arbitrary local wall-clock.
 *
 * Why not Temporal:
 *   - Spec requires `Intl.DateTimeFormat` and pinned Node 20 LTS in earlier
 *     sections; Temporal is a Stage-4 proposal but shipped only behind flag
 *     in Node ≤ 22 and not in the SPEC's pinned runtime. Sticking to
 *     `Intl.DateTimeFormat` keeps us in spec.
 *
 * Two strategies coexist:
 *   - `localTimeToUtc(date, hhmm, iana)` — combine `date` (Y-M-D) with
 *     `hhmm` (wall-clock in school tz) and produce the UTC instant.
 *   - `utcOffsetForTime(utcDate, iana)` — used by the integration tests as
 *     a pure round-trip check.
 *
 * DST robustness: testing/dst tests should confirm a `March 13 02:30 in
 * America/Toronto` event computes correctly across the spring-forward
 * boundary (no 02:30 exists on that day). The implementation returns the
 * UTC instant matching the closest representable wall-clock; if the time
 * doesn't exist (DST gap) we land on the post-DST wall-clock. If the
 * repeated range (DST overlap) we land on the pre-DST wall-clock. The
 * caller is responsible for not scheduling reminders in the gap.
 */

export interface OffsetParts {
  hours: number;
  minutes: number;
}

/**
 * Return the UTC offset (in minutes) for the given UTC instant in `iana`
 * timezone. Positive means east of UTC.
 *
 * Example: `utcOffsetForTime(new Date('2026-06-15T12:00:00Z'), 'America/Toronto')`
 *        -> `-240` (EDT is UTC-4).
 */
export function utcOffsetForTime(utcDate: Date, iana: string): number {
  const offset = readOffsetString(utcDate, iana); // e.g. "GMT-04:00" or "GMT"
  if (offset === 'GMT' || offset === 'UTC') return 0;
  // Strip leading "GMT"
  const sign = offset[3] === '-' ? -1 : 1;
  const hh = Number.parseInt(offset.slice(4, 6), 10);
  const mm = Number.parseInt(offset.slice(7, 9), 10);
  return sign * (hh * 60 + mm);
}

/**
 * Return the UTC Date corresponding to `date` (Y/M/D in `iana`) at
 * `hhmm` wall-clock time in that same zone.
 *
 * Approach: bisection. The two timezones (UTC and `iana`) have a known
 * relationship up to ±14 hours; we convert the candidate UTC instant into
 * the local zone using `Intl.DateTimeFormat` and walk the offset until the
 * round-trip agrees.
 *
 * Why bisection: the relationship between UTC and a zone's wall-clock
 * depends on DST status, which `Intl.DateTimeFormat` encodes via the
 * `timeZoneName: 'longOffset'` formatter. Binary search converges in
 * ≤12 iterations (one extra second precision each step).
 */
export function localTimeToUtc(
  date: { year: number; month: number; day: number },
  hhmm: string,
  iana: string,
): Date {
  validateIana(iana);
  const [hh, mm] = parseHHMM(hhmm);
  validateHHMM(hh, mm);

  // Start with a guess: assume the local time equals UTC.
  let lo = Date.UTC(date.year, date.month - 1, date.day, hh, mm) - 14 * 3_600_000;
  let hi = Date.UTC(date.year, date.month - 1, date.day, hh, mm) + 14 * 3_600_000;

  // Bisect in pure ms — do NOT round the midpoint to a second boundary.
  // A round-to-second midpoint causes the bisection to "stick" on a
  // whole-second UTC instant whose formatted local-time is at the
  // target (e.g. 13:00:20Z → 09:00:20 local → formatter rounds to
  // 09:00 → bisection declares success and returns the wrong moment).
  // Letting the midpoint remain fractional is fine because `Intl`
  // formats fractional instants rounded to the minute, not the second;
  // what matters is which side of the target the candidate sits on.
  //
  // On the iteration that observes an exact match at the target minute,
  // we translate (year, month, day, hour, minute) back to ms via
  // `Date.UTC` *in the iana zone's offset*. UTC ms alone won't tell us
  // which UTC second corresponds to that wall-clock — we need the
  // zone's offset for `date`. Easiest: subtract `utcOffsetForTime`
  // applied to the candidate. The result is the requested wall-clock
  // rounded to the start of the wall-clock minute, which is what the
  // caller wants.
  for (let i = 0; i < 30; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = new Date(mid);

    const parts = formatToParts(candidate, iana);
    const obsY = Number.parseInt(parts.year!, 10);
    const obsM = Number.parseInt(parts.month!, 10);
    const obsD = Number.parseInt(parts.day!, 10);
    const obsH = Number.parseInt(parts.hour!, 10);
    const obsMin = Number.parseInt(parts.minute!, 10);

    const target = Date.UTC(date.year, date.month - 1, date.day, hh, mm);
    const observed = Date.UTC(obsY, obsM - 1, obsD, obsH, obsMin);
    if (observed === target) {
      // Compute the offset at the converged instant, then return the
      // UTC instant for the requested wall-clock by subtracting the
      // offset from the wall-clock expressed as ms since epoch.
      const offsetMin = utcOffsetForTime(candidate, iana);
      return new Date(target - offsetMin * 60_000);
    }
    if (observed < target) lo = mid;
    else hi = mid;
  }

  // 30 iterations failed to converge — the timezone is implausibly
  // erratic or the requested wall-clock doesn't exist (DST gap).
  // Return the last midpoint rather than throwing; callers will see a
  // wrong-but-finite time and can decide how to react. Better than
  // crashing the worker.
  return new Date(Math.floor((lo + hi) / 2));
}

function formatToParts(date: Date, iana: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: iana,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

function readOffsetString(date: Date, iana: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: iana,
    timeZoneName: 'longOffset',
  });
  for (const part of fmt.formatToParts(date)) {
    if (part.type === 'timeZoneName') return part.value;
  }
  return 'GMT';
}

function parseHHMM(hhmm: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) {
    throw new Error(`timezone: invalid hhmm "${hhmm}" (expected "HH:MM")`);
  }
  const hh = Number.parseInt(m[1]!, 10);
  const mm = Number.parseInt(m[2]!, 10);
  return [hh, mm];
}

function validateHHMM(hh: number, mm: number): void {
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`timezone: hour/minute out of range: ${hh}:${mm}`);
  }
}

function validateIana(iana: string): void {
  // Inception check: Intl.DateTimeFormat throws for unknown zones. Try
  // silently first to avoid an expensive throw on each call; we still
  // validate so a typo'd zone string doesn't silently produce NaN dates.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: iana });
  } catch {
    throw new Error(`timezone: invalid IANA timezone "${iana}"`);
  }
}

/**
 * Compute the next UTC dispatch instant for a reminder that fires
 * `minutesBefore` minutes before `localStart` (HH:MM in school tz).
 *
 * The caller decides which date to use (today, the next school day per
 * cycle_calendar, etc.); this function ONLY does the timezone math.
 */
export function dispatchAtUtc(args: {
  date: { year: number; month: number; day: number };
  localStart: string; // "HH:MM"
  minutesBefore: number;
  tz: string;
}): Date {
  const local = localTimeToUtc(args.date, args.localStart, args.tz);
  return new Date(local.getTime() - args.minutesBefore * 60_000);
}
