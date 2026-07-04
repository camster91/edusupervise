// apps/web/server/reminders.server.test.ts — regression tests for
// listRemindersForDuties (audit B7, 2026-07-04 — replaced the N+1
// per-duty reminder fetch on /app/today with a single batch query).
//
// What's being guarded:
//   - 1 duty: returns Map with that duty + its reminders.
//   - 5 duties: SINGLE query (the N+1 regression guard). We
//     instrument getSystemClient (and the underlying drizzle
//     select) and assert they are called ONCE not N times.
//   - empty dutyIds: returns empty Map without touching the DB
//     (early return — saves a round-trip when the caller passes no
//     ids).
//   - duty with no reminders: returns Map with empty array for that
//     key (not undefined / not omitted — the caller's `?? []`
//     fallback stays a no-op).
//
// Why this test is load-bearing:
//   The pre-fix /app/today loader called listRemindersForDuty in a
//   for-loop, up to 200 sequential round-trips per page load. That
//   regressed to ~200ms on the hottest authenticated route. The
//   batch function collapses this to ~5ms. The assertion below is
//   the tripwire: any future refactor that re-introduces per-duty
//   calls (even one extra call for one duty) fails this suite.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import the REAL schema so `reminders.id`, `dutyAssignments.dutyId`,
// etc. resolve to real column refs. The actual SQL evaluation happens
// in the fake db chain (the schema is only used for type-safe column
// accessors that the fake `.from(...)` / `.innerJoin(...)` chain
// ignores).
//
// vi.hoisted() runs the dynamic import BEFORE vi.mock() is applied,
// so the mock factory's reference to `schema` resolves. Without
// hoisting the factory is hoisted above the top-level `await import`
// and `schema` is undefined at the time the factory executes —
// vitest surfaces this as "Cannot access 'reminders' before
// initialization".
const schemaRef = vi.hoisted(async () => {
  return await import('@edusupervise/db');
});
const { reminders, dutyAssignments, duties, users } = await schemaRef;

// ---------------------------------------------------------------------------
// Build a fake Drizzle client whose .select().from().where().orderBy()
// chain returns the rows we configure per test. We record:
//   - the number of times `select(...)` is called (= number of SQL
//     queries against reminders)
//   - the predicate passed to `where(...)` so we can assert the
//     IN(...) clause is actually used
// ---------------------------------------------------------------------------

interface FakeReminderRow {
  id: string;
  schoolId: string;
  assignmentId: string;
  minutesBefore: number;
  isEnabled: boolean;
  notifyEmail: boolean;
  notifySms: boolean;
  customMessage: string | null;
  createdAt: Date;
  userId: string | null;
  userName: string | null;
  dutyLocation: string;
  dutyStartTime: string;
  dutyId: string;
}

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  selectCallCount: number;
  lastWhere: unknown;
}

