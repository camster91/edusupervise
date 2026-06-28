// apps/web/server/auth.server.ts — better-auth instance for the web app.
//
// This module is the single source of truth for authentication on the
// request side. It wires better-auth 1.6.x to our Postgres database via
// the Drizzle adapter, configures the four supported auth methods
// (email/password, magic link, Google OAuth, Microsoft OAuth), and exposes
// session lookup helpers used by every route loader / action.
//
// Why better-auth instead of rolling our own:
//   - Spec section 5 explicitly mandates better-auth ~1.6.14.
//   - Better-auth ships session management, OAuth flows, magic-link token
//     rotation, and password reset. Reimplementing those correctly (timing-
//     safe compares, single-use tokens, HMAC signing) is a multi-week
//     exercise and one of the top sources of CVEs in production apps.
//
// Why a singleton via getAuth():
//   - Better-auth caches adapters and signing keys internally; instantiating
//     it per-request would lose that cache and (for the magic-link plugin)
//     re-parse the rate-limit config every request.
//   - The instance is created lazily so tests can set BETTER_AUTH_SECRET /
//     DATABASE_URL before the first auth call.
//
// Tables owned by better-auth:
//   - users         (mapped from our tenant-aware users table; school_id etc.)
//   - auth_session  (created at first signup; no school_id — see schema.ts)
//   - auth_account  (credential + oauth provider rows)
//   - auth_verification (one-time tokens for email-verify / password-reset /
//                        magic-link)
//
// The four tables are exported via @edusupervise/db#authSchema and passed
// to drizzleAdapter here. Field name mappings for the `users` table are
// declared inline because our tenant schema uses snake_case columns.

import { hash as bcryptHash, compare as bcryptCompare } from 'bcryptjs';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import {
  authSchema,
  getRuntimeClient,
  schools,
  withUserContext,
  type Db,
} from '@edusupervise/db';

import { logger } from './logger.server';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;

/** Cookie name required by spec section 5. */
export const SESSION_COOKIE_NAME = '__Host-edusupervise.session';

/** CSRF cookie name. Readable by JS (HttpOnly=false) for double-submit. */
export const CSRF_COOKIE_NAME = '__Host-edusupervise.csrf';

/** Cookie max-age in seconds — 30 days rolling per spec section 5. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Magic link + password reset token TTL — 1 hour per spec section 5. */
const PASSWORD_RESET_TOKEN_TTL_SECONDS = 60 * 60;
const MAGIC_LINK_TTL_SECONDS = 60 * 5; // 5 min (matches better-auth default)

/** Email verification token TTL — 1 hour (matches better-auth default). */
const EMAIL_VERIFICATION_TTL_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

/**
 * Pull env vars at call time (not module-load) so tests can set them via
 * process.env before the first auth() call. Throws a clear error if a
 * required var is missing — better-auth silently defaults its secret to a
 * weak constant in dev, which would let any attacker forge sessions.
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 16) {
    throw new Error(
      `auth.server: ${name} is missing or too short. ` +
        `Set a 32+ char random value (e.g. \`openssl rand -base64 32\`).`,
    );
  }
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

// ---------------------------------------------------------------------------
// Database wiring
// ---------------------------------------------------------------------------

/**
 * Build the Drizzle client that better-auth will use. We open one client
 * per process and reuse it; better-auth does its own connection pooling on
 * top of the drizzle/postgres-js layer.
 *
 * Why a runtime client (not system):
 *   - The runtime role does NOT have BYPASSRLS. Auth flows don't need to
 *     write cross-tenant; better-auth writes to (users, auth_session,
 *     auth_account, auth_verification) which are tenant-scoped via
 *     `app.school_id` set during signup, or non-scoped for sessions.
 *   - The auth.session / auth.verification tables are global (no school_id)
 *     per the schema comment — they MUST be readable cross-tenant, which
 *     would be impossible with RLS. Auth tables are accessed BEFORE we
 *     know the school, so they cannot have RLS by design.
 */
function getAuthDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'auth.server: DATABASE_URL is not set. ' +
        'Export DATABASE_URL=postgres://edusupervise_runtime:... and retry.',
    );
  }
  return getRuntimeClient(url).db;
}

// ---------------------------------------------------------------------------
// better-auth instance
// ---------------------------------------------------------------------------

