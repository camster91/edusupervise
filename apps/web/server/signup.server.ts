// apps/web/server/signup.server.ts — Public self-serve signup (3 modes)
//
// Spec: docs/superpowers/specs/2026-06-29--public-signup-and-demo-mode.md
//
// The /signup page exposes three cards:
//   1. Join a school — admin shares the school's `join_code` (WORD-NN);
//      teacher types it at /signup, creates a password, joins as
//      `role='teacher'`.
//   2. I'm flying solo — teacher creates a brand-new school with
//      themselves as the only member, role='school_admin' (so they can
//      still manage their own duties).
//   3. Try the demo — pre-seeded 30-day sandbox school with sample data.
//      role='school_admin' so they can poke everything.
//
// All three modes funnel through `recordSignupAttempt` so the rate
// limiter + audit log apply uniformly.

import { eq, and, gte, sql, count } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import {
  schools,
  users,
  signupAttempts,
  getSystemClient,
  planLimits,
  type Db,
} from '@edusupervise/db';
import { hashPassword } from './auth.server';
import { logger } from './logger.server';
import { seedDemoData } from './demo-seed.server';
import { recordAudit, AUDIT, requestMetadata } from './audit.server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignupMode = 'join' | 'solo' | 'demo';

export type SignupOutcome =
  | 'success'
  | 'invalid_code'
  | 'duplicate_email'
  | 'quota_full'
  | 'rate_limited'
  | 'error';

export interface SignupResult {
  ok: boolean;
  /** Human-readable error message safe to surface to the user. */
  error?: string;
  /** Stable error code for analytics + logs. */
  code?: SignupOutcome;
  /** Newly created user id (only set when ok=true). */
  userId?: string;
  /** Newly created school id (only set when ok=true for solo/demo). */
  schoolId?: string;
  /**
   * The role assigned to the new user (only set when ok=true for solo).
   * The action handler uses this to pick the right onboarding wizard:
   *   teacher  -> /onboarding/solo
   *   ea       -> /onboarding/solo (same wizard, default reminder differs)
   *   admin    -> /onboarding/admin
   * Join and demo paths do not populate this (they use hard-coded defaults).
   */
  role?: SoloRole;
}

export interface BaseSignupInput {
  name: string;
  email: string;
  password: string;
}

export interface JoinSignupInput extends BaseSignupInput {
  mode: 'join';
  schoolCode: string;
}

/**
 * Allowed roles for the solo signup flow. The signup form MUST
 * pass one of these values; the server falls back to
 * 'school_admin' when the field is missing (backward compatibility
 * with pre-Phase-1 POST callers that do not include `role`).
 *
 * Phase 1 (solo teacher onboarding): all three roles are accepted
 * over the same form. Phase 2+ may restrict EA self-signup if
 * governance starts to outweigh the friction.
 */
export const SOLO_ALLOWED_ROLES = [
  'teacher',
  'educational_assistant',
  'school_admin',
] as const;
export type SoloRole = (typeof SOLO_ALLOWED_ROLES)[number];

/**
 * Validate + coerce a form-supplied role string into SoloRole.
 * Returns null on bad input; callers must default or reject.
 */
export function parseSoloRole(input: unknown): SoloRole | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  return (SOLO_ALLOWED_ROLES as readonly string[]).includes(v)
    ? (v as SoloRole)
    : null;
}

export interface SoloSignupInput extends BaseSignupInput {
  mode: 'solo';
  schoolName: string;
  /** Optional. Defaults to 'school_admin' for backward compatibility. */
  role?: SoloRole;
}

export interface DemoSignupInput extends BaseSignupInput {
  mode: 'demo';
}

export type SignupInput = JoinSignupInput | SoloSignupInput | DemoSignupInput;

// ---------------------------------------------------------------------------
// Public API — three signup actions
// ---------------------------------------------------------------------------

/**
 * Join an existing school by `join_code`. Creates a new `users` row
 * with `role='teacher'` attached to that school.
 *
 * Failures:
 *   - rate_limited  → 429
 *   - invalid_code  → 400
 *   - duplicate_email → 409 (email already in this school)
 *   - quota_full    → 409 (school is at `plan_limits.max_teachers`)
 */
