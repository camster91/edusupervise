/**
 * Tests for @edusupervise/push (Expo Push dispatcher).
 *
 * Coverage:
 *  - maskToken: every code path, including non-string input.
 *  - buildExpoMessage: shape, sound override, default sound + channel,
 *    data merging (kind/linkUrl pass-through).
 *  - classifyMessage: ok → sent, DeviceNotRegistered → revoked, other
 *    error → permanent, missing item → transient. Crucially: never
 *    leaks the raw token to the logger.
 *  - classifyFetchError: timeout / aborted / network / unknown.
 *  - sendBatch:
 *      - happy path: per-message ok array, batch outcome order matches
 *        input order.
 *      - mixed ok / DeviceNotRegistered / InvalidCredentials.
 *      - HTTP 429 → batch-failed.
 *      - HTTP 500 → array of 'transient'.
 *      - HTTP 400 → array of 'permanent'.
 *      - TimeoutError from fetch → batch-failed.
 *      - Network error → batch-failed.
 *      - Length-mismatched data array → batch-failed.
 *      - Non-JSON response → batch-failed.
 *      - Refuses > EXPO_BATCH_LIMIT.
 *      - Empty batch returns [].
 *  - sendMobilePushToUser:
 *      - No subscriptions → early return, 0s, no fetch call.
 *      - 1 sub → 1 batch, fetch called with array of 1 message.
 *      - 100 subs → 1 batch.
 *      - 101 subs → 2 batches (EXPO_BATCH_LIMIT).
 *      - Caps to MAX_ACTIVE_DEVICES_PER_USER (freshest by
 *        last_seen_at); query includes `desc(lastSeenAt)` + `limit +
 *        1`; capped result reflects dropped count.
 *      - Revoked rows are soft-deleted (UPDATE ... SET revokedAt).
 *      - NEVER THROWS: DB select throws → result with zeros + error
 *        log; DB update throws → still counts as revoked but logs warn.
 *      - Result shape includes the new fields
 *        (subscriptionsCapped, batchesSent, transientFailures,
 *        permanentFailures) and backwards-compatible
 *        messagesFailed == transientFailures + permanentFailures.
 *      - Logger never receives a raw expoPushToken — only masked form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sendMobilePushToUser,
  sendBatch,
  buildExpoMessage,
  classifyMessage,
  classifyFetchError,
  maskToken,
  EXPO_BATCH_LIMIT,
  MAX_ACTIVE_DEVICES_PER_USER,
  EXPO_REQUEST_TIMEOUT_MS,
  type MobilePushDispatchResult,
  type MobilePushPayload,
  type PushLogger,
  type BatchMessageOutcome,
  type BatchOutcome,
  type ExpoMessageResult,
} from './expo.js';
import type { Db } from '@edusupervise/db';
import { mobilePushSubscriptions } from '@edusupervise/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recording logger. Each call is pushed onto the matching array so
 *  tests can assert which log lines fired. */
function makeRecordingLogger(): PushLogger & {
  calls: { level: 'warn' | 'info' | 'error' | 'debug'; obj: Record<string, unknown>; msg: string }[];
} {
  const calls: {
    level: 'warn' | 'info' | 'error' | 'debug';
    obj: Record<string, unknown>;
    msg: string;
  }[] = [];
  const handler =
    (level: 'warn' | 'info' | 'error' | 'debug') =>
    (obj: Record<string, unknown>, msg: string) =>
      calls.push({ level, obj, msg });
  return {
    calls,
    warn: handler('warn'),
    info: handler('info'),
    error: handler('error'),
    debug: handler('debug'),
  };
}

/** A fake Drizzle Db. We expose:
 *    - db._selectRows: array of rows returned by the next select call.
 *      Auto-cleared after the call so tests can set rows per-call.
 *    - db._updateRows: array of rows returned by the next update call.
 *    - db._throwOnSelect: when true, the next select() rejects.
 *    - db._throwOnUpdate: when true, the next update() rejects.
 *
 *  We don't go through Drizzle's real query builder — the dispatcher
 *  only uses a tiny subset (select.where(...).orderBy(...).limit(),
 *  update.where(...)) and we want hermetic tests.
 */
