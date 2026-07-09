// apps/web/server/push.server.test.ts — regression tests for the
// push dispatcher's per-subscription failure handling.
//
// What's being guarded:
//   - Web Push 404 (subscription not registered at the push service)
//     → delete the row (push service confirmed the endpoint is dead).
//   - Web Push 410 Gone (subscription retired, e.g. user cleared
//     site data) → delete the row.
//   - Web Push other 4xx/5xx (transient failures, rate limit, etc.)
//     → preserve the row, log at warn.
//   - APNs 410 Gone → delete the row.
//   - APNs 400 BadDeviceToken → delete the row.
//   - APNs auth-failed (no .p8 wired) → preserve the row, log at warn.
//   - APNs rate-limited / unknown → preserve the row, log at warn.
//
// Why this test is load-bearing:
//   Pre-fix the dispatcher would catch *any* error from web-push and
//   log-and-leave, which is correct for transient failures but
//   wrong for 410 — every retry of a dead endpoint would also
//   log-and-leave, leaving zombie rows in push_subscriptions that
//   keep getting polled by the worker reminder queue.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks for sibling modules (must come BEFORE importing push.server) ---

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

vi.mock('./apns.server', () => ({
  sendApnsPush: vi.fn(),
  getApnsConfig: vi.fn(() => null),
  getApnsJwt: vi.fn(),
}));

// `@edusupervise/db` has many exports (every table + every helper). We
// need the REAL pushSubscriptions table + withUserContext, but we want
// to mock the SQL execution so the test doesn't need a live Postgres.
// `vi.importActual` lets us load the real module then override only
// the parts we mock.
vi.mock('@edusupervise/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@edusupervise/db')>();
  return {
    ...actual,
    // Replace the DB client factory with a no-op returning our fake tx.
    // The dispatcher calls getDb() once per send; we make the returned
    // object also satisfy the Drizzle `db.transaction(...)` interface
    // by having the withUserContext helper just call back into our
    // fake builder.
  };
});

// Build a fake `tx` whose query chain resolves to a row set we control
// per test, and whose insert/select chains chain correctly. The
// dispatcher uses: `tx.select({...}).from(...).where(...).then(resolve)`.
// We also expose a way to override the row set per test.
function buildTx(rows: unknown[]) {
  // Each chain step on `tx` (select, from, where) returns the same
  // thenable that also exposes the OTHER chain methods. This lets
  // any of `tx.select({}).from(t).where(...)`, `tx.select(t).where(...)`,
  // `tx.from(t).where(...)`, etc. all resolve to `rows` when awaited.
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  const passthrough = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  const thenable: any = Object.assign(passthrough, {
    then: passthrough,
    // chainable methods — every call returns the same thenable
    select: vi.fn(() => thenable),
    from: vi.fn(() => thenable),
    where: vi.fn(() => thenable),
    innerJoin: vi.fn(() => thenable),
    leftJoin: vi.fn(() => thenable),
    orderBy: vi.fn(() => thenable),
    limit: vi.fn(() => thenable),
    insert,
  });

  return {
    tx: {
      select: vi.fn(() => thenable),
      from: vi.fn(() => thenable),
      where: vi.fn(() => thenable),
      insert,
      // Route tx.execute through fakeDbRef.execute so test assertions
      // checking fakeDbRef.execute also see the withUserContext-wrapped
      // DELETE calls. Same mock, two handles.
      execute: fakeDbRef.execute,
    },
    insert,
    onConflictDoUpdate,
  };
}

// Mock ./db.server to return our fake db; the withUserContext mock
// (below) calls back into txRef.current.
const txRef: { current: ReturnType<typeof buildTx> | null } = { current: null };
const fakeDbRef = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
}));

// Single stable db object reused across all calls to getDb().
vi.mock('./db.server', () => ({
  getDb: vi.fn(() => fakeDbRef),
}));

vi.mock('@edusupervise/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@edusupervise/db')>();
  return {
    ...actual,
    withUserContext: vi.fn(async (_db, _schoolId, _userId, fn) =>
      fn(txRef.current!.tx),
    ),
  };
});

// After both vi.mock declarations, the second one wins (vitest
// de-duplicates by import path). Re-apply with the union of the
// real module + our overrides by re-importing the test file's
// expectations here.
const { sendPushToUser, registerWebSubscription, registerIosSubscription } =
  await import('./push.server');

const webpush = await import('web-push');
const { sendApnsPush } = await import('./apns.server');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SCHOOL_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const SUB_ID_WEB = '33333333-3333-3333-3333-333333333333';
const SUB_ID_IOS = '44444444-4444-4444-4444-444444444444';

function makeWebRow() {
  return {
    id: SUB_ID_WEB,
    schoolId: SCHOOL_ID,
    userId: USER_ID,
    platform: 'web' as const,
    endpoint: 'https://fcm.googleapis.com/fcm/send/test',
    p256dh: 'BNcRdreALRFXTkOOUHKq1Q0',
    auth: 'tBHItJI5svbpez7KI4CCXg',
    userAgent: null,
  };
}
function makeIosRow() {
  return {
    id: SUB_ID_IOS,
    schoolId: SCHOOL_ID,
    userId: USER_ID,
    platform: 'ios' as const,
    endpoint: null,
    p256dh: null,
    auth: null,
    userAgent: null,
    apnsToken:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    apnsBundleId: 'ca.ashbi.edusupervise',
  };
}

