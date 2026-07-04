// apps/web/app/routes/_app.today._index.test.tsx — regression tests
// for the /app/today loader + component (audit B5 + B6, 2026-07-04).
//
// What's being guarded:
//   - B5 (commit 639028c): the loader previously failed to destructure
//     `userId` from `session`, so the rendered page threw
//     ReferenceError when a teacher was on a group-duty with
//     colleagues. The fix added `userId: session.userId` to the
//     returned object. THIS FILE guards B5 with TWO layers:
//       (a) the loader-invocation test below mocks getSession +
//           withSchoolId + getGroupDutyRoster + listRemindersForDuties
//           and calls the real loader — this catches a mutation that
//           removes `userId: session.userId` from the return.
//       (b) the fixture-shape tests (kept) document the contract
//           between loader and component; they pin the keys the
//           component destructures but don't catch real mutations.
//   - B6 (commit e0ad1a7): a duplicate `myDuties.map((d) => ...)`
//     block in the component rendered duties twice (visible UX bug).
//     The fix collapsed to a single map. This test renders the
//     component with a non-empty `myDuties` + `groupRoster` and
//     asserts (a) no ReferenceError, (b) each duty renders once.
//
// We render via ReactDOMServer.renderToStaticMarkup — no DOM needed.
// react-router hooks are mocked because we don't bootstrap a full
// router for these unit-level regression checks.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// ---------------------------------------------------------------------------
// Mock react-router. The route component reads:
//   - useNavigation()       → for the submitting flag
//   - useRouteLoaderData()  → for csrfToken from the _app parent
//   - useFetcher()          → for MarkComplete / reminder toggles
//   - useLoaderData()       → for the loader's return shape
//
// In SSR we don't navigate, and we want a controlled loader payload.
// We replace every hook with a fn that returns a deterministic value.
// ---------------------------------------------------------------------------

const fixtureLoaderData = {
  role: 'teacher',
  userId: 'user-1',
  today: '2026-07-04',
  tomorrow: '2026-07-05',
  weekFromNow: '2026-07-11',
  allDuties: [
    {
      id: 'duty-1',
      name: 'Cafeteria Lunch A',
      location: 'Cafeteria',
      startTime: '11:30:00',
      endTime: '12:00:00',
      cycleDay: 3,
      requiresVest: false,
      requiresRadio: true,
    },
  ],
  myAssignments: [
    {
      dutyId: 'duty-1',
      startDate: '2026-09-01',
      endDate: null,
    },
  ],
  cycleDay: 3,
  isSchoolDay: true,
  stats: {
    totalDuties: 12,
    totalLocations: 5,
    myUpcoming: 4,
    myMinutesPerWeek: 100,
  },
  groupRoster: {
    'duty-1': [
      { userId: 'user-2', userName: 'Mr. Other', coverageRole: 'primary' },
    ],
  },
  recurringDuties: [],
  showOnboardingBanner: false,
  reminderMap: {
    'duty-1': [],
  },
};

vi.mock('react-router', () => ({
  useNavigation: () => ({ state: 'idle', formAction: undefined }),
  useRouteLoaderData: () => ({ csrfToken: 'csrf-test' }),
  // useFetcher returns a stable idle fetcher; the route component
  // reads `.state`, `.submit()`, AND `.Form` (the fetcher's own
  // Form component used by AddReminderSheet). Provide a Form-shaped
  // no-op so SSR doesn't warn about undefined component types.
  useFetcher: () => ({
    state: 'idle',
    submit: () => {},
    data: undefined,
    Form: ({ children }: { children?: React.ReactNode }) =>
      createElement('form', null, children),
  }),
  useLoaderData: () => fixtureLoaderData,
  Form: ({ children }: { children?: React.ReactNode }) => createElement('form', null, children),
}));

// Mock useClientNow — in production it returns null on SSR, then a
// Date after hydration. For our regression we want a deterministic
// value so the HeroCard's currentTime comparison is stable.
vi.mock('../../lib/useClientNow', () => ({
  useClientNow: () => new Date('2026-07-04T15:00:00Z'),
}));