export async function signupJoin(
  input: JoinSignupInput,
  ctx: SignupContext,
): Promise<SignupResult> {
  const v = validateBase(input);
  if (!v.ok) return { ok: false, error: v.error, code: 'error' };

  const rate = await checkRateLimit(input.email, ctx.ipAddress);
  if (!rate.ok) {
    await logAttempt(input.email, ctx, 'join', 'rate_limited');
    return { ok: false, error: 'Too many attempts. Try again in 1 hour.', code: 'rate_limited' };
  }

  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    return { ok: false, error: "Server is misconfigured. Try again later.", code: 'error' };
  }
  const { db, close } = getSystemClient(systemUrl);
  try {
    const code = normalizeJoinCode(input.schoolCode);

    // Bootstrap lookup — runtime role's RLS policy on `schools` requires
    // `app.school_id` set, but we don't know which school until we
    // resolve the code. System role bypasses RLS.
    const [school] = await db
      .select({
        id: schools.id,
        plan: schools.plan,
        joinCode: schools.joinCode,
      })
      .from(schools)
      .where(eq(schools.joinCode, code))
      .limit(1);

    if (!school) {
      await logAttempt(input.email, ctx, 'join', 'invalid_code');
      return {
        ok: false,
        error: 'School code not recognized. Double-check with your school.',
        code: 'invalid_code',
      };
    }

    // Quota check
    const quota = await getTeacherQuota(db, school.plan);
    if (quota !== null) {
      const countRows = await db
        .select({ teacherCount: count() })
        .from(users)
        .where(and(eq(users.schoolId, school.id), eq(users.isActive, true)));
      const teacherCount = countRows[0]?.teacherCount ?? 0;
      if (teacherCount >= quota) {
        await logAttempt(input.email, ctx, 'join', 'quota_full', school.id);
        return {
          ok: false,
          error: 'School is at capacity. Ask your admin to upgrade or remove a teacher.',
          code: 'quota_full',
        };
      }
    }

    const passwordHash = await hashPassword(input.password);

    try {
      const [user] = await db
        .insert(users)
        .values({
          schoolId: school.id,
          email: input.email.toLowerCase(),
          passwordHash,
          name: input.name,
          role: 'teacher',
          emailVerifiedAt: sql`${new Date().toISOString()}::timestamptz`,
          isActive: true,
        })
        .returning({ id: users.id });

      if (!user) {
        return { ok: false, error: 'Signup failed' };
      }
      await logAttempt(input.email, ctx, 'join', 'success', school.id, user.id);
      logger.info({ userId: user.id, schoolId: school.id, mode: 'join' }, 'signup: success');
      // Audit row — non-fatal if it fails (see audit.server.ts).
      await recordAudit({
        schoolId: school.id,
        userId: user.id,
        action: AUDIT.USER_SIGNUP_JOIN,
        targetType: 'user',
        targetId: user.id,
        metadata: { email: input.email.toLowerCase(), mode: 'join' },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return { ok: true, userId: user.id, schoolId: school.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        await logAttempt(input.email, ctx, 'join', 'duplicate_email', school.id);
        return {
          ok: false,
          error: 'An account with this email already exists in this school. Sign in instead.',
          code: 'duplicate_email',
        };
      }
      throw err;
    }
  } catch (err) {
    logger.error({ err, mode: 'join' }, 'signup: failed');
    await logAttempt(input.email, ctx, 'join', 'error');
    return { ok: false, error: "Signup failed. Please try again.", code: 'error' };
  } finally {
    await close();
  }
}

/**
 * Create a new school + the user as the only `school_admin`. No
 * quota check needed — fresh school, no existing users.
 */
export async function signupSolo(
  input: SoloSignupInput,
  ctx: SignupContext,
): Promise<SignupResult> {
  const v = validateBase(input);
  if (!v.ok) return { ok: false, error: v.error, code: 'error' };
  const schoolName = input.schoolName.trim();
  if (schoolName.length < 2 || schoolName.length > 80) {
    return { ok: false, error: 'School name must be 2–80 characters.', code: 'error' };
  }
  // Default to school_admin when the caller did not pass a role
  // (backward compatibility with the pre-Phase-1 solo POST shape).
  // parseSoloRole validates; an invalid string falls back to school_admin
  // rather than 400'ing the form — solo signups should never lose a user
  // over an unknown role (they'd just hit admin wizard). To strict-reject,
  // change to `const role = parseSoloRole(input.role); if (!role) return 400`.
  const role: SoloRole = input.role ?? 'school_admin';

  const rate = await checkRateLimit(input.email, ctx.ipAddress);
  if (!rate.ok) {
    await logAttempt(input.email, ctx, 'solo', 'rate_limited');
    return { ok: false, error: 'Too many attempts. Try again in 1 hour.', code: 'rate_limited' };
  }

  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    return { ok: false, error: 'Server is misconfigured. Try again later.', code: 'error' };
  }
  const { db, close } = getSystemClient(systemUrl);
  try {
    const passwordHash = await hashPassword(input.password);
    const { joinCode, slug } = await generateSchoolCode(db, schoolName);

    const schoolYearStart = newSchoolYearStart();
    const schoolYearEnd = addDaysUtc(schoolYearStart, 305);
    const trialEndsAt = new Date(Date.now() + 30 * 86_400_000);

    try {
      const result = await db.transaction(async (tx) => {
        const [school] = await tx
          .insert(schools)
          .values({
            slug,
            name: schoolName,
            schoolYearStart: sql`${schoolYearStart.toISOString().slice(0, 10)}::date`,
            schoolYearEnd: sql`${schoolYearEnd.toISOString().slice(0, 10)}::date`,
            plan: 'free',
            trialEndsAt: sql`${trialEndsAt.toISOString()}::timestamptz`,
            joinCode,
          })
          .returning({ id: schools.id });
        if (!school) throw new Error('school_insert_failed');

        const [user] = await tx
          .insert(users)
          .values({
            schoolId: school.id,
            email: input.email.toLowerCase(),
            passwordHash,
            name: input.name,
            role,
            emailVerifiedAt: sql`${new Date().toISOString()}::timestamptz`,
            isActive: true,
          })
          .returning({ id: users.id });
        if (!user) throw new Error('user_insert_failed');

        return { school, user, role };
      });

      await logAttempt(input.email, ctx, 'solo', 'success', result.school.id, result.user.id);
      logger.info(
        { userId: result.user.id, schoolId: result.school.id, mode: 'solo' },
        'signup: success',
      );
      await recordAudit({
        schoolId: result.school.id,
        userId: result.user.id,
        action: AUDIT.USER_SIGNUP_SOLO,
        targetType: 'school',
        targetId: result.school.id,
        metadata: {
          email: input.email.toLowerCase(),
          schoolName,
          role,
          mode: 'solo',
        },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return {
        ok: true,
        userId: result.user.id,
        schoolId: result.school.id,
        role: result.role,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        await logAttempt(input.email, ctx, 'solo', 'duplicate_email');
        return {
          ok: false,
          error: 'An account with this email already exists. Sign in instead.',
          code: 'duplicate_email',
        };
      }
      throw err;
    }
  } catch (err) {
    logger.error({ err, mode: 'solo' }, 'signup: failed');
    await logAttempt(input.email, ctx, 'solo', 'error');
    return { ok: false, error: 'Signup failed. Please try again.', code: 'error' };
  } finally {
    await close();
  }
}

/**
 * Create a pre-seeded 30-day demo school. Used by the "Try the demo"
 * card on /signup.
 *
 * The seed runs inside the same `getSystemClient` block (system role
 * BYPASSRLS) so the seed inserts go through without RLS chokes. After
 * signup the demo school behaves like any other school — runtime reads
 * must wrap in withSchoolContext like everywhere else.
 */
export async function signupDemo(
  input: DemoSignupInput,
  ctx: SignupContext,
): Promise<SignupResult> {
  const v = validateBase(input);
  if (!v.ok) return { ok: false, error: v.error, code: 'error' };

  const rate = await checkRateLimit(input.email, ctx.ipAddress);
  if (!rate.ok) {
    await logAttempt(input.email, ctx, 'demo', 'rate_limited');
    return { ok: false, error: 'Too many attempts. Try again in 1 hour.', code: 'rate_limited' };
  }

  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    return { ok: false, error: 'Server is misconfigured. Try again later.', code: 'error' };
  }
  const { db, close } = getSystemClient(systemUrl);
  try {
    const passwordHash = await hashPassword(input.password);
    const { joinCode, slug } = await generateSchoolCode(db, 'Sunrise Elementary', { forceWord: 'SUNRISE' });

    const schoolYearStart = newSchoolYearStart();
    const schoolYearEnd = addDaysUtc(schoolYearStart, 305);
    const demoExpiresAt = new Date(Date.now() + 30 * 86_400_000);

    const result = await db.transaction(async (tx) => {
      const [school] = await tx
        .insert(schools)
        .values({
          slug,
          name: 'Sunrise Elementary',
          schoolYearStart: sql`${schoolYearStart.toISOString().slice(0, 10)}::date`,
          schoolYearEnd: sql`${schoolYearEnd.toISOString().slice(0, 10)}::date`,
          plan: 'demo',
          trialEndsAt: null,
          joinCode,
          demoExpiresAt: sql`${demoExpiresAt.toISOString()}::timestamptz`,
          demoSeedVariant: 'elementary',
        })
        .returning({ id: schools.id });
      if (!school) throw new Error('school_insert_failed');

      const [user] = await tx
        .insert(users)
        .values({
          schoolId: school.id,
          email: input.email.toLowerCase(),
          passwordHash,
          name: input.name,
          role: 'school_admin',
          emailVerifiedAt: sql`${new Date().toISOString()}::timestamptz`,
          isActive: true,
        })
        .returning({ id: users.id });
      if (!user) throw new Error('user_insert_failed');

      // Seed the demo data within the same transaction so a seed
      // failure rolls back the school + user.
      await seedDemoData(tx, school.id, 'elementary', user.id);

      return { school, user };
    });

    await logAttempt(input.email, ctx, 'demo', 'success', result.school.id, result.user.id);
    logger.info(
      { userId: result.user.id, schoolId: result.school.id, mode: 'demo' },
      'signup: success',
    );
    await recordAudit({
      schoolId: result.school.id,
      userId: result.user.id,
      action: AUDIT.USER_SIGNUP_DEMO,
      targetType: 'school',
      targetId: result.school.id,
      metadata: { email: input.email.toLowerCase(), mode: 'demo' },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return { ok: true, userId: result.user.id, schoolId: result.school.id };
  } catch (err) {
    logger.error({ err, mode: 'demo' }, 'signup: failed');
    await logAttempt(input.email, ctx, 'demo', 'error');
    return { ok: false, error: 'Demo setup failed. Please try again.', code: 'error' };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// School code generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique `WORD-NN` join code. If `forceWord` is provided it
 * is used as-is; otherwise the first word of `schoolName` is used. On
 * UNIQUE collision, retries by varying the numeric suffix; after 100
 * attempts fall back to 3 digits (NNN).
 *
 * Also returns a URL-safe slug derived from the school name for the
 * `schools.slug` column.
 */
export async function generateSchoolCode(
  db: Db,
  schoolName: string,
  options: { forceWord?: string } = {},
): Promise<{ joinCode: string; slug: string }> {
  const word = (options.forceWord ?? deriveWord(schoolName)).toUpperCase();
  const baseSlug = deriveSlug(schoolName);

  // 2-digit retries
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = String(randomInt(0, 100)).padStart(2, '0');
    const code = `${word}-${suffix}`;
    if (await isCodeAvailable(db, code, null)) {
      // Pick a slug that's also unique
      const slug = await ensureUniqueSlug(db, baseSlug);
      return { joinCode: code, slug };
    }
  }

  // 3-digit fallback
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = String(randomInt(0, 1000)).padStart(3, '0');
    const code = `${word}-${suffix}`;
    if (await isCodeAvailable(db, code, null)) {
      const slug = await ensureUniqueSlug(db, baseSlug);
      return { joinCode: code, slug };
    }
  }

  throw new Error('SCHOOL_CODE_EXHAUSTED');
}

/**
 * Check if a join code is available. `excludeSchoolId` lets an admin
 * keep their current code when renaming.
 */
export async function isCodeAvailable(
  db: Db,
  code: string,
  excludeSchoolId: string | null,
): Promise<boolean> {
  const where = excludeSchoolId
    ? and(eq(schools.joinCode, code), sql`${schools.id} != ${excludeSchoolId}`)
    : eq(schools.joinCode, code);
  const [row] = await db
    .select({ id: schools.id })
    .from(schools)
    .where(where)
    .limit(1);
  return !row;
}

const FALLBACK_WORDS = [
  'AURORA', 'CEDAR', 'DELTA', 'EMBER', 'FOREST',
  'GLACIER', 'HARBOR', 'IRON', 'JADE', 'KESTREL',
  'LUNA', 'MAPLE', 'NOVA', 'OAK', 'PINE',
  'QUARTZ', 'RIDGE', 'SUMMIT', 'TIDE', 'UMBRA',
  'VALE', 'WAVE', 'YEW', 'ZENITH',
];

function deriveWord(schoolName: string): string {
  const cleaned = schoolName
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 8);
  if (cleaned && cleaned.length >= 2) return cleaned;
  // Empty / non-alpha name → pick a fallback
  const idx = randomInt(0, FALLBACK_WORDS.length);
  return FALLBACK_WORDS[idx]!;
}

function deriveSlug(schoolName: string): string {
  const base = schoolName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (base.length >= 2) return base;
  return 'school';
}

async function ensureUniqueSlug(db: Db, base: string): Promise<string> {
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    const [existing] = await db
      .select({ id: schools.id })
      .from(schools)
      .where(eq(schools.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  // Last resort: append 6-char random
  const suffix = randomInt(0, 1_000_000).toString(36).padStart(6, '0');
  return `${base}-${suffix}`;
}

/**
 * Normalize user-typed join code to the canonical form: UPPERCASE,
 * single hyphen between word and digits. Returns null if the shape is
 * invalid (we let the caller decide the user-facing error).
 */
export function normalizeJoinCode(input: string): string {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  // Strip leading "JOIN-" if present
  const withoutPrefix = cleaned.replace(/^JOIN-/, '');
  // Reformat: if no hyphen, insert one between letters and digits
  const m = /^([A-Z][A-Z0-9]{0,7})-?(\d{2,3})$/.exec(withoutPrefix);
  if (!m) return withoutPrefix;
  return `${m[1]}-${m[2]}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBase(input: BaseSignupInput): { ok: true } | { ok: false; error: string } {
  const name = input.name?.trim() ?? '';
  const email = input.email?.trim().toLowerCase() ?? '';
  const password = input.password ?? '';

  if (name.length < 1 || name.length > 80) {
    return { ok: false, error: 'Name must be 1–80 characters.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  if (password.length > 128) {
    return { ok: false, error: 'Password must be 128 characters or fewer.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface SignupContext {
  ipAddress: string | null;
  userAgent: string | null;
}

const EMAIL_WINDOW_MS = 60 * 60 * 1000;       // 1 hour
const IP_WINDOW_MS = 60 * 60 * 1000;          // 1 hour
const EMAIL_MAX = 5;
const IP_MAX = 20;

/**
 * Sliding-window rate limit. Returns `ok=false` if the email has hit
 * EMAIL_MAX or the IP has hit IP_MAX within the last hour.
 *
 * Counts ALL attempts (success + failure) — a successful signup also
 * blocks 4 more attempts for the same email within the hour. This
 * makes it harder to brute-force the join_code path.
 */
export async function checkRateLimit(
  email: string,
  ipAddress: string | null,
): Promise<{ ok: true } | { ok: false; reason: 'email' | 'ip' }> {
  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) return { ok: true }; // Fail-open if misconfigured
  const { db, close } = getSystemClient(systemUrl);
  try {
    const emailCutoff = new Date(Date.now() - EMAIL_WINDOW_MS);
    const ipCutoff = new Date(Date.now() - IP_WINDOW_MS);

    const [emailCount] = await db
      .select({ n: count() })
      .from(signupAttempts)
      .where(and(
        eq(signupAttempts.email, email.toLowerCase()),
        gte(signupAttempts.createdAt, emailCutoff),
      ));
    if ((emailCount?.n ?? 0) >= EMAIL_MAX) return { ok: false, reason: 'email' };

    if (ipAddress) {
      const [ipCount] = await db
        .select({ n: count() })
        .from(signupAttempts)
        .where(and(
          eq(signupAttempts.ipAddress, ipAddress),
          gte(signupAttempts.createdAt, ipCutoff),
        ));
      if ((ipCount?.n ?? 0) >= IP_MAX) return { ok: false, reason: 'ip' };
    }

    return { ok: true };
  } finally {
    await close();
  }
}

async function logAttempt(
  email: string,
  ctx: SignupContext,
  mode: SignupMode,
  outcome: SignupOutcome,
  schoolId?: string,
  _userId?: string,
): Promise<void> {
  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) return;
  const { db, close } = getSystemClient(systemUrl);
  try {
    await db.insert(signupAttempts).values({
      email: email.toLowerCase(),
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      mode,
      outcome,
      schoolId: schoolId ?? null,
    });
  } catch (err) {
    logger.warn({ err, mode, outcome }, 'signup: failed to log attempt');
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Plan quota
// ---------------------------------------------------------------------------

/**
 * Look up `plan_limits.max_teachers` for the given plan. Returns null
 * if no limit is defined (e.g. enterprise / unlisted plans → no cap).
 */
async function getTeacherQuota(db: Db, plan: string): Promise<number | null> {
  const [row] = await db
    .select({ maxTeachers: planLimits.maxTeachers })
    .from(planLimits)
    .where(eq(planLimits.plan, plan))
    .limit(1);
  return row?.maxTeachers ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newSchoolYearStart(): Date {
  const now = new Date();
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const sep1 = new Date(Date.UTC(year, 8, 1));
  const dow = sep1.getUTCDay();
  const offset = dow === 1 ? 0 : (8 - dow) % 7;
  return new Date(sep1.getTime() + offset * 86_400_000);
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

// ---------------------------------------------------------------------------
// Demo reset (admin re-seeds their demo school)
// ---------------------------------------------------------------------------

/**
 * Wipe all tenant data for a demo school and re-seed it. Extends
 * `demo_expires_at` to now + 30 days.
 */
export async function resetDemoSchool(args: {
  schoolId: string;
  userId: string;
}): Promise<void> {
  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) throw new Error('SYSTEM_DATABASE_URL not set');
  const { db, close } = getSystemClient(systemUrl);

  try {
    await db.transaction(async (tx) => {
      // Verify it's a demo school
      const [school] = await tx
        .select({ id: schools.id, plan: schools.plan, demoSeedVariant: schools.demoSeedVariant })
        .from(schools)
        .where(eq(schools.id, args.schoolId))
        .limit(1);
      if (!school) throw new Error('school_not_found');
      if (school.plan !== 'demo' && school.plan !== 'demo_expired') {
        throw new Error('not_a_demo_school');
      }

      // Wipe tenant tables for this school only. System role BYPASSRLS
      // is required because we're inside one tx (RLS would require
      // `app.school_id` set; setting it is fine but wipe-by-id is more
      // explicit). Order matters: leaf tables first.
      const tenantTables = [
        'parent_alerts',
        'parent_route_tags',
        'parent_contacts',
        'coverage_assignments',
        'coverage_events',
        'reminder_log',
        'reminders',
        'duty_assignments',
        'duties',
        'cycle_calendar',
        'notifications',
        'audit_log',
      ];
      for (const table of tenantTables) {
        await tx.execute(
          sql`DELETE FROM ${sql.raw(table)} WHERE school_id = ${args.schoolId}`,
        );
      }

      // Re-seed (use the original admin user; idempotent since the user
      // row is left untouched by the wipe loop above).
      const variant = (school.demoSeedVariant ?? 'elementary') as 'elementary';
      await seedDemoData(tx, args.schoolId, variant, args.userId);

      // Extend demo expiry
      const newDemoExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await tx
        .update(schools)
        .set({
          plan: 'demo',
          demoExpiresAt: sql`${newDemoExpiresAt}::timestamptz`,
          updatedAt: sql`${new Date().toISOString()}::timestamptz`,
        })
        .where(eq(schools.id, args.schoolId));
    });

    logger.info(
      { schoolId: args.schoolId, userId: args.userId },
      'demo: reset completed',
    );

    // Audit row — destructive operation, important forensics trail.
    // ipAddress/userAgent come from the request that invoked the
    // reset (passed via the action handler). The system role's
    // audit_log doesn't enforce RLS, so we can write via the
    // same client we're already using.
    await recordAudit({
      schoolId: args.schoolId,
      userId: args.userId,
      action: AUDIT.DEMO_RESET,
      targetType: 'school',
      targetId: args.schoolId,
      metadata: {
        variant: 'elementary',
        previousDemoExpiresAt: new Date(Date.now()).toISOString(),
        newDemoExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    });
  } finally {
    await close();
  }
}