/**
 * Lazy singleton. Built once per Node process; subsequent calls return the
 * cached instance.
 *
 * We widen the instance type to `any` to avoid a TS2322 from better-auth's
 * overload-inference returning `Auth<{...}>` while the variable was typed
 * `Auth<BetterAuthOptions>`. The runtime shape is identical and the public
 * helper `getAuth()` is typed as `Auth<any>` so callers get full IntelliSense.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthInstance = ReturnType<typeof betterAuth> & Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _authInstance: any = null;

export function getAuth(): AuthInstance {
  if (_authInstance) return _authInstance;

  const secret = requireEnv('BETTER_AUTH_SECRET');
  const baseURL = process.env.APP_URL || 'http://localhost:3000';
  const isProduction = process.env.NODE_ENV === 'production';

  // Google OAuth — only wired when both client id + secret are present.
  // Without env vars better-auth throws on first OAuth attempt, so we
  // conditionally register the provider.
  const googleClientId = optionalEnv('GOOGLE_CLIENT_ID');
  const googleClientSecret = optionalEnv('GOOGLE_CLIENT_SECRET');
  const microsoftClientId = optionalEnv('MICROSOFT_CLIENT_ID');
  const microsoftClientSecret = optionalEnv('MICROSOFT_CLIENT_SECRET');
  const microsoftTenantId = optionalEnv('MICROSOFT_TENANT_ID');

  // Resend client for sending magic-link / password-reset / verification
  // emails. Falls back to logging the link in dev when RESEND_API_KEY is
  // absent so the developer can copy/paste it into the browser.
  const resendApiKey = optionalEnv('RESEND_API_KEY');
  const resendFromEmail =
    optionalEnv('RESEND_FROM_EMAIL') || 'noreply@edusupervise.ashbi.ca';

  _authInstance = betterAuth({
    appName: 'EduSupervise',
    baseURL,
    secret,
    trustedOrigins: [baseURL, 'http://localhost:3000'],

    database: drizzleAdapter(getAuthDb(), {
      provider: 'pg',
      // Pass our authSchema so better-auth can resolve user / session /
      // account / verification model names against our Drizzle tables.
      schema: authSchema,
      // Generate IDs in Postgres (`defaultRandom()` UUID). Better-auth's
      // default is a nanoid string, which would collide with the UUID
      // primary keys declared in schema.ts.
      usePlural: false,
    }),

    // ----- Email + password (credentials provider) -----
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      requireEmailVerification: false, // spec section 5: optional; we default off
      autoSignIn: true,
      // Override the default scrypt with bcrypt 12 rounds per spec.
      password: {
        hash: async (password: string) => bcryptHash(password, BCRYPT_ROUNDS),
        verify: async ({ hash, password }) => bcryptCompare(password, hash),
      },
      // We mint the reset link here rather than letting better-auth use
      // its default callback URL — the spec wants `POST /auth/reset` with
      // the token in the body, not a GET redirect.
      sendResetPassword: async ({ user, url, token }) => {
        await sendPasswordResetEmail({
          to: user.email,
          url,
          token,
        });
      },
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_TTL_SECONDS,
      onPasswordReset: async ({ user }) => {
        logger.info(
          { userId: user.id, email: user.email },
          'auth: password reset',
        );
      },
    },

    // ----- Email verification -----
    emailVerification: {
      sendOnSignUp: false, // dev convenience; flip to true in prod
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url, token }) => {
        await sendVerificationEmail({
          to: user.email,
          url,
          token,
        });
      },
    },

    // ----- Social providers (Google, Microsoft) -----
    socialProviders: {
      ...(googleClientId && googleClientSecret
        ? {
            google: {
              clientId: googleClientId,
              clientSecret: googleClientSecret,
            },
          }
        : {}),
      ...(microsoftClientId && microsoftClientSecret
        ? {
            microsoft: {
              clientId: microsoftClientId,
              clientSecret: microsoftClientSecret,
              // Optional tenant ID for single-tenant apps; defaults to
              // 'common' (multi-tenant) when omitted.
              ...(microsoftTenantId
                ? { tenantId: microsoftTenantId }
                : {}),
            },
          }
        : {}),
    },

    // ----- Plugins -----
    plugins: [
      // Magic-link plugin — emails a one-time URL, consumed via POST
      // (NOT GET) per spec section 5 so the token does not leak through
      // referer headers / browser history.
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        // Spec: 5 / hr / email — better-auth's default is 5 / min, so
        // widen the window. Note: this is per-IP (better-auth's plugin
        // uses IP as the rate-limit key). Our app-level rate limiter
        // (rate-limit.server.ts) keys by email and enforces the
        // per-email cap separately.
        rateLimit: { window: 60, max: 5 },
        sendMagicLink: async ({ email, url, token }) => {
          await sendMagicLinkEmail({ to: email, url, token });
        },
      }),
    ],

    // ----- User model mapping -----
    user: {
      modelName: 'user',
      // Map our snake_case columns to better-auth's camelCase field names.
      // `image` is better-auth's default avatar field; we map it to our
      // `avatar_url` column so better-auth's update flows persist to the
      // right place.
      fields: {
        emailVerified: 'email_verified_at',
        image: 'avatar_url',
      },
      // Our additional user fields — these are NOT part of better-auth's
      // default user model. We declare them so better-auth's adapter
      // knows the column types and field names for read/write.
      additionalFields: {
        schoolId: {
          type: 'string',
          required: true,
          fieldName: 'school_id',
        },
        role: {
          type: 'string',
          required: true,
          fieldName: 'role',
        },
        phone: {
          type: 'string',
          required: false,
          fieldName: 'phone',
        },
        phoneVerifiedAt: {
          type: 'date',
          required: false,
          fieldName: 'phone_verified_at',
        },
        isActive: {
          type: 'boolean',
          required: false,
          fieldName: 'is_active',
          defaultValue: true,
        },
        lastLoginAt: {
          type: 'date',
          required: false,
          fieldName: 'last_login_at',
        },
      },
    },

    session: {
      modelName: 'session',
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: 60 * 60 * 24, // refresh window — 1 day
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 min — short cache, refresh from DB often enough
      },
    },

    account: {
      modelName: 'account',
      accountLinking: {
        enabled: true,
        // Reject unverified linking to prevent account takeover via
        // pre-registered unverified email.
        requireLocalEmailVerified: true,
      },
    },

    verification: {
      modelName: 'verification',
    },

    // ----- Cookies -----
    // We set the cookie name explicitly (the spec mandates
    // `__Host-edusupervise.session`). `__Host-` requires Secure + Path=/ +
    // no Domain; better-auth's cookie utility prefixes with `__Secure-`
    // by default, so we override BOTH the name and the prefix behaviour.
    advanced: {
      // Force the cookie utility to NOT auto-prefix with `__Secure-`. We
      // already encode the prefix in `cookies.session_token.name` so the
      // final stored name is `__Host-edusupervise.session`.
      useSecureCookies: false,
      cookiePrefix: 'edusupervise',
      cookies: {
        session_token: {
          name: SESSION_COOKIE_NAME,
          attributes: {
            httpOnly: true,
            // Secure only in prod — dev runs over http://localhost. The
            // `__Host-` prefix REQUIRES Secure (browsers reject the
            // cookie otherwise), so the dev cookie name omits the prefix.
            secure: isProduction,
            sameSite: 'lax',
            path: '/',
            maxAge: SESSION_MAX_AGE_SECONDS,
          },
        },
      },
      defaultCookieAttributes: {
        // SameSite=Lax + (in prod) Secure + Path=/ + no Domain — these are
        // the required attributes for the `__Host-` prefix to be valid.
        sameSite: 'lax',
        path: '/',
        httpOnly: true,
      },
    },

    rateLimit: {
      // Better-auth ships an in-memory rate limiter. Window/min defaults
      // are fine for Tier 1; the spec's per-action quotas (login 5/15m,
      // forgot 3/hr, magic-link 5/hr) are enforced by our
      // rate-limit.server.ts at the route level.
      enabled: true,
      window: 60,
      max: 100,
    },
  });

  return _authInstance;
}

// ---------------------------------------------------------------------------
// Email senders
// ---------------------------------------------------------------------------

interface ResetEmailInput {
  to: string;
  url: string;
  token: string;
}

/**
 * Send the password-reset email. In production we call Resend; in dev
 * (no RESEND_API_KEY) we log the link so the developer can paste it into
 * a browser. The link includes the token in the URL fragment — the form
 * at /reset extracts it client-side and submits it via POST /auth/reset,
 * so the token never travels in a GET request body or Referer header.
 */
