const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Add calendar days to a YYYY-MM-DD key without adding elapsed milliseconds.
 * UTC is deliberate: the input is a timezone-free calendar date, not an
 * instant, so UTC component math cannot cross a DST boundary.
 */
export function addCalendarDays(dateKey: string, days: number): string {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new Error(`Invalid calendar date: ${dateKey}`);

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}