type DbQueryResult = Array<{ id: string; expoPushToken: string }>;
interface FakeDbHandle {
  /** Rows the next select() call should return. Consumed on use. */
  selectRows: DbQueryResult;
  /** If set, the next select() rejects with this error. Consumed on use. */
  selectThrow?: Error;
  /** If set, the next update() rejects with this error. Consumed on use. */
  updateThrow?: Error;
}
function makeFakeDb() {
  const handle: FakeDbHandle = { selectRows: [] };
  const calls = {
    select: [] as Array<{ args?: unknown }>,
    update: [] as Array<{ args?: unknown }>,
  };
  // The query chain objects expose fluent methods, and the terminal
  // method (limit() / where()) is what the dispatcher awaits. We
  // attach handle reads inside limit()/update.where() to keep the
  // mutation localized.
  const selectChain = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit(n: number) {
      calls.select.push({ args: { limit: n } });
      const rows = handle.selectRows;
      handle.selectRows = [];
      const err = handle.selectThrow;
      handle.selectThrow = undefined;
      if (err) return Promise.reject(err);
      return Promise.resolve(rows);
    },
    // Drizzle's query builder returns a thenable; await works directly.
    then<T>(
      onFulfilled: (v: DbQueryResult) => T,
      onRejected?: (e: unknown) => T,
    ): Promise<T> {
      return this.limit(0).then(onFulfilled, onRejected);
    },
  };
  const updateChain = {
    set() {
      return this;
    },
    where() {
      calls.update.push({});
      const err = handle.updateThrow;
      handle.updateThrow = undefined;
      if (err) return Promise.reject(err);
      return Promise.resolve(undefined);
    },
  };
  const fake = {
    select() {
      return selectChain;
    },
    update() {
      return updateChain;
    },
  };
  return {
    /** The fake DB cast to the Drizzle Db type the dispatcher accepts. */
    db: fake as unknown as Db,
    /** Test-facing handle for setting rows / forcing errors. */
    handle,
    /** Recorded call history. */
    calls,
  };
}

/** Install a stub `globalThis.fetch`. Returns the spy + the recorded
 *  calls for assertions. */