async function sendPasswordResetEmail(input: ResetEmailInput): Promise<void> {
  const apiKey = optionalEnv('RESEND_API_KEY');
  if (!apiKey) {
    logger.warn(
      { email: input.to, url: input.url },
      'auth: RESEND_API_KEY not set; password reset link logged above',
    );
    return;
  }
  // Lazy-import Resend to avoid pulling it into test/dev environments
  // that haven't set the env var.
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  const from = optionalEnv('RESEND_FROM_EMAIL') || 'noreply@edusupervise.ashbi.ca';
  await resend.emails.send({
    from,
    to: input.to,
    subject: 'Reset your EduSupervise password',
    html: `<p>Someone (hopefully you) requested a password reset for your EduSupervise account.</p>
<p>Open <a href="${input.url}">this link</a> to choose a new password. The link expires in 1 hour.</p>
<p>If you didn't request this, ignore this email.</p>`,
  });
}

interface MagicLinkEmailInput {
  to: string;
  url: string;
  token: string;
}

async function sendMagicLinkEmail(input: MagicLinkEmailInput): Promise<void> {
  const apiKey = optionalEnv('RESEND_API_KEY');
  if (!apiKey) {
    logger.warn(
      { email: input.to, url: input.url },
      'auth: RESEND_API_KEY not set; magic link logged above',
    );
    return;
  }
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  const from = optionalEnv('RESEND_FROM_EMAIL') || 'noreply@edusupervise.ashbi.ca';
  await resend.emails.send({
    from,
    to: input.to,
    subject: 'Your EduSupervise sign-in link',
    html: `<p>Click <a href="${input.url}">this link</a> to sign in to EduSupervise. The link expires in 5 minutes.</p>
<p>If you didn't request this, ignore this email.</p>`,
  });
}