// ---------------------------------------------------------------------------
// Mocks for the REAL loader invocation (B5 mutation-resistant regression).
//
// The loader imports:
//   - getSession              from ../../server/auth.server
//   - withSchoolId            from ../../server/db.server
//   - getGroupDutyRoster      from ../../server/duty-assignments.server
//   - listRemindersForDuties  from ../../server/reminders.server
//
// We mock each as a vi.fn() so the test can control the return shape
// per-test. Static `vi.fn()` placeholders here; beforeEach reimports +
// resetMocks + wires the implementation for the current test case.
// ---------------------------------------------------------------------------

vi.mock('../../server/auth.server', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../server/db.server', () => ({
  withSchoolId: vi.fn(),
}));

vi.mock('../../server/duty-assignments.server', () => ({
  getGroupDutyRoster: vi.fn(),
}));

vi.mock('../../server/reminders.server', () => ({
  listRemindersForDuties: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fake Drizzle transaction for withSchoolId.
//
// The loader calls 5 queries against `tx` (in this order):
//   1. tx.select({...}).from(schools).where(...).limit(1)
//   2. tx.select({...}).from(duties).where(...).limit(200)
//   3. tx.select({...}).from(dutyAssignments).where(...).limit(200)
//   4. tx.select({...}).from(cycleCalendar).where(...).limit(1)
//   5. tx.select({...}).from(recurringDuties).leftJoin(users,...).where(...).orderBy(...).limit(20)
//
// We build a chainable, thenable object whose `.limit(N)` resolves
// with the next canned rowset. The select columns passed in (Drizzle
// column refs) are ignored — the chain only reads .from() and .limit().
// ---------------------------------------------------------------------------

function buildFakeTx() {
  const canned: Array<unknown[]> = [
    // 1: schools row — non-demo so showOnboardingBanner=false
    [{ timezone: 'America/Toronto', demoExpiresAt: null }],
    // 2: all active duties — one entry so the loader's filter chain
    // has something to compute against.
    [
      {
        id: 'duty-1',
        name: 'Cafeteria Lunch A',
        location: 'Cafeteria',
        startTime: '11:30:00',
        endTime: '12:00:00',
        cycleDay: 3,
        requiresVest: false,
        requiresRadio: false,
      },
    ],
    // 3: myAssignments — one assignment for the logged-in user so
    // myUpcoming > 0 and showOnboardingBanner is false.
    [{ dutyId: 'duty-1', startDate: '2026-09-01', endDate: null, userId: 'user-1' }],
    // 4: cycleCalendar for today
    [{ cycleDay: 3, isSchoolDay: true, date: '2026-07-04' }],
    // 5: recurringDuties (leftJoin users) — empty
    [],
  ];
  let queryCall = 0;
  return {
    select(_cols: unknown) {
      return {
        from(_table: unknown) {
          const chain: Record<string, unknown> = {};
          // Every chainable method returns the chain itself so the
          // loader's pipeline can call them in any order.
          chain.where = () => chain;
          chain.leftJoin = () => chain;
          chain.innerJoin = () => chain;
          chain.orderBy = () => chain;
          // `.limit(N)` is the terminal await point. Drizzle
          // promise-resolves the whole chain here.
          chain.limit = (_n: number) => {
            queryCall += 1;
            return Promise.resolve(canned[queryCall - 1] ?? []);
          };
          return chain;
        },
      };
    },
    // Expose the call count so a test can assert "exactly 5 queries
    // were issued" if needed.
    __getQueryCallCount: () => queryCall,
  };
}

// ---------------------------------------------------------------------------
// B5: REAL loader invocation (mutation-resistant regression guard).
//
// These tests mock the loader's transitive deps (getSession /
// withSchoolId / getGroupDutyRoster / listRemindersForDuties) and
// invoke the exported `loader` directly. They are the load-bearing
// B5 guard — the fixture-shape tests below are kept as documentation
// of the loader↔component contract but cannot catch a mutation that
// drops `userId: session.userId` from the loader return.
//
// Mutation probe that THIS catches:
//   - "remove `userId: session.userId` from the loader's return
//     object" → first assertion trips
//   - "remove the entire `userId` field"  → first assertion trips
//   - "rename `userId` to `user_id`"      → first assertion trips
//   - "rewrite userId to a literal string" → alt-session test trips
//     (because we change session.userId per-test and assert the
//     return matches)
// ---------------------------------------------------------------------------

describe('_app.today loader (B5 mutation-resistant regression)', () => {
  // Re-import the mocked modules per test. vi.mock factories are
  // hoisted, so the vi.fn() instances are stable across imports —
  // but we re-import to get a typed reference in the test scope.
  let mockGetSession: ReturnType<typeof vi.fn>;
  let mockWithSchoolId: ReturnType<typeof vi.fn>;
  let mockGetGroupDutyRoster: ReturnType<typeof vi.fn>;
  let mockListRemindersForDuties: ReturnType<typeof vi.fn>;

  const fakeSession = {
    schoolId: 'school-1',
    userId: 'user-1',
    role: 'teacher' as const,
    email: 'teacher@example.com',
    name: 'Ms. Test',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const auth = await import('../../server/auth.server');
    const dbsrv = await import('../../server/db.server');
    const daMod = await import('../../server/duty-assignments.server');
    const rmMod = await import('../../server/reminders.server');
    mockGetSession = auth.getSession as unknown as ReturnType<typeof vi.fn>;
    mockWithSchoolId = dbsrv.withSchoolId as unknown as ReturnType<typeof vi.fn>;
    mockGetGroupDutyRoster = daMod.getGroupDutyRoster as unknown as ReturnType<typeof vi.fn>;
    mockListRemindersForDuties = rmMod.listRemindersForDuties as unknown as ReturnType<typeof vi.fn>;

    // Default wiring — overridden in specific tests as needed.
    mockGetSession.mockResolvedValue(fakeSession);
    const fakeTx = buildFakeTx();
    mockWithSchoolId.mockImplementation(
      async (_schoolId: string, fn: (tx: ReturnType<typeof buildFakeTx>) => Promise<unknown>) =>
        fn(fakeTx),
    );
    mockGetGroupDutyRoster.mockResolvedValue(new Map());
    mockListRemindersForDuties.mockResolvedValue(new Map());
  });

  it('returns userId === session.userId when loader runs (B5 tripwire)', async () => {
    const mod = await import('./_app.today._index');
    const loader = mod.loader as (args: {
      request: Request;
    }) => Promise<Record<string, unknown>>;
    const result = await loader({ request: new Request('http://localhost/app/today') });

    // Primary B5 assertion — fires if anyone removes the
    // `userId: session.userId` line from the loader return.
    expect(result.userId).toBe(fakeSession.userId);
  });

  it('returns userId === session.userId even when the session is a fresh value', async () => {
    // Mutation-resistant variant: change the session and confirm
    // the returned userId follows. Catches "hard-coded literal"
    // cheats that try to fake the first test.
    const altSession = { ...fakeSession, userId: 'different-user-id-xyz' };
    mockGetSession.mockResolvedValue(altSession);

    const mod = await import('./_app.today._index');
    const loader = mod.loader as (args: {
      request: Request;
    }) => Promise<Record<string, unknown>>;
    const result = await loader({ request: new Request('http://localhost/app/today') });

    expect(result.userId).toBe('different-user-id-xyz');
    expect(result.userId).not.toBe(fakeSession.userId);
  });

  it('returns all 14 fields the component destructures from useLoaderData', async () => {
    const mod = await import('./_app.today._index');
    const loader = mod.loader as (args: {
      request: Request;
    }) => Promise<Record<string, unknown>>;
    const result = await loader({ request: new Request('http://localhost/app/today') });

    // Component destructures these 14 names. If any are missing
    // (e.g. someone accidentally replaces `userId` with a comment
    // out the line, or renames `reminderMap`), the rendered page
    // throws ReferenceError. Pin the shape against that.
    const requiredKeys = [
      'role',
      'userId',
      'today',
      'tomorrow',
      'weekFromNow',
      'allDuties',
      'myAssignments',
      'cycleDay',
      'isSchoolDay',
      'stats',
      'groupRoster',
      'recurringDuties',
      'showOnboardingBanner',
      'reminderMap',
    ];
    for (const k of requiredKeys) {
      expect(result).toHaveProperty(k);
    }
  });

  it('throws a 302 redirect to /login when session is missing', async () => {
    // The loader has a hard auth guard: no session → 302 to /login.
    // If someone removes the guard, this test fails.
    mockGetSession.mockResolvedValue(null);

    const mod = await import('./_app.today._index');
    const loader = mod.loader as (args: {
      request: Request;
    }) => Promise<unknown>;
    let thrown: unknown;
    try {
      await loader({ request: new Request('http://localhost/app/today') });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
  });
});

// ---------------------------------------------------------------------------
// B5 contract documentation — kept as a secondary guard.
//
// These tests pin the SHAPE of the fixture that the component tests
// below rely on. They do NOT catch a mutation that drops
// `userId: session.userId` from the loader return (the loader-invocation
// tests above are the load-bearing B5 guard). They DO catch:
//   - accidental removal of a key from the fixture
//   - drift between the fixture and what the real loader returns
//     (e.g. someone changes the destructuring to `loaderData.user`
//      but forgets to rename the fixture key)
//
// Keep them as documentation of the loader↔component contract.
// ---------------------------------------------------------------------------

describe('_app.today loader→component contract (B5 secondary guard)', () => {
  it('loaderData fixture includes userId', () => {
    expect(fixtureLoaderData).toHaveProperty('userId');
    expect(fixtureLoaderData.userId).toBe('user-1');
  });

  it('loaderData fixture includes all 12 fields the component reads from useLoaderData', () => {
    const requiredKeys = [
      'allDuties',
      'myAssignments',
      'cycleDay',
      'today',
      'isSchoolDay',
      'stats',
      'role',
      'reminderMap',
      'groupRoster',
      'recurringDuties',
      'showOnboardingBanner',
      'userId',
    ];
    for (const k of requiredKeys) {
      expect(fixtureLoaderData).toHaveProperty(k);
    }
  });
});

// ---------------------------------------------------------------------------
// B6: component renders without ReferenceError when myDuties is
// non-empty AND groupRoster is populated.
//
// The pre-fix component had a duplicate `myDuties.map((d) => ...)`
// block in the JSX. The first block worked; the second one threw
// ReferenceError because `d` referred to a stale outer-scope var
// (or the destructured `userId` was undefined). The fix collapsed
// to one map AND added the userId destructure.
//
// This test renders the component with both pre-conditions set:
//   - myDuties resolves to 1 entry (allDuties[0] is in myAssignments)
//   - groupRoster has an entry for that duty with a colleague
//
// If either invariant regresses, renderToStaticMarkup throws and
// the test fails.
// ---------------------------------------------------------------------------

describe('_app.today component (B6 regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without throwing when myDuties is non-empty and groupRoster is set', async () => {
    // Import inside the test so the mocks are wired first. Use
    // dynamic import (not require) because vitest runs in ESM mode
    // and `require('./_app.today._index')` can't resolve .tsx
    // extensions.
    const mod = await import('./_app.today._index');
    const Today = mod.default as React.ComponentType;

    expect(() => renderToStaticMarkup(createElement(Today))).not.toThrow();
  });

  it('renders each duty exactly once (no duplicate myDuties.map)', async () => {
    // With the duplicate-map bug, the duty card markup appeared
    // twice in the SSR output. Pin the count: pre-fix would be 2+
    // (entire <li class="bg-surface rounded-lg border border-border p-md">
    // repeated), post-fix is exactly 1.
    //
    // Counting the duty name as a substring is unreliable — the
    // name also appears in the Swap/Mark Complete aria-labels
    // (3 occurrences is the post-fix baseline). Count the duty-card
    // <li> roots instead.
    const mod = await import('./_app.today._index');
    const Today = mod.default as React.ComponentType;
    const html = renderToStaticMarkup(createElement(Today));

    // Match the DutyCard root <li> — the class set is stable in the
    // codebase. Pre-fix duplicate-map would render 2+ of these.
    const dutyCardRoots = html.match(
      /<li class="bg-surface rounded-lg border border-border p-md[^"]*"/g,
    ) ?? [];
    expect(dutyCardRoots.length).toBe(1);
  });

  it('renders the group-duty coverage copy when groupCount > 0 (uses userId)', async () => {
    const mod = await import('./_app.today._index');
    const Today = mod.default as React.ComponentType;
    const html = renderToStaticMarkup(createElement(Today));

    // The fixture has 1 colleague on duty-1. The DutyCard renders
    // "You're covering with 1 other" (singular). If the userId
    // destructure regressed, the .filter(c => c.userId !== userId)
    // would either throw or include all colleagues (showing
    // "1 other" still — but the throw kills SSR).
    //
    // The apostrophe is HTML-encoded as &#x27; by renderToStaticMarkup,
    // so we match the plain-English phrase without the contraction.
    expect(html).toContain('covering with 1 other');
  });
});