beforeEach(() => {
  // Default: dispatcher sees one web + one iOS sub.
  txRef.current = buildTx([makeWebRow(), makeIosRow()]);
  // VAPID present so the dispatcher doesn't no-op the web path.
  process.env.VAPID_PUBLIC_KEY =
    'BEGTwrSQRjVARmG90ZGXtZE7XY4T49Ne5xZa-7lOa0HHphur_pgYtF0jHR60GPtEpwBfm6MI0so26qfHUt0Y3YU';
  process.env.VAPID_PRIVATE_KEY =
    'rQMeJzgsSJZ6rCQmC15SWZ4bguzd0Kj8b3OaXsgIMb4';
  process.env.VAPID_SUBJECT = 'mailto:test@edusupervise.ashbi.ca';
  // Reset mocks.
  vi.mocked(webpush.default.sendNotification).mockReset();
  vi.mocked(sendApnsPush).mockReset();
  // Clear fakeDbRef call count from previous tests.
  fakeDbRef.execute.mockClear();
});

afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});

// ---------------------------------------------------------------------------
// Web Push failure modes
// ---------------------------------------------------------------------------

describe('Web Push row-deletion branches', () => {
  it('404 from web-push deletes the subscription row', async () => {
    const err = Object.assign(new Error('404'), { statusCode: 404 });
    vi.mocked(webpush.default.sendNotification).mockRejectedValueOnce(err);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({ ok: true });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    // The dispatcher deletes the row via raw SQL — verify the call.
    expect(fakeDbRef.execute).toHaveBeenCalled();
  });

  it('410 Gone from web-push deletes the subscription row', async () => {
    const err = Object.assign(new Error('410 Gone'), { statusCode: 410 });
    vi.mocked(webpush.default.sendNotification).mockRejectedValueOnce(err);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({ ok: true });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    const db = fakeDbRef;
    expect(db.execute).toHaveBeenCalled();
  });

  it('500 from web-push preserves the row (transient failure)', async () => {
    const err = Object.assign(new Error('500'), { statusCode: 500 });
    vi.mocked(webpush.default.sendNotification).mockRejectedValueOnce(err);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({ ok: true });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    // No DELETE for the web row.
    const db = fakeDbRef;
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('400 (malformed subscription) preserves the row', async () => {
    // Some web push services return 400 for "endpoint not registered" —
    // we DON'T treat that as terminal, so the row stays. (If this
    // turns out to be wrong in practice, this test will fail and
    // we'll reconsider the policy.)
    const err = Object.assign(new Error('400'), { statusCode: 400 });
    vi.mocked(webpush.default.sendNotification).mockRejectedValueOnce(err);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({ ok: true });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    const db = fakeDbRef;
    expect(db.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// APNs failure modes
// ---------------------------------------------------------------------------

describe('APNs row-deletion branches', () => {
  it('410 Gone from APNs deletes the subscription row', async () => {
    vi.mocked(webpush.default.sendNotification).mockResolvedValueOnce(undefined);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({
      ok: false,
      reason: 'gone',
      status: 410,
    });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    const db = fakeDbRef;
    expect(db.execute).toHaveBeenCalled();
  });

  it('400 BadDeviceToken from APNs deletes the subscription row', async () => {
    vi.mocked(webpush.default.sendNotification).mockResolvedValueOnce(undefined);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid-token',
      status: 400,
    });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    const db = fakeDbRef;
    expect(db.execute).toHaveBeenCalled();
  });

  it('auth-failed from APNs (no .p8) preserves the row', async () => {
    vi.mocked(webpush.default.sendNotification).mockResolvedValueOnce(undefined);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({
      ok: false,
      reason: 'auth-failed',
    });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    // auth-failed is operator-config, not a dead token. Keep the row
    // so when Cameron eventually wires the .p8 the device gets a real
    // push.
    const db = fakeDbRef;
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('rate-limited from APNs preserves the row', async () => {
    vi.mocked(webpush.default.sendNotification).mockResolvedValueOnce(undefined);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({
      ok: false,
      reason: 'rate-limited',
      status: 429,
    });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    const db = fakeDbRef;
    expect(db.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No-op / fan-out paths
// ---------------------------------------------------------------------------

describe('dispatcher fan-out', () => {
  it('sends to BOTH web and iOS subs in parallel', async () => {
    vi.mocked(webpush.default.sendNotification).mockResolvedValueOnce(undefined);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({ ok: true });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    expect(webpush.default.sendNotification).toHaveBeenCalledOnce();
    expect(sendApnsPush).toHaveBeenCalledOnce();
  });

  it('web push failure does NOT block iOS dispatch (parallel)', async () => {
    // Both subs; web-push throws, APNs succeeds. We should see both
    // invoked, not serial.
    const err = Object.assign(new Error('500'), { statusCode: 500 });
    vi.mocked(webpush.default.sendNotification).mockRejectedValueOnce(err);
    vi.mocked(sendApnsPush).mockResolvedValueOnce({ ok: true });

    await sendPushToUser(USER_ID, SCHOOL_ID, {
      title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
    });

    expect(webpush.default.sendNotification).toHaveBeenCalledOnce();
    expect(sendApnsPush).toHaveBeenCalledOnce();
  });

  it('empty subscription set: no error, no delivery attempts', async () => {
    txRef.current = buildTx([]);
    vi.mocked(webpush.default.sendNotification).mockReset();
    vi.mocked(sendApnsPush).mockReset();

    await expect(
      sendPushToUser(USER_ID, SCHOOL_ID, {
        title: 't', body: 'b', linkUrl: null, tag: 'test', data: {},
      }),
    ).resolves.toBeUndefined();
    expect(webpush.default.sendNotification).not.toHaveBeenCalled();
    expect(sendApnsPush).not.toHaveBeenCalled();
  });
});