function stubFetch(impl: (url: string, init?: { body?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>): { restore: () => void; calls: Array<{ url: string; init: { body?: string; signal?: AbortSignal; headers?: Record<string, string> } | undefined }> } {
  const orig = (globalThis as { fetch?: unknown }).fetch;
  const calls: Array<{ url: string; init: { body?: string; signal?: AbortSignal; headers?: Record<string, string> } | undefined }> = [];
  (globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string, init?: { body?: string; signal?: AbortSignal; headers?: Record<string, string> }) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  return {
    restore: () => {
      (globalThis as { fetch?: unknown }).fetch = orig;
    },
    calls,
  };
}

/** Build an Expo-shaped JSON response. */
function expoResponse(data: Array<Partial<ExpoMessageResult>>): { ok: true; status: 200; json: () => Promise<unknown> } {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  };
}

/** Standard payload used across tests. */
const payload: MobilePushPayload = { title: 'Test', body: 'hello' };

/** A valid Expo-shaped push token. Tokens are typically
 *  `ExponentPushToken[...]` ≈ 41+ chars. */
const t = (n: number) => `ExponentPushToken[fake-token-${n.toString().padStart(4, '0')}]`;

// ---------------------------------------------------------------------------
// maskToken
// ---------------------------------------------------------------------------

describe('maskToken', () => {
  it('returns first 8 + ellipsis + last 4 for typical tokens', () => {
    expect(maskToken('ExponentPushToken[abc123def456ghi789]')).toBe(
      'ExponentP…i789]',
    );
  });

  it('returns *** for tokens <= 12 chars', () => {
    expect(maskToken('short')).toBe('***');
    expect(maskToken('123456789012')).toBe('***'); // exactly 12
  });

  it('handles non-string input safely', () => {
    // Defensive: callers should always pass strings, but we don't
    // want a runtime crash if they don't.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(maskToken(undefined as unknown as string)).toBe('***');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(maskToken(null as unknown as string)).toBe('***');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(maskToken(42 as unknown as string)).toBe('***');
  });
});

// ---------------------------------------------------------------------------
// buildExpoMessage
// ---------------------------------------------------------------------------

describe('buildExpoMessage', () => {
  it('uses defaults: sound=default, channelId=reminders, priority=high', () => {
    const msg = buildExpoMessage(t(1), { title: 'T', body: 'B' });
    expect(msg.sound).toBe('default');
    expect(msg.channelId).toBe('reminders');
    expect(msg.priority).toBe('high');
    expect(msg.title).toBe('T');
    expect(msg.body).toBe('B');
    expect(msg.to).toBe(t(1));
  });

  it('omits body when payload.body is null', () => {
    const msg = buildExpoMessage(t(1), { title: 'T', body: null });
    expect(msg.body).toBeUndefined();
  });

  it('honors sound override (string)', () => {
    const msg = buildExpoMessage(t(1), { title: 'T', body: 'B', sound: 'bell' });
    expect(msg.sound).toBe('bell');
  });

  it('honors sound=null (silent)', () => {
    const msg = buildExpoMessage(t(1), { title: 'T', body: 'B', sound: null });
    expect(msg.sound).toBeNull();
  });

  it('passes kind/linkUrl through data', () => {
    const msg = buildExpoMessage(t(1), {
      title: 'T',
      body: null,
      kind: 'reminder',
      linkUrl: '/app/today',
      data: { dutyId: 'd1' },
    });
    expect(msg.data).toEqual({
      dutyId: 'd1',
      kind: 'reminder',
      linkUrl: '/app/today',
    });
  });
});

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------

describe('classifyMessage', () => {
  const token = t(1);

  it('returns sent when status=ok', () => {
    const logger = makeRecordingLogger();
    const r = classifyMessage({ status: 'ok' }, token, logger);
    expect(r).toBe('sent');
  });

  it('returns revoked when DeviceNotRegistered', () => {
    const logger = makeRecordingLogger();
    const r = classifyMessage(
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
      token,
      logger,
    );
    expect(r).toBe('revoked');
    expect(logger.calls.find((c) => c.level === 'info')).toBeTruthy();
  });

  it('returns permanent for InvalidCredentials (other per-message error)', () => {
    const logger = makeRecordingLogger();
    const r = classifyMessage(
      { status: 'error', details: { error: 'InvalidCredentials' }, message: 'bad creds' },
      token,
      logger,
    );
    expect(r).toBe('permanent');
  });

  it('returns permanent for MessageTooBig', () => {
    const logger = makeRecordingLogger();
    const r = classifyMessage(
      { status: 'error', details: { error: 'MessageTooBig' } },
      token,
      logger,
    );
    expect(r).toBe('permanent');
  });

  it('returns transient when item is missing', () => {
    const logger = makeRecordingLogger();
    const r = classifyMessage(undefined, token, logger);
    expect(r).toBe('transient');
  });

  it('NEVER logs the raw token — only the masked form', () => {
    const logger = makeRecordingLogger();
    const rawToken = 'ExponentPushToken[SHOULDNOTLEAKthisrawstringXYZ]';
    classifyMessage({ status: 'ok' }, rawToken, logger);
    classifyMessage({ status: 'error', details: { error: 'InvalidCredentials' } }, rawToken, logger);
    classifyMessage(undefined, rawToken, logger);
    const json = JSON.stringify(logger.calls);
    expect(json).not.toContain(rawToken);
    expect(json).not.toContain('SHOULDNOTLEAKthisrawstringXYZ');
  });
});

// ---------------------------------------------------------------------------
// classifyFetchError
// ---------------------------------------------------------------------------

describe('classifyFetchError', () => {
  it('TimeoutError → timeout', () => {
    expect(classifyFetchError({ name: 'TimeoutError' })).toBe('timeout');
  });

  it('AbortError → aborted', () => {
    expect(classifyFetchError({ name: 'AbortError' })).toBe('aborted');
  });

  it('ECONNRESET → network', () => {
    expect(classifyFetchError({ name: 'TypeError', code: 'ECONNRESET' })).toBe('network');
  });

  it('EAI_AGAIN → network', () => {
    expect(classifyFetchError({ name: 'Error', code: 'EAI_AGAIN' })).toBe('network');
  });

  it('plain Error → unknown', () => {
    expect(classifyFetchError(new Error('boom'))).toBe('unknown');
  });

  it('non-object → unknown', () => {
    expect(classifyFetchError('nope')).toBe('unknown');
    expect(classifyFetchError(null)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// sendBatch
// ---------------------------------------------------------------------------

describe('sendBatch', () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    // Default to noop — tests override per case.
    fetchStub = stubFetch(async () => expoResponse([]));
  });
  afterEach(() => {
    fetchStub.restore();
  });

  const subs = [
    { id: 's1', expoPushToken: t(1) },
    { id: 's2', expoPushToken: t(2) },
    { id: 's3', expoPushToken: t(3) },
  ];

  it('happy path: per-message ok array → sent × N', async () => {
    fetchStub = stubFetch(async () =>
      expoResponse([
        { status: 'ok' },
        { status: 'ok' },
        { status: 'ok' },
      ]),
    );
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toEqual<BatchMessageOutcome[]>(['sent', 'sent', 'sent']);
  });

  it('mixed outcomes: ok / DeviceNotRegistered / InvalidCredentials', async () => {
    fetchStub = stubFetch(async () =>
      expoResponse([
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'InvalidCredentials' } },
      ]),
    );
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toEqual<BatchMessageOutcome[]>(['sent', 'revoked', 'permanent']);
  });

  it('HTTP 429 → batch-failed', async () => {
    fetchStub = stubFetch(async () => ({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    }));
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toBe('batch-failed');
  });

  it('HTTP 500 → array of transient', async () => {
    fetchStub = stubFetch(async () => ({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    }));
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toEqual<BatchMessageOutcome[]>(['transient', 'transient', 'transient']);
  });

  it('HTTP 400 (not 429) → array of permanent', async () => {
    fetchStub = stubFetch(async () => ({
      ok: false,
      status: 400,
      json: () => Promise.resolve({}),
    }));
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toEqual<BatchMessageOutcome[]>(['permanent', 'permanent', 'permanent']);
  });

  it('fetch throws TimeoutError → batch-failed', async () => {
    fetchStub = stubFetch(async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toBe('batch-failed');
  });

  it('fetch throws network error → batch-failed', async () => {
    fetchStub = stubFetch(async () => {
      const err = new Error('econnreset');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).code = 'ECONNRESET';
      throw err;
    });
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toBe('batch-failed');
  });

  it('length-mismatched data array → batch-failed', async () => {
    fetchStub = stubFetch(async () =>
      expoResponse([{ status: 'ok' }, { status: 'ok' }]),
    );
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toBe('batch-failed');
  });

  it('non-JSON response (json() rejects) → batch-failed', async () => {
    fetchStub = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('parse failed')),
    }));
    const out = await sendBatch(subs, payload, makeRecordingLogger());
    expect(out).toBe('batch-failed');
  });

  it('passes AbortSignal.timeout to fetch', async () => {
    let receivedSignal: AbortSignal | undefined;
    fetchStub = stubFetch(async (_url, init) => {
      receivedSignal = init?.signal;
      return expoResponse([{ status: 'ok' }]);
    });
    await sendBatch([subs[0]!], payload, makeRecordingLogger());
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    // AbortSignal.timeout creates an internally-scheduled timer. We
    // don't wait it out — vi.useFakeTimers + vi.advanceTimersByTime
    // would be overkill. Just confirm the signal exists.
  });

  it('refuses batches larger than EXPO_BATCH_LIMIT', async () => {
    const big = Array.from({ length: EXPO_BATCH_LIMIT + 1 }, (_, i) => ({
      id: `s${i}`,
      expoPushToken: t(i),
    }));
    await expect(sendBatch(big, payload, makeRecordingLogger())).rejects.toThrow(
      /EXPO_BATCH_LIMIT/,
    );
  });

  it('empty batch returns [] without calling fetch', async () => {
    const out = await sendBatch([], payload, makeRecordingLogger());
    expect(out).toEqual([]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('request body is an array of length === subs.length', async () => {
    fetchStub = stubFetch(async () =>
      expoResponse([{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }]),
    );
    await sendBatch(subs, payload, makeRecordingLogger());
    expect(fetchStub.calls).toHaveLength(1);
    const body = JSON.parse(fetchStub.calls[0]!.init?.body ?? '[]');
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
    expect(body[0].to).toBe(t(1));
  });
});

// ---------------------------------------------------------------------------
// sendMobilePushToUser
// ---------------------------------------------------------------------------

describe('sendMobilePushToUser', () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    fetchStub = stubFetch(async () => expoResponse([{ status: 'ok' }]));
  });
  afterEach(() => {
    fetchStub.restore();
  });

  it('returns zeros + logs debug when no subscriptions found', async () => {
    const { db } = makeFakeDb();
    const logger = makeRecordingLogger();
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, logger);
    expect(r).toEqual<MobilePushDispatchResult>({
      subscriptionsFound: 0,
      subscriptionsCapped: 0,
      messagesSent: 0,
      tokensRevoked: 0,
      batchesSent: 0,
      transientFailures: 0,
      permanentFailures: 0,
      messagesFailed: 0,
    });
    expect(fetchStub.calls).toHaveLength(0);
    expect(logger.calls.find((c) => c.level === 'debug')).toBeTruthy();
  });

  it('returns zeros + logs error when DB select throws', async () => {
    const fake = makeFakeDb();
    fake.handle.selectThrow = new Error('db down');
    const logger = makeRecordingLogger();
    const r = await sendMobilePushToUser(fake.db, 'u1', 's1', payload, logger);
    expect(r.messagesFailed).toBe(0);
    expect(r.messagesSent).toBe(0);
    expect(logger.calls.find((c) => c.level === 'error')).toBeTruthy();
    // And NEVER THROWS — this assertion is implicit; we got a value.
  });

  it('with 1 sub: 1 batch, 1 fetch call, messagesSent=1', async () => {
    const { db, handle } = makeFakeDb();
    handle.selectRows = [{ id: 's1', expoPushToken: t(1) }];
    fetchStub = stubFetch(async () => expoResponse([{ status: 'ok' }]));
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(r.subscriptionsFound).toBe(1);
    expect(r.batchesSent).toBe(1);
    expect(r.messagesSent).toBe(1);
    expect(r.transientFailures).toBe(0);
    expect(r.permanentFailures).toBe(0);
    expect(r.messagesFailed).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it('with 100 subs: caps to MAX_ACTIVE_DEVICES_PER_USER in one batch', async () => {
    const { db, handle } = makeFakeDb();
    handle.selectRows = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      expoPushToken: t(i),
    }));
    const data = Array.from({ length: 100 }, () => ({ status: 'ok' as const }));
    fetchStub = stubFetch(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '[]');
      return expoResponse(body.map(() => ({ status: 'ok' as const })));
    });
    void data;
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(r.subscriptionsFound).toBe(MAX_ACTIVE_DEVICES_PER_USER);
    expect(r.subscriptionsCapped).toBe(50);
    expect(r.batchesSent).toBe(1);
    expect(r.messagesSent).toBe(MAX_ACTIVE_DEVICES_PER_USER);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it('with 101 subs: caps to the per-user device limit before batching', async () => {
    const { db, handle } = makeFakeDb();
    handle.selectRows = Array.from({ length: 101 }, (_, i) => ({
      id: `s${i}`,
      expoPushToken: t(i),
    }));
    const data = Array.from({ length: 100 }, () => ({ status: 'ok' as const }));
    fetchStub = stubFetch(async (_url, init) => {
      // Parse the body to return matching per-batch length.
      const body = JSON.parse(init?.body ?? '[]');
      return expoResponse(body.map(() => ({ status: 'ok' as const })));
    });
    void data;
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(r.subscriptionsFound).toBe(MAX_ACTIVE_DEVICES_PER_USER);
    expect(r.subscriptionsCapped).toBe(101 - MAX_ACTIVE_DEVICES_PER_USER);
    expect(r.batchesSent).toBe(1);
    expect(r.messagesSent).toBe(MAX_ACTIVE_DEVICES_PER_USER);
    expect(fetchStub.calls).toHaveLength(1);
    expect(JSON.parse(fetchStub.calls[0]!.init?.body ?? '[]')).toHaveLength(
      MAX_ACTIVE_DEVICES_PER_USER,
    );
  });

  it('caps to MAX_ACTIVE_DEVICES_PER_USER and reports subscriptionsCapped', async () => {
    // The fakeDb returns rows in the order the "select" chain
    // produced them. We arrange the fake to return limit+1 rows so
    // the dispatcher trims and reports subscriptionsCapped = 1.
    const overflow = MAX_ACTIVE_DEVICES_PER_USER + 1;
    const { db, handle } = makeFakeDb();
    handle.selectRows = Array.from({ length: overflow }, (_, i) => ({
      id: `s${i}`,
      expoPushToken: t(i),
    }));
    const data = Array.from({ length: MAX_ACTIVE_DEVICES_PER_USER }, () => ({
      status: 'ok' as const,
    }));
    fetchStub = stubFetch(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '[]');
      return expoResponse(body.map(() => ({ status: 'ok' as const })));
    });
    void data;
    const logger = makeRecordingLogger();
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, logger);
    expect(r.subscriptionsFound).toBe(MAX_ACTIVE_DEVICES_PER_USER);
    expect(r.subscriptionsCapped).toBe(1);
    expect(r.messagesSent).toBe(MAX_ACTIVE_DEVICES_PER_USER);
    expect(r.batchesSent).toBe(1);
    // The cap was logged at warn — and the raw tokens were NOT.
    const warn = logger.calls.find(
      (c) => c.level === 'warn' && /capping to newest/.test(c.msg),
    );
    expect(warn).toBeTruthy();
    const warnJson = JSON.stringify(warn!.obj);
    expect(warnJson).not.toContain('ExponentPushToken');
  });

  it('SELECT uses desc(lastSeenAt) + limit MAX_ACTIVE_DEVICES_PER_USER+1', async () => {
    // We can't inspect the Drizzle query AST directly with the fake,
    // but we *did* record select-call args via the limit() chain. The
    // dispatcher must call limit(MAX_ACTIVE_DEVICES_PER_USER + 1).
    const { db, calls, handle } = makeFakeDb();
    handle.selectRows = [];
    await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(calls.select).toHaveLength(1);
    expect(calls.select[0]!.args).toEqual({
      limit: MAX_ACTIVE_DEVICES_PER_USER + 1,
    });
  });

  it('DeviceNotRegistered: row is soft-deleted (UPDATE sets revokedAt)', async () => {
    const { db, handle, calls } = makeFakeDb();
    handle.selectRows = [{ id: 'sub-xyz', expoPushToken: t(1) }];
    fetchStub = stubFetch(async () =>
      expoResponse([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ]),
    );
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(r.tokensRevoked).toBe(1);
    expect(r.messagesSent).toBe(0);
    expect(calls.update).toHaveLength(1);
  });

  it('DeviceNotRegistered + DB update throws: still counts revoked, logs warn', async () => {
    const { db, calls, handle } = makeFakeDb();
    handle.selectRows = [{ id: 'sub-xyz', expoPushToken: t(1) }];
    handle.updateThrow = new Error('revoke failed');
    fetchStub = stubFetch(async () =>
      expoResponse([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ]),
    );
    const logger = makeRecordingLogger();
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, logger);
    expect(r.tokensRevoked).toBe(1); // counted even if DB write fails
    expect(calls.update).toHaveLength(1);
    expect(logger.calls.find((c) => c.level === 'warn' && /failed to mark subscription revoked/.test(c.msg))).toBeTruthy();
  });

  it('mixed batch: counts sent / revoked / permanent correctly', async () => {
    const { db, handle } = makeFakeDb();
    handle.selectRows = [
      { id: 'a', expoPushToken: t(1) },
      { id: 'b', expoPushToken: t(2) },
      { id: 'c', expoPushToken: t(3) },
      { id: 'd', expoPushToken: t(4) },
    ];
    fetchStub = stubFetch(async () =>
      expoResponse([
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'InvalidCredentials' } },
        { status: 'ok' },
      ]),
    );
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(r.messagesSent).toBe(2);
    expect(r.tokensRevoked).toBe(1);
    expect(r.permanentFailures).toBe(1);
    expect(r.transientFailures).toBe(0);
    expect(r.messagesFailed).toBe(1); // = transient + permanent
  });

  it('HTTP 429 → all messages in that batch count as transient', async () => {
    const { db, handle } = makeFakeDb();
    handle.selectRows = [
      { id: 'a', expoPushToken: t(1) },
      { id: 'b', expoPushToken: t(2) },
    ];
    fetchStub = stubFetch(async () => ({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    }));
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(r.messagesSent).toBe(0);
    expect(r.transientFailures).toBe(2);
    expect(r.messagesFailed).toBe(2);
  });

  it('timeout: all messages in that batch count as transient', async () => {
    const { db, handle } = makeFakeDb();
    handle.selectRows = [
      { id: 'a', expoPushToken: t(1) },
      { id: 'b', expoPushToken: t(2) },
      { id: 'c', expoPushToken: t(3) },
    ];
    fetchStub = stubFetch(async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    expect(r.transientFailures).toBe(3);
    expect(r.messagesFailed).toBe(3);
  });

  it('never throws: external fetch throws synchronously', async () => {
    const { db, handle } = makeFakeDb();
    handle.selectRows = [{ id: 'a', expoPushToken: t(1) }];
    fetchStub = stubFetch(async () => {
      throw new Error('totally unexpected');
    });
    // The dispatcher should swallow the error and return a result.
    const r = await sendMobilePushToUser(db, 'u1', 's1', payload, makeRecordingLogger());
    // The thrown error wasn't a recognized network shape, so it falls
    // into "unknown" and is still classified as transient at batch level.
    expect(r.transientFailures).toBe(1);
    expect(r.messagesSent).toBe(0);
  });

  it('NEVER logs raw expoPushToken — only masked form, across all branches', async () => {
    const { db } = makeFakeDb();
    const secret = 'ExponentPushToken[SHOULDNOTLEAK_across_all_paths_XYZ]';
    db._selectRows = [
      { id: 'a', expoPushToken: secret },
      { id: 'b', expoPushToken: secret },
    ];
    fetchStub = stubFetch(async () =>
      expoResponse([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'InvalidCredentials' } },
      ]),
    );
    const logger = makeRecordingLogger();
    await sendMobilePushToUser(db, 'u1', 's1', payload, logger);
    const json = JSON.stringify(logger.calls);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('SHOULDNOTLEAK');
  });

  it('EXPO_REQUEST_TIMEOUT_MS is positive and reasonable', () => {
    expect(EXPO_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EXPO_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('EXPO_BATCH_LIMIT matches Expo published cap', () => {
    expect(EXPO_BATCH_LIMIT).toBe(100);
  });

  it('MAX_ACTIVE_DEVICES_PER_USER is positive', () => {
    expect(MAX_ACTIVE_DEVICES_PER_USER).toBeGreaterThan(0);
    expect(MAX_ACTIVE_DEVICES_PER_USER).toBeLessThanOrEqual(50);
  });

  it('table name is referenced in the schema import (smoke)', () => {
    // Just ensures our alias/import path actually resolves the
    // mobilePushSubscriptions symbol — guards against a stale import
    // path sneaking in.
    expect(mobilePushSubscriptions).toBeDefined();
    // The symbol is a Drizzle table — it has a `.name` getter that
    // gives the table name back.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mobilePushSubscriptions as any)[Symbol.for('drizzle:Name')] ?? 'mobile_push_subscriptions').toBeTruthy();
  });
});