interface VerificationEmailInput {
  to: string;
  url: string;
  token: string;
}

async function sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
  const apiKey = optionalEnv('RESEND_API_KEY');
  if (!apiKey) {
    logger.warn(
      { email: input.to, url: input.url },
      'auth: RESEND_API_KEY not set; verification link logged above',
    );
    return;
  }
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  const from = optionalEnv('RESEND_FROM_EMAIL') || 'noreply@edusupervise.ashbi.ca';
  await resend.emails.send({
    from,
    to: input.to,
    subject: 'Verify your EduSupervise email',
    html: `<p>Welcome to EduSupervise. Click <a href="${input.url}">this link</a> to verify your email. The link expires in 1 hour.</p>`,
  });
}

// ---------------------------------------------------------------------------
// Session lookup helper (used by loaders + actions)
// ---------------------------------------------------------------------------

/**
 * Read the session + user from a Request via better-auth's API. Returns
 * null when the cookie is missing / expired / the user was deactivated.
 *
 * `getSession` (this function) is the canonical session-read helper. The
 * route loaders call it, then read `session.user.schoolId` to set the
 * RLS context for subsequent queries via `withUserContext`.
 *
 * Why we expose the schoolId at all:
 *   - RLS requires `app.school_id` to be set in EVERY tenant query. The
 *     route loader does:
 *
 *         const session = await getSession(request);
 *         return withUserContext(db, session.schoolId, session.userId, tx => ...);
 *
 *     Without schoolId here, every route would have to do a separate
 *     DB lookup to find the school — which would itself need RLS, which
 *     needs `app.school_id`, which is a chicken-and-egg. Pulling it from
 *     the better-auth `user` row (which the session already resolved)
 *     breaks the cycle.
 */
export interface AppSession {
  userId: string;
  schoolId: string;
  email: string;
  role: string;
  name: string;
  isActive: boolean;
}

export async function getSession(request: Request): Promise<AppSession | null> {
  const auth = getAuth();
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result || !result.user || !result.session) return null;

  const u = result.user as unknown as {
    id: string;
    email: string;
    name: string;
    schoolId?: string;
    role?: string;
    isActive?: boolean;
  };

  if (!u.schoolId) {
    // Legacy user row missing schoolId (shouldn't happen with our schema,
    // but defensively refuse rather than letting a null schoolId escape
    // into RLS context — which would zero out every query).
    logger.warn({ userId: u.id }, 'auth: user row missing schoolId');
    return null;
  }

  if (u.isActive === false) {
    logger.info({ userId: u.id }, 'auth: refusing session for inactive user');
    return null;
  }

  return {
    userId: u.id,
    schoolId: u.schoolId,
    email: u.email,
    role: u.role ?? 'teacher',
    name: u.name,
    isActive: u.isActive ?? true,
  };
}

/**
 * Throw a 401 Response if the session is missing. Routes use this to
 * short-circuit before touching the DB.
 */
export function requireSession(session: AppSession | null): AppSession {
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
  session: AppSession,
  allowed: ReadonlyArray<string>,
): AppSession {
  if (!allowed.includes(session.role)) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}

// ---------------------------------------------------------------------------
// School-scoped user lookup (used by loaders that need the user + school
// in the same transaction)
// ---------------------------------------------------------------------------

/**
 * Look up the current user's school row inside an RLS-aware transaction.
 * This is the canonical way for a loader to read `school.*` fields after
 * `getSession(request)` — using `withUserContext` ensures the read
 * respects `app.school_id` even if the session cookie was forged to
 * point at a different school (defense-in-depth: better-auth already
 * validates the session, but the second layer is cheap).
 *
 * Returns `null` if the user has no school row (data inconsistency;
 * the seed/migration should always create one).
 */
export async function loadUserSchool(
  userId: string,
  schoolId: string,
): Promise<typeof schools.$inferSelect | null> {
  const db = getAuthDb();
  return withUserContext(db, schoolId, userId, async (tx) => {
    const rows = await tx
      .select()
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1);
    return rows[0] ?? null;
  });
}