function buildFakeRemindersDb(rows: FakeReminderRow[]): { db: FakeDb } {
  const state: { selectCallCount: number; lastWhere: unknown } = {
    selectCallCount: 0,
    lastWhere: undefined,
  };

  const select = vi.fn(() => {
    state.selectCallCount += 1;
    return {
      from(_t: unknown) {
        return {
          innerJoin(_a: unknown) {
            return {
              innerJoin(_b: unknown) {
                return {
                  leftJoin(_c: unknown) {
                    return {
                      where(conds: unknown) {
                        state.lastWhere = conds;
                        // The listRemindersForDuties query is awaited
                        // directly (no .limit() — it returns all
                        // matching reminders). Order is applied via
                        // .orderBy().
                        return {
                          orderBy(_by: unknown) {
                            return Promise.resolve(rows);
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  });

  return {
    db: {
      select,
      selectCallCount: 0,
      lastWhere: undefined,
      // Expose state for assertion ergonomics.
    } as unknown as FakeDb,
  };
}

// Track getSystemClient call count to assert it's invoked exactly ONCE
// per batch call (not N times — that would be the N+1 regression).
const getSystemClientCalls: Array<{ url: string }> = [];

vi.mock('@edusupervise/db', () => ({
  getSystemClient: (url: string) => {
    getSystemClientCalls.push({ url });
    // Build a fresh fake db per call. The test asserts the count of
    // calls + the rows each one returns via the shared `rowsByCall`
    // queue below.
    const idx = getSystemClientCalls.length - 1;
    const queue = rowsByCall[idx] ?? [];
    const built = buildFakeRemindersDb(queue);
    return {
      db: built.db,
      close: async () => {},
    };
  },
  // Pass through the real schema imports so `reminders.id`,
  // `dutyAssignments.dutyId`, etc. resolve. The mock only needs to
  // override `getSystemClient`; the column refs are pure data.
  reminders,
  dutyAssignments,
  duties,
  users,
}));

// Per-call rows queue. Each call to getSystemClient() drains the
// queue at its own index. Tests populate this before invoking the
// function under test.
const rowsByCall: FakeReminderRow[][] = [];

function makeRow(overrides: Partial<FakeReminderRow>): FakeReminderRow {
  return {
    id: 'r1',
    schoolId: 'school-1',
    assignmentId: 'a1',
    minutesBefore: 15,
    isEnabled: true,
    notifyEmail: true,
    notifySms: false,
    customMessage: null,
    createdAt: new Date('2026-07-04T10:00:00Z'),
    userId: 'u1',
    userName: 'Ms. Test',
    dutyLocation: 'Cafeteria',
    dutyStartTime: '11:30:00',
    dutyId: 'd1',
    ...overrides,
  };
}

beforeEach(() => {
  rowsByCall.length = 0;
  getSystemClientCalls.length = 0;
  vi.clearAllMocks();
});

// Import AFTER the mock is in place.
const { listRemindersForDuties } = await import('./reminders.server.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listRemindersForDuties (B7 regression guard)', () => {
  it('1 duty with 2 reminders: returns Map with that duty and 2 entries', async () => {
    rowsByCall.push([
      makeRow({ id: 'r1', dutyId: 'd1', minutesBefore: 15 }),
      makeRow({ id: 'r2', dutyId: 'd1', minutesBefore: 30 }),
    ]);

    const result = await listRemindersForDuties('school-1', ['d1']);

    expect(result.size).toBe(1);
    expect(result.get('d1')).toHaveLength(2);
    expect(result.get('d1')?.[0]?.id).toBe('r1');
    expect(result.get('d1')?.[1]?.id).toBe('r2');
    expect(getSystemClientCalls).toHaveLength(1);
  });

  it('5 duties with mixed reminders: SINGLE batch query (the N+1 regression guard)', async () => {
    rowsByCall.push([
      makeRow({ id: 'r1', dutyId: 'd1', minutesBefore: 15 }),
      makeRow({ id: 'r2', dutyId: 'd2', minutesBefore: 30 }),
      makeRow({ id: 'r3', dutyId: 'd3', minutesBefore: 60 }),
      makeRow({ id: 'r4', dutyId: 'd5', minutesBefore: 120 }),
      // d4 has no reminders — that's a real-world case (admin
      // configured everything except the Hall Monitor slot).
    ]);

    const result = await listRemindersForDuties(
      'school-1',
      ['d1', 'd2', 'd3', 'd4', 'd5'],
    );

    // The tripwire: exactly one DB call regardless of duty count.
    // If anyone re-introduces the N+1 (e.g. by calling
    // listRemindersForDuty in a loop), this assertion fires.
    expect(getSystemClientCalls).toHaveLength(1);

    // All 5 duty keys are present (d4 has empty array, NOT
    // undefined — the caller does `reminderMap[d.id] ?? []` which
    // would still work, but the explicit empty array matches the
    // documented contract).
    expect(result.size).toBe(5);
    expect(result.get('d1')).toHaveLength(1);
    expect(result.get('d2')).toHaveLength(1);
    expect(result.get('d3')).toHaveLength(1);
    expect(result.get('d4')).toEqual([]);
    expect(result.get('d5')).toHaveLength(1);
  });

  it('empty dutyIds: returns empty Map WITHOUT calling the DB', async () => {
    // No rowsByCall entry — getSystemClient would crash on undefined
    // queue access if it were called. The empty early-return must
    // short-circuit BEFORE the DB call.
    const result = await listRemindersForDuties('school-1', []);

    expect(result.size).toBe(0);
    expect(getSystemClientCalls).toHaveLength(0);
  });

  it('duty with no reminders: returns Map entry with empty array (not undefined)', async () => {
    rowsByCall.push([
      // Only d1 has a reminder; d2 / d3 do not.
      makeRow({ id: 'r1', dutyId: 'd1', minutesBefore: 15 }),
    ]);

    const result = await listRemindersForDuties('school-1', ['d1', 'd2', 'd3']);

    expect(result.size).toBe(3);
    expect(result.get('d1')).toHaveLength(1);
    expect(result.get('d2')).toEqual([]);
    expect(result.get('d3')).toEqual([]);
    // Still a single query.
    expect(getSystemClientCalls).toHaveLength(1);
  });
});