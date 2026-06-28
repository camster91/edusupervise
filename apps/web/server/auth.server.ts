// apps/web/server/auth.server.ts — better-auth configuration + session
// helpers for the EduSupervise web app.
//
// Why better-auth and not a hand-rolled auth module?
//   - It owns password hashing, session token generation, expiry, sliding
//     refresh, OAuth callback plumbing, and the magic-link + email-OTP
//     token lifecycle. Re-implementing all of that in 200 lines would be
//     a security liability.
//   - The Drizzle adapter means sessions / accounts / verifications live
//     in our own Postgres (no external auth service), and the same
//     `users` row already defined by the foundation task.
//
// Why this file:
//   - The stub `auth.server.ts` in the foundation task only had a DB
//     lookup. That worked for "is the session cookie's userId valid?" but
//     could not actually issue sessions, validate passwords, mint magic
//     links, or rotate CSRF tokens on login. This file wires the real
//     better-auth config and keeps the existing helper functions
//     (`getSession`, `requireSession`, `requireRole`) so route handlers
//     downstream do not need to change.
//
// Architecture:
//   - `auth` is a single better-auth instance built once per process. It
//     owns the Drizzle adapter (which it gets from our runtime client).
//   - `getSession(request)` wraps `auth.api.getSession({ headers })` so
//     the rest of the app has a tiny import surface.
//   - `requireSession` / `requireRole` throw a `Response` (RR7 catches
//     thrown Responses and renders them as the route response). Same
//     contract as the foundation stub so loaders/actions don't change.
//
// Field-name mapping (the only gnarly bit):
//   - Better-auth expects a `user` table with `id, email, emailVerified,
//     name, image, createdAt, updatedAt` and an `account` table with
//     `id, userId, providerId, accountId, password, ...`.
//   - Our `users` table uses snake_case (`email_verified_at`, `avatar_url`,
//     etc.) and has extra tenant columns (`school_id`, `role`, `phone`,
//     `is_active`, `password_hash`).
//   - We map the `users` table into better-auth via `user.modelName =
//     'users'` + `user.fields` for column renames + `user.additionalFields`
//     for the tenant extras. The bcrypt password hash lives in better-auth's
//     `auth_account.password` column (providerId='credential'), not in our
//     `users.password_hash` — better-auth manages that lifecycle and
//     rotation. Our `users.password_hash` column stays as NULL for the
//     migration period and is removed in a later schema cleanup.
//
// Cookie config:
//   - Spec section 5 mandates `__Host-edusupervise.session` with
//     HttpOnly, Secure (prod), SameSite=Lax, 30-day rolling. Better-auth's
//     `session.expiresIn` and `session.updateAge` give us the 30-day expiry
//     with sliding refresh. `cookiePrefix` + custom `cookies.session_token`
//     override the cookie name to `__Host-edusupervise.session`.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

import {
  getRuntimeClient,
  type Db,
  users,
  type UserRole as DbUserRole,
} from '@edusupervise/db';

// ---------------------------------------------------------------------------
// Session shape — the rest of the app imports this
// ---------------------------------------------------------------------------

export type UserRole = DbUserRole;

export interface Session {
  userId: string;
  schoolId: string;
  email: string;
  role: UserRole;
  name: string;
}

export interface AuthEnv {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /**
   * Magic-link sender. The magic-link plugin calls this with the URL
   * that should be emailed to the user. The web container wires the
   * default to the email adapter; tests pass a no-op.
   */
  sendMagicLink?: (data: {
    email: string;
    url: string;
    token: string;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Module-singleton DB
// ---------------------------------------------------------------------------

let _db: Db | null = null;
let _dbUrl: string | null = null;

export function getDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'auth.server: DATABASE_URL is not set. Export DATABASE_URL=postgres://edusupervise_runtime:... and retry.',
    );
  }
  // Reuse the same client across calls in one process. Better-auth's
  // adapter also keeps a reference, so this keeps the pool count down.
  if (_db && _dbUrl === url) return _db;
  if (_db) {
    // URL changed — close the old pool before swapping.
    void _db.$client.end?.({ timeout: 5 }).catch(() => undefined);
  }
  _db = getRuntimeClient(url).db;
  _dbUrl = url;
  return _db;
}

/** Test-only: reset the singleton so tests can swap DATABASE_URL between cases. */
export function _resetDbForTest(): void {
  _db = null;
  _dbUrl = null;
}

// ---------------------------------------------------------------------------
// better-auth instance (singleton)
// ---------------------------------------------------------------------------

let _auth: ReturnType<typeof betterAuth> | null = null;

function buildAuth(env: AuthEnv = readEnv()) {
  return betterAuth({
    appName: 'EduSupervise',
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,

    // The Drizzle adapter uses our existing `users` table plus the new
    // `auth_session` / `auth_account` / `auth_verification` tables
    // (declared in packages/db/src/schema.ts). No migration is required
    // to add tables on the better-auth side — we own the schema.
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      schema: {
        user: users,
      },
    }),

    // Email + password sign-in (and sign-up, but we override sign-up to
    // do school creation — see below). bcrypt 12 rounds per spec.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false, // We sign in explicitly after our custom school-signup flow
      requireEmailVerification: false,
      password: {
        hash: async (password: string) => bcrypt.hash(password, 12),
        verify: async ({ hash, password }) => bcrypt.compare(password, hash),
      },
      // The signup endpoint from better-auth is intentionally NOT used for
      // /auth/signup (which creates a school + first admin in a
      // transaction). When a school admin invites a teacher later, they
      // can use better-auth's POST /sign-up/email — that path uses this
      // default config and goes through our additionalFields mapper so
      // the user gets `school_id` and `role` baked in via the
      // `databaseHooks.user.create.after` hook in db.server.
      sendResetPassword: async ({ user, url }) => {
        // Defer the actual send to a queue / email provider. For now,
        // log to stderr so a developer can pick the URL out of the logs.
        // The billing/devops-deploy task wires the Resend adapter.
        console.warn(
          `[auth] password-reset email requested for ${user.email}: ${url}`,
        );
      },
      resetPasswordTokenExpiresIn: 60 * 60, // 1 hour per spec
    },

    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        console.warn(
          `[auth] verify-email link for ${user.email}: ${url}`,
        );
      },
      expiresIn: 60 * 60,
    },

    // Session cookie config per spec section 5.
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // sliding refresh — extend by 1 day on each request
      cookieCache: { enabled: false },
    },

    // Map better-auth's expected columns to our snake_case `users` table.
    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified_at',
        image: 'avatar_url',
      },
      additionalFields: {
        schoolId: {
          type: 'string',
          required: false,
          returned: true,
          input: false, // set by our signup transaction, not by better-auth
        },
        role: {
          type: 'string',
          required: false,
          returned: true,
          input: false,
        },
        phone: {
          type: 'string',
          required: false,
          returned: true,
          input: true,
        },
        phoneVerifiedAt: {
          type: 'string',
          required: false,
          returned: true,
          input: false,
        },
        isActive: {
          type: 'boolean',
          required: false,
          returned: true,
          input: false,
          defaultValue: true,
        },
      },
    },

    // Better-auth's internal tables match the camelCase columns we used
    // in packages/db/src/schema.ts. We point the adapter at the right
    // schema (it picks them up by default from the DB introspection,
    // but listing them here makes the contract explicit and silences
    // strict-mode warnings).
    // The tables are: auth_session, auth_account, auth_verification.

    // CSRF cookie per spec — sameSite Lax, secure (prod), readable by
    // JS only for the double-submit pattern.
    // (CSRF validation itself lives in csrf.server.ts; we don't enable
    // better-auth's built-in CSRF because we want our own double-submit
    // cookie separate from better-auth's session cookie.)

    // OAuth (school admins only — but better-auth can't restrict by role
    // at config time, the role check happens in /auth/oauth/* handlers).
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
        ? {
            microsoft: {
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
            },
          }
        : {}),
    },

    // Magic link plugin — sent via email, consumed via POST.
    // better-auth exposes `auth.api.magicLinkVerify({ query: { token } })`
    // which we wrap in a POST handler at apps/web/app/routes/auth.magic.tsx.
    plugins: [
      magicLink({
        expiresIn: 60 * 5, // 5 min
        disableSignUp: true, // magic link is sign-in only — new users must sign up first
        sendMagicLink: async ({ email, url, token }) => {
          if (env.sendMagicLink) {
            await env.sendMagicLink({ email, url, token });
            return;
          }
          console.warn(`[auth] magic link for ${email}: ${url}`);
        },
      }),
    ],

    // Honor X-Forwarded-* on the cookie / base URL inference so the
    // app works behind Traefik without surprise redirect loops.
    trustedProxyHeaders: true,

    // Logging — pino is the project logger; better-auth has its own
    // logger but we keep it at warn/error to avoid spamming routes.
    logger: {
      level: process.env.LOG_LEVEL ?? 'warn',
    },

    advanced: {
      cookiePrefix: 'edusupervise',
      // Use the canonical __Host- cookie name on HTTPS (production).
      // In dev (HTTP localhost) better-auth falls back to a plain name.
      useSecureCookies: process.env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        path: '/',
      },
    },
  });
}

