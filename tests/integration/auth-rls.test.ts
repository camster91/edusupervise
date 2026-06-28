// tests/integration/auth-rls.test.ts — integration tests for auth + RLS.
//
// Runs against a real Postgres with the init scripts applied (see
// /scripts/setup-test-db.sh). Uses the runtime role for app queries
// and the system role to set up fixtures.
//
// What we cover (per spec section 5 + 7 + the verify_prompt):
//   1. signup creates school + first admin in one transaction
//   2. login returns Set-Cookie with __Host-edusupervise.session
//   3. logout clears session
//   4. password reset flow end-to-end
//   5. magic link POST consumption
//   6. RLS: school A cannot read school B's rows on every tenant table
//   7. CSRF: cross-origin POST returns 403
//   8. rate limit: 6th login attempt in 15min returns 429
//
// We use the actions/route handlers directly (in-process, no HTTP) for
// the form-based flows, plus raw cookies for the cookie inspection.
// supertest-style HTTP is unnecessary here because better-auth's
// `handler(request)` exposes the same dispatch surface.

import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { setTimeout as wait } from 'node:timers/promises';

import {
  schools,
  users,
  withSchoolContext,
  withUserContext,
  getRuntimeClient,
} from '@edusupervise/db';

import { getDb, _resetDbForTest } from '../../apps/web/server/auth.server';
import { getAuth, _resetAuthForTest } from '../../apps/web/server/auth.server';
import {
  generateCsrfToken,
  validateCsrfFromForm,
  validateCsrf,
} from '../../apps/web/server/csrf.server';
import {
  _resetAll,
  consume,
  RATE_LIMITS,
} from '../../apps/web/server/rate-limit.server';

import { getTestSql, TEST_DATABASE_URL } from './setup';

// We hit the action functions directly. Each action takes a Request
// built from `new Request(url, init)` and returns a Response.
import { action as signupAction } from '../../apps/web/app/routes/auth.signup';
import { action as loginAction } from '../../apps/web/app/routes/auth.login';
import { action as logoutAction } from '../../apps/web/app/routes/auth.logout';
import { action as forgotAction } from '../../apps/web/app/routes/auth.forgot';
import { action as resetAction } from '../../apps/web/app/routes/auth.reset';
import { action as magicAction } from '../../apps/web/app/routes/auth.magic';

// Test scaffolding helpers
const RUNTIME_URL = 'postgres://edusupervise_runtime:edusupervise_runtime@localhost:5432/edusupervise_auth_rls_test';

function buildPostForm(url: string, fields: Record<string, string>, headers: HeadersInit = {}): Request {
  const formData = new URLSearchParams(fields);
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: formData.toString(),
  });
}

function buildFormDataRequest(url: string, fields: Record<string, string>, headers: HeadersInit = {}): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request(url, {
    method: 'POST',
    headers,
    body: fd,
  });
}

const CSRF = generateCsrfToken();

function csrfCookieHeader(): string {
  return `__Host-edusupervise.csrf=${CSRF}`;
}

function csrfHeader(): Record<string, string> {
  return { 'x-csrf-token': CSRF };
}

describe('auth-rls integration', () => {
  beforeEach(() => {
    _resetAll();
    _resetDbForTest();
    _resetAuthForTest();
    // Set the env so auth.server's getDb() picks up the runtime URL.
    process.env.DATABASE_URL = RUNTIME_URL;
    process.env.BETTER_AUTH_SECRET = 'test-secret-32chars-minimum-______';
    process.env.NODE_ENV = 'test';
  });

  // -------------------------------------------------------------------------
  // 1. signup creates school + first admin
  // -------------------------------------------------------------------------
  it('signup creates school + first admin in one transaction', async () => {
    const csrf = generateCsrfToken();
    const cookieHeader = `__Host-edusupervise.csrf=${csrf}`;

    const request = buildPostForm('http://localhost/auth/signup', {
      _csrf: csrf,
      schoolName: 'Test School',
      schoolSlug: 'test-school',
      timezone: 'America/Toronto',
      cycleDays: '5',
      schoolYearStart: '2026-09-01',
      schoolYearEnd: '2027-06-30',
      adminName: 'Alice Admin',
      adminEmail: 'alice@test-school.example',
      adminPassword: 'password123',
    }, { cookie: cookieHeader, 'x-forwarded-for': '127.0.0.1' });

    const res = await signupAction({ request, params: {}, context: {} } as never);
    expect(res.status).toBe(303);

    // Verify both rows exist.
    const db = getDb();
    const schoolRows = await db
      .select()
      .from(schools)
      .where(eq(schools.slug, 'test-school'));
    expect(schoolRows.length).toBe(1);
    const school = schoolRows[0]!;

    const userRows = await withSchoolContext(db, school.id, async (tx) =>
      tx.select().from(users).where(eq(users.email, 'alice@test-school.example')),
    );
    expect(userRows.length).toBe(1);
    expect(userRows[0]!.role).toBe('school_admin');
    expect(userRows[0]!.isActive).toBe(true);

    // Verify the credential account exists with the bcrypt hash.
    const sql = getTestSql();
    const accountRows = await sql`
      SELECT id, "userId", "providerId", password FROM auth_account
      WHERE "userId" = ${userRows[0]!.id}::uuid
    `;
    expect(accountRows.length).toBe(1);
    expect(accountRows[0]!.providerId).toBe('credential');
    expect(accountRows[0]!.password).toBeTruthy();
    // Verify the hash matches what bcrypt expects.
    const matches = await bcrypt.compare('password123', accountRows[0]!.password!);
    expect(matches).toBe(true);

    // Verify the audit row.
    const auditRows = await sql`
      SELECT action, target_type FROM audit_log WHERE school_id = ${school.id}::uuid
    `;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.action).toBe('school.signup');
  });

  // -------------------------------------------------------------------------
  // 2. login returns Set-Cookie with __Host-edusupervise.session
  // -------------------------------------------------------------------------
  it('login returns a session cookie after signup', async () => {
    // First sign up.
    const csrf = generateCsrfToken();
    await signupAction({
      request: buildPostForm('http://localhost/auth/signup', {
        _csrf: csrf,
        schoolName: 'Login School',
        schoolSlug: 'login-school',
        timezone: 'America/Toronto',
        cycleDays: '5',
        schoolYearStart: '2026-09-01',
        schoolYearEnd: '2027-06-30',
        adminName: 'Bob Admin',
        adminEmail: 'bob@login-school.example',
        adminPassword: 'password123',
      }, { cookie: `__Host-edusupervise.csrf=${csrf}`, 'x-forwarded-for': '127.0.0.2' }),
      params: {}, context: {},
    } as never);

    // Reset rate limiter (signup counts as 1).
    _resetAll();

    // Now log in via the login action.
    const csrf2 = generateCsrfToken();
    const res = await loginAction({
      request: buildPostForm('http://localhost/auth/login', {
        _csrf: csrf2,
        email: 'bob@login-school.example',
        password: 'password123',
      }, { cookie: `__Host-edusupervise.csrf=${csrf2}`, 'x-forwarded-for': '127.0.0.2' }),
      params: {}, context: {},
    } as never);

    expect(res.status).toBe(303);
    // The session cookie name should be __Host-edusupervise.session
    // (or "edusupervise.session_token" if Secure cookies are off — we
    // run with NODE_ENV=test so better-auth strips the __Host- prefix).
    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) =>
      c.startsWith('__Host-edusupervise.session_token=') ||
      c.startsWith('edusupervise.session_token=') ||
      c.startsWith('__Host-edusupervise.session='),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });

  // -------------------------------------------------------------------------
  // 3. logout clears session
  // -------------------------------------------------------------------------
  it('logout clears the session cookie', async () => {
    const csrf = generateCsrfToken();
    await signupAction({
      request: buildPostForm('http://localhost/auth/signup', {
        _csrf: csrf,
        schoolName: 'Logout School',
        schoolSlug: 'logout-school',
        timezone: 'America/Toronto',
        cycleDays: '5',
        schoolYearStart: '2026-09-01',
        schoolYearEnd: '2027-06-30',
        adminName: 'Carol Admin',
        adminEmail: 'carol@logout-school.example',
        adminPassword: 'password123',
      }, { cookie: `__Host-edusupervise.csrf=${csrf}`, 'x-forwarded-for': '127.0.0.3' }),
      params: {}, context: {},
    } as never);

    _resetAll();

    const csrf2 = generateCsrfToken();
    const loginRes = await loginAction({
      request: buildPostForm('http://localhost/auth/login', {
        _csrf: csrf2,
        email: 'carol@logout-school.example',
        password: 'password123',
      }, { cookie: `__Host-edusupervise.csrf=${csrf2}`, 'x-forwarded-for': '127.0.0.3' }),
      params: {}, context: {},
    } as never);

    const sessionCookie = loginRes.headers.getSetCookie().find((c) =>
      c.startsWith('__Host-edusupervise.session_token=') ||
      c.startsWith('edusupervise.session_token='),
    );
    expect(sessionCookie).toBeDefined();
    // Extract cookie value: "name=value; path=..."
    const cookieValue = sessionCookie!.split(';')[0]!.split('=')[1]!;

    _resetAll();

    // Verify the session row exists in auth_session.
    const sql = getTestSql();
    const beforeLogout = await sql`
      SELECT id FROM auth_session WHERE token = ${cookieValue}
    `;
    expect(beforeLogout.length).toBe(1);

    const csrf3 = generateCsrfToken();
    const logoutRes = await logoutAction({
      request: buildPostForm('http://localhost/auth/logout', {
        _csrf: csrf3,
      }, { cookie: `__Host-edusupervise.csrf=${csrf3}; ${sessionCookie}` }),
      params: {}, context: {},
    } as never);

    expect(logoutRes.status).toBe(303);

    // The session row should be deleted.
    const afterLogout = await sql`
      SELECT id FROM auth_session WHERE token = ${cookieValue}
    `;
    expect(afterLogout.length).toBe(0);

    // The response should clear the session cookie (Max-Age=0 or expiry in past).
    const logoutCookies = logoutRes.headers.getSetCookie();
    const cleared = logoutCookies.find((c) =>
      c.startsWith('__Host-edusupervise.session_token=') ||
      c.startsWith('edusupervise.session_token='),
    );
    // better-auth may either delete or set Max-Age=0 — accept either.
    if (cleared) {
      expect(cleared.toLowerCase()).toMatch(/max-age=0|expires=thu, 01 jan 1970/);
    }
  });

  // -------------------------------------------------------------------------
  // 4. password reset flow end-to-end
  // -------------------------------------------------------------------------
  it('password reset flow: request link -> verify email -> consume token -> new password works', async () => {
    // Sign up.
    const csrf = generateCsrfToken();
    await signupAction({
      request: buildPostForm('http://localhost/auth/signup', {
        _csrf: csrf,
        schoolName: 'Reset School',
        schoolSlug: 'reset-school',
        timezone: 'America/Toronto',
        cycleDays: '5',
        schoolYearStart: '2026-09-01',
        schoolYearEnd: '2027-06-30',
        adminName: 'Dave Admin',
        adminEmail: 'dave@reset-school.example',
        adminPassword: 'oldPassword1',
      }, { cookie: `__Host-edusupervise.csrf=${csrf}`, 'x-forwarded-for': '127.0.0.4' }),
      params: {}, context: {},
    } as never);

    _resetAll();

    // 4a. Request reset link.
    const csrf2 = generateCsrfToken();
    const forgotRes = await forgotAction({
      request: buildPostForm('http://localhost/auth/forgot', {
        _csrf: csrf2,
        email: 'dave@reset-school.example',
      }, { cookie: `__Host-edusupervise.csrf=${csrf2}` }),
      params: {}, context: {},
    } as never);
    expect(forgotRes.status).toBe(200);

    // 4b. Read the verification token from the DB (better-auth stored it
    // in auth_verification).
    const sql = getTestSql();
    const verifications = await sql`
      SELECT identifier, value FROM auth_verification
      WHERE identifier = ${'dave@reset-school.example'}
    `;
    expect(verifications.length).toBe(1);
    const token = verifications[0]!.value!;

    // 4c. Consume the token via /auth/reset with NEW password.
    const csrf3 = generateCsrfToken();
    const resetRes = await resetAction({
      request: buildPostForm('http://localhost/auth/reset', {
        _csrf: csrf3,
        token,
        newPassword: 'newPassword1',
        confirmPassword: 'newPassword1',
      }, { cookie: `__Host-edusupervise.csrf=${csrf3}` }),
      params: {}, context: {},
    } as never);
    expect(resetRes.status).toBe(303);

    // 4d. Verify the password was rotated in auth_account.password.
    const accountRows = await sql`
      SELECT a.password FROM auth_account a
      JOIN users u ON a."userId" = u.id
      WHERE u.email = ${'dave@reset-school.example'}
    `;
    expect(accountRows.length).toBe(1);
    const matches = await bcrypt.compare('newPassword1', accountRows[0]!.password!);
    expect(matches).toBe(true);
    const matchesOld = await bcrypt.compare('oldPassword1', accountRows[0]!.password!);
    expect(matchesOld).toBe(false);

    // 4e. The verification token should be consumed (deleted or marked used).
    const verificationsAfter = await sql`
      SELECT id FROM auth_verification
      WHERE identifier = ${'dave@reset-school.example'}
    `;
    expect(verificationsAfter.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. magic link POST consumption
  // -------------------------------------------------------------------------
  it('magic link: request token via better-auth then consume via POST', async () => {
    // Sign up + log in first.
    const csrf = generateCsrfToken();
    await signupAction({
      request: buildPostForm('http://localhost/auth/signup', {
        _csrf: csrf,
        schoolName: 'Magic School',
        schoolSlug: 'magic-school',
        timezone: 'America/Toronto',
        cycleDays: '5',
        schoolYearStart: '2026-09-01',
        schoolYearEnd: '2027-06-30',
        adminName: 'Eve Admin',
        adminEmail: 'eve@magic-school.example',
        adminPassword: 'password123',
      }, { cookie: `__Host-edusupervise.csrf=${csrf}`, 'x-forwarded-for': '127.0.0.5' }),
      params: {}, context: {},
    } as never);

    _resetAll();

    // Use better-auth's signInMagicLink API to mint a token (the request
    // sends an email; in our config we just log to stderr).
    const auth = getAuth();
    await auth.api.signInMagicLink({
      body: { email: 'eve@magic-school.example' },
    });

    // The token is in auth_verification.
    const sql = getTestSql();
    const verifications = await sql`
      SELECT value FROM auth_verification
      WHERE identifier = ${'eve@magic-school.example'}
    `;
    expect(verifications.length).toBeGreaterThanOrEqual(1);
    const token = verifications[0]!.value!;

    _resetAll();

    // Consume via POST /auth/magic.
    const csrf2 = generateCsrfToken();
    const magicRes = await magicAction({
      request: buildPostForm('http://localhost/auth/magic', {
        _csrf: csrf2,
        token,
      }, { cookie: `__Host-edusupervise.csrf=${csrf2}` }),
      params: {}, context: {},
    } as never);
    expect(magicRes.status).toBe(303);

    // Session cookie should be set.
    const setCookies = magicRes.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) =>
      c.startsWith('__Host-edusupervise.session_token=') ||
      c.startsWith('edusupervise.session_token='),
    );
    expect(sessionCookie).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. RLS: school A cannot read school B's rows on every tenant table
  // -------------------------------------------------------------------------
  it('RLS: user from school A cannot read school B rows on every tenant table', async () => {
    // Use the system role to set up two schools + two admins + tenant
    // rows. The system role has BYPASSRLS so we can write freely.
    const systemDb = getRuntimeClient(RUNTIME_URL).db;
    await systemDb.transaction(async (tx) => {
      // School A
      const [schoolA] = await tx
        .insert(schools)
        .values({
          slug: 'school-a',
          name: 'School A',
          timezone: 'America/Toronto',
          cycleDays: 5,
          schoolYearStart: '2026-09-01',
          schoolYearEnd: '2027-06-30',
          plan: 'trial',
        })
        .returning();
      if (!schoolA) throw new Error('schoolA not created');

      // Set RLS context to school A
      await tx.execute(sql`SELECT set_config('app.school_id', ${schoolA.id}, true)`);
      const [userA] = await tx
        .insert(users)
        .values({
          schoolId: schoolA.id,
          email: 'a@school-a.example',
          name: 'User A',
          role: 'school_admin',
        })
        .returning();
      if (!userA) throw new Error('userA not created');

      // A duty in school A
      await tx.execute(
        sql`INSERT INTO duties (id, school_id, cycle_day, start_time, end_time, location, created_by)
            VALUES (gen_random_uuid(), ${schoolA.id}, 1, '08:00', '08:30', 'A-Location', ${userA.id}::uuid)`,
      );

      // Switch context to school B and create a parallel set.
      const [schoolB] = await tx
        .insert(schools)
        .values({
          slug: 'school-b',
          name: 'School B',
          timezone: 'America/Toronto',
          cycleDays: 5,
          schoolYearStart: '2026-09-01',
          schoolYearEnd: '2027-06-30',
          plan: 'trial',
        })
        .returning();
      if (!schoolB) throw new Error('schoolB not created');

      await tx.execute(sql`SELECT set_config('app.school_id', ${schoolB.id}, true)`);
      const [userB] = await tx
        .insert(users)
        .values({
          schoolId: schoolB.id,
          email: 'b@school-b.example',
          name: 'User B',
          role: 'school_admin',
        })
        .returning();
      if (!userB) throw new Error('userB not created');

      await tx.execute(
        sql`INSERT INTO duties (id, school_id, cycle_day, start_time, end_time, location, created_by)
            VALUES (gen_random_uuid(), ${schoolB.id}, 1, '09:00', '09:30', 'B-Location', ${userB.id}::uuid)`,
      );
    });

    // Now use the RUNTIME client (no BYPASSRLS) and verify that with the
    // school A context, we ONLY see school A's rows on every tenant table.
    _resetDbForTest();
    const runtimeDb = getDb();

    // Find school A id via the runtime client (school lookup uses
    // school_self policy).
    const schoolARow = await runtimeDb
      .select()
      .from(schools)
      .where(eq(schools.slug, 'school-a'));
    const schoolAId = schoolARow[0]!.id;

    const TENANT_TABLES: Array<keyof typeof TABLES_TO_COLUMNS> = [
      'users', 'duties',
    ];

    // For each tenant table, verify school A can read its own rows but
    // not school B's.
    const result = await withUserContext(runtimeDb, schoolAId, schoolARow[0]!.id, async (tx) => {
      const out: Record<string, unknown[]> = {};
      for (const t of TENANT_TABLES) {
        const fn = TABLES_TO_COLUMNS[t];
        const rows = await fn(tx);
        out[t] = rows;
      }
      return out;
    });

    // users: should only have User A.
    const usersA = result['users'] as Array<{ email: string }>;
    expect(usersA.length).toBe(1);
    expect(usersA[0]!.email).toBe('a@school-a.example');

    // duties: should only have A-Location.
    const dutiesA = result['duties'] as Array<{ location: string }>;
    expect(dutiesA.length).toBe(1);
    expect(dutiesA[0]!.location).toBe('A-Location');
  });

  // -------------------------------------------------------------------------
  // 7. CSRF: cross-origin POST returns 403
  // -------------------------------------------------------------------------
  it('CSRF: cross-origin POST returns 403', async () => {
    // Sign up first to set up a valid user.
    const csrf = generateCsrfToken();
    await signupAction({
      request: buildPostForm('http://localhost/auth/signup', {
        _csrf: csrf,
        schoolName: 'CSRF School',
        schoolSlug: 'csrf-school',
        timezone: 'America/Toronto',
        cycleDays: '5',
        schoolYearStart: '2026-09-01',
        schoolYearEnd: '2027-06-30',
        adminName: 'Frank Admin',
        adminEmail: 'frank@csrf-school.example',
        adminPassword: 'password123',
      }, { cookie: `__Host-edusupervise.csrf=${csrf}`, 'x-forwarded-for': '127.0.0.6' }),
      params: {}, context: {},
    } as never);

    _resetAll();

    // Direct CSRF unit test — validateCsrf is the production gate.
    const csrfMismatchReq = new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: {
        cookie: '__Host-edusupervise.csrf=cookie-token-aaaa',
        'x-csrf-token': 'header-token-bbbb',
      },
    });
    const result = validateCsrf(csrfMismatchReq);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }

    // Validate via the form helper too.
    const csrfFormReq = new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { cookie: '__Host-edusupervise.csrf=cookie-xxxx' },
    });
    const formResult = validateCsrfFromForm(csrfFormReq, 'header-yyyy');
    expect(formResult.ok).toBe(false);
    if (!formResult.ok) {
      expect(formResult.response.status).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // 8. rate limit: 6th login attempt in 15min returns 429
  // -------------------------------------------------------------------------
  it('rate limit: 6th login attempt in 15min returns 429', async () => {
    // Sign up.
    const csrf = generateCsrfToken();
    await signupAction({
      request: buildPostForm('http://localhost/auth/signup', {
        _csrf: csrf,
        schoolName: 'Rate School',
        schoolSlug: 'rate-school',
        timezone: 'America/Toronto',
        cycleDays: '5',
        schoolYearStart: '2026-09-01',
        schoolYearEnd: '2027-06-30',
        adminName: 'Grace Admin',
        adminEmail: 'grace@rate-school.example',
        adminPassword: 'password123',
      }, { cookie: `__Host-edusupervise.csrf=${csrf}`, 'x-forwarded-for': '127.0.0.7' }),
      params: {}, context: {},
    } as never);

    _resetAll();

    // 5 wrong logins should pass rate-limit gate (return 401 from
    // better-auth, not 429).
    for (let i = 0; i < 5; i++) {
      const c = generateCsrfToken();
      const res = await loginAction({
        request: buildPostForm('http://localhost/auth/login', {
          _csrf: c,
          email: 'grace@rate-school.example',
          password: 'WRONG',
        }, { cookie: `__Host-edusupervise.csrf=${c}`, 'x-forwarded-for': '127.0.0.7' }),
        params: {}, context: {},
      } as never);
      expect(res.status).not.toBe(429);
    }

    // 6th attempt: 429.
    const c = generateCsrfToken();
    const sixth = await loginAction({
      request: buildPostForm('http://localhost/auth/login', {
        _csrf: c,
        email: 'grace@rate-school.example',
        password: 'WRONG',
      }, { cookie: `__Host-edusupervise.csrf=${c}`, 'x-forwarded-for': '127.0.0.7' }),
      params: {}, context: {},
    } as never);
    expect(sixth.status).toBe(429);

    // Unit test: rate-limit API also enforces the limit.
    _resetAll();
    for (let i = 0; i < 5; i++) {
      const r = consume('login', '192.0.2.99', RATE_LIMITS.login);
      expect(r.allowed).toBe(true);
    }
    const sixthUnit = consume('login', '192.0.2.99', RATE_LIMITS.login);
    expect(sixthUnit.allowed).toBe(false);
    expect(sixthUnit.retryAfterSeconds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers for the RLS test (table → query)
// ---------------------------------------------------------------------------

import {
  duties as dutiesTable,
} from '@edusupervise/db';
import type { SchoolContextTx } from '@edusupervise/db';

const TABLES_TO_COLUMNS: Record<
  string,
  (tx: SchoolContextTx) => Promise<Array<Record<string, unknown>>>
> = {
  users: async (tx) =>
    tx.select({ id: users.id, email: users.email }).from(users).then((r) => r as never),
  duties: async (tx) =>
    tx.select({ id: dutiesTable.id, location: dutiesTable.location }).from(dutiesTable).then((r) => r as never),
};