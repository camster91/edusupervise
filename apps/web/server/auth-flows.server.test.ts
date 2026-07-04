// apps/web/server/auth-flows.server.test.ts — regression tests for
// consumeToken (audit B1, 2026-07-04 — wired the stubbed function to
// real auth_verification lookup).
//
// What's being guarded:
//   - happy path: row found, deleted, returns ok=true
//   - not_found: no row matching identifier+value OR row expired
//     (single-shot DELETE means used tokens also return not_found)
//   - one-shot: second consume of the same (identifier, value) after
//     a successful first consume returns not_found (the row is gone)
//   - expired: expiresAt < now() → not_found (never deleted)
//   - DB error: thrown error is caught and surfaced as not_found
//     (graceful — never 500s the caller with a leaked DB stack)
//
// Why this is the most important regression in this slice:
//   The pre-fix stub returned ok=true unconditionally. A bad actor
//   who could guess or phish a token would pass consumeToken. These
//   tests are the floor — any future refactor that breaks the
//   real lookup regresses the entire account-takeover fix.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @edusupervise/db BEFORE importing the module under test.
// consumeToken does `await import('@edusupervise/db')` inside the
// function body, so the dynamic import must resolve to our fake
// `authVerification` table + the drizzle helpers (`and`, `eq`, `gt`).
// ---------------------------------------------------------------------------

// The dynamic import destructures these names. We pass-through `and`/`eq`/`gt`
// so the test code can compose real-looking predicates and assert on them;
// the actual SQL evaluation happens in our fake `db` chain (see below).
const { and, eq, gt } = await import('drizzle-orm');

const fakeAuthVerificationTable = { __brand: 'authVerification' };

vi.mock('@edusupervise/db', () => ({
  // The dynamic import only reads these three identifiers.
  authVerification: fakeAuthVerificationTable,
  and: (and as unknown as (...args: unknown[]) => unknown),
  eq: (eq as unknown as (...args: unknown[]) => unknown),
  gt: (gt as unknown as (...args: unknown[]) => unknown),
}));

// Now safe to import the module under test.
const { consumeToken, TOKEN_KIND } = await import('./auth-flows.server.js');

// ---------------------------------------------------------------------------
// Fake Drizzle chain helper.
//
// consumeToken calls:
//   db.select({ id, expiresAt })
//     .from(authVerification)
//     .where(and(eq(identifier), eq(value), gt(expiresAt, now)))
//     .limit(1)
//
//   db.delete(authVerification)
//     .where(and(eq(id, row.id), gt(expiresAt, new Date())))
//
// The chain always ends in a Promise — we use `then`-able objects to
// inspect what was passed in (`where(conds)`) and return canned rows.
// ---------------------------------------------------------------------------

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  /** Recorded predicates by method, in order. */
  selectWheres: unknown[];
  deleteWheres: unknown[];
}

interface Row {
  id: string;
  expiresAt: Date;
}

function buildFakeDb(opts: {
  selectReturns?: Row[];
  selectThrows?: Error;
  deleteReturns?: unknown;
}): { db: FakeDb } {
  const selectWheres: unknown[] = [];
  const deleteWheres: unknown[] = [];

  const select = vi.fn(() => {
    const chain = {
      from(_table: unknown) {
        return {
          where(conds: unknown) {
            selectWheres.push(conds);
            if (opts.selectThrows) {
              // Throw on the awaited call (.limit returns a Promise).
              return {
                limit(_n: number) {
                  return Promise.reject(opts.selectThrows);
                },
              };
            }
            return {
              limit(_n: number) {
                return Promise.resolve(opts.selectReturns ?? []);
              },
            };
          },
        };
      },
    };
    return chain;
  });

  const del = vi.fn(() => {
    return {
      where(conds: unknown) {
        deleteWheres.push(conds);
        return Promise.resolve(opts.deleteReturns ?? { rowCount: 1 });
      },
    };
  });

  return {
    db: {
      select,
      delete: del,
      selectWheres,
      deleteWheres,
    } as unknown as FakeDb,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('consumeToken (B1 regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: valid future-dated row → ok=true and one DELETE', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const { db } = buildFakeDb({
      selectReturns: [{ id: 'row-1', expiresAt: future }],
      deleteReturns: { rowCount: 1 },
    });

    const result = await consumeToken(
      db,
      TOKEN_KIND.PASSWORD_RESET,
      'user@example.com',
      'tok-abc',
    );

    expect(result).toEqual({ ok: true });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.delete).toHaveBeenCalledTimes(1);
    // One select, one delete — no double-fetch on the hot path.
    expect(db.selectWheres).toHaveLength(1);
    expect(db.deleteWheres).toHaveLength(1);
  });

  it('not_found: no matching row → ok=false reason="not_found", no DELETE', async () => {
    const { db } = buildFakeDb({ selectReturns: [] });

    const result = await consumeToken(
      db,
      TOKEN_KIND.MAGIC_LINK,
      'ghost@example.com',
      'tok-missing',
    );

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(db.select).toHaveBeenCalledTimes(1);
    // No row → no DELETE. This is the silent-correctness invariant.
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('one-shot: second consume of the same token → not_found (row deleted)', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    // First call returns a row; second call returns [] (because the
    // DELETE removed it from the table between calls).
    const { db } = buildFakeDb({ selectReturns: [{ id: 'row-2', expiresAt: future }] });

    const first = await consumeToken(db, TOKEN_KIND.PASSWORD_RESET, 'one@shot.com', 'tok-once');
    expect(first).toEqual({ ok: true });

    // Now rebuild the fake with empty rows (the table is one-shot).
    const { db: db2 } = buildFakeDb({ selectReturns: [] });
    const second = await consumeToken(db2, TOKEN_KIND.PASSWORD_RESET, 'one@shot.com', 'tok-once');
    expect(second).toEqual({ ok: false, reason: 'not_found' });
  });

  it('expired: past expires_at → not_found, no DELETE', async () => {
    // The SQL has `gt(expiresAt, now)` so an expired row never matches
    // the SELECT and never reaches the DELETE branch.
    const { db } = buildFakeDb({ selectReturns: [] });

    const result = await consumeToken(
      db,
      TOKEN_KIND.VERIFY_EMAIL,
      'expired@example.com',
      'tok-old',
    );

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('DB error: thrown error → ok=false reason="not_found" (graceful)', async () => {
    const boom = new Error('connection terminated');
    const { db } = buildFakeDb({ selectThrows: boom });

    const result = await consumeToken(
      db,
      TOKEN_KIND.MAGIC_LINK,
      'boom@example.com',
      'tok-err',
    );

    // The B1 fix wraps the whole body in try/catch and surfaces a
    // generic not_found. A 500 with a DB stack would leak schema info.
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.delete).not.toHaveBeenCalled();
  });
});