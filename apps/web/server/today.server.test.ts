import { describe, expect, it } from 'vitest';
import { addCalendarDays } from '../app/lib/calendar-date';
import { getTodayDateKeys } from './today.server';

describe('Today calendar date math', () => {
  it('advances calendar dates across spring-forward without elapsed-ms drift', () => {
    // Toronto switches from EST to EDT on 2026-03-08. The instant is late
    // enough that adding 24 elapsed hours would produce March 9 locally.
    expect(
      getTodayDateKeys(
        new Date('2026-03-08T04:30:00.000Z'),
        'America/Toronto',
      ),
    ).toEqual({
      today: '2026-03-07',
      tomorrow: '2026-03-08',
      weekFromNow: '2026-03-14',
    });
  });

  it('advances calendar dates across fall-back without repeating a day', () => {
    expect(
      getTodayDateKeys(
        new Date('2026-11-01T04:30:00.000Z'),
        'America/Toronto',
      ),
    ).toEqual({
      today: '2026-11-01',
      tomorrow: '2026-11-02',
      weekFromNow: '2026-11-08',
    });
  });

  it('handles month, year, and leap-day rollover as calendar dates', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