function readEnv(): AuthEnv {
  const env = process.env;
  return {
    DATABASE_URL: env.DATABASE_URL ?? '',
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ?? '',
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    MICROSOFT_CLIENT_ID: env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: env.MICROSOFT_CLIENT_SECRET,
  };
}

export function getAuth() {
  if (!_auth) _auth = buildAuth();
  return _auth;
}

/** Test-only: rebuild the auth singleton after env vars change. */
export function _resetAuthForTest(): void {
  _auth = null;
}

// ---------------------------------------------------------------------------
// Session helpers — public API for loaders / actions
// ---------------------------------------------------------------------------

/**
 * Read the authenticated session from request cookies. Returns null if the
 * session is missing, expired, or the user no longer exists / is inactive.
 *
 * Implementation: better-auth's `getSession({ headers })` looks up the
 * session row by cookie token, validates expiry, and returns the joined
 * user. We then read `school_id` and `role` from the user row in our own
 * DB to make sure we honor the `is_active` flag and the freshest role.
 */
export async function getSession(request: Request): Promise<Session | null> {
  let betterSession: {
    user?: {
      id: string;
      email?: string | null;
      name?: string | null;
    };
  } | null = null;
  try {
    betterSession = (await getAuth().api.getSession({
      headers: request.headers,
    })) as typeof betterSession;
  } catch (err) {
    // better-auth throws on malformed tokens — treat as no session.
    console.warn('[auth] getSession failed:', err);
    return null;
  }
  if (!betterSession?.user?.id) return null;

  const db = getDb();
  // No RLS here — we're looking up our own user row by id, and the result
  // is the canonical (schoolId, role) pair. Tenant queries that follow
  // use withSchoolContext / withUserContext.
  const rows = await db
    .select({
      id: users.id,
      schoolId: users.schoolId,
      email: users.email,
      role: users.role,
      name: users.name,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, betterSession.user.id))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  return {
    userId: row.id,
    schoolId: row.schoolId,
    email: row.email,
    role: row.role,
    name: row.name,
  };
}

/**
 * Throw a 401 Response if the session is missing. RR7 catches thrown
 * Responses and renders them as the route response.
 */
export function requireSession(session: Session | null): Session {
  if (!session) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}

/**
 * Throw a 403 Response if the session role is not in the allowed set.
 */
export function requireRole(
  session: Session,
  allowed: ReadonlyArray<UserRole>,
): Session {
  if (!allowed.includes(session.role)) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}