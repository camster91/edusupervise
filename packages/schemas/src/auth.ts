// @edusupervise/schemas — auth domain.
//
// Single source of truth for auth-related validation. The same Zod schemas
// are used by:
//   - Client-side forms (via @hookform/resolvers/zod)
//   - Server-side route actions (via schema.parse on request body)
// so client + server cannot drift apart.
//
// Conventions:
//   - Email is always lowercased + trimmed before storage. We do that in the
//     schema's `.transform()` so callers can't forget.
//   - Passwords are NEVER returned from the API (no `.shape.password` on the
//     response side). They are accepted on input only.
//   - Phone numbers are accepted in international format (+14165551234).
//     We trim + require the leading `+`.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/**
 * RFC 5321-ish email — strict enough for production but not so strict that
 * uncommon-but-valid addresses (e.g. `+` aliases, hyphens) get rejected.
 * The schema also normalizes to lowercase + trimmed so the same address
 * signed up twice dedupes regardless of how the user typed it.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

/**
 * Password rules per spec section 5:
 *   - bcrypt 12 rounds on the server
 *   - min length 8 (better-auth default; we keep the same)
 *   - max length 128 (better-auth default)
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

/**
 * International-format phone number — leading `+`, 8-15 digits total.
 * Accepts spaces, dashes, and parentheses; we strip them in `.transform()`
 * so the canonical form is `+14165551234`.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s\-()]/g, ''))
  .pipe(
    z
      .string()
      .regex(
        /^\+[1-9]\d{7,14}$/,
        'Phone must be in international format (e.g. +14165551234)',
      ),
  );

/**
 * 6-digit SMS verification code. Numeric only, no leading zeros stripped.
 */
export const smsCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Code must be 6 digits');

// ---------------------------------------------------------------------------
// School signup — creates a new school + the first admin user.
// ---------------------------------------------------------------------------

/**
 * Pick a plan for self-signup. Tier 1 ships trial / free / pro / school;
 * signup accepts trial / pro / school only — free can only be reached via
 * downgrade from trial. Matches the spec's billing rules.
 */
export const signupPlanSchema = z.enum(['trial', 'pro', 'school']);
export type SignupPlan = z.infer<typeof signupPlanSchema>;

/**
 * School slug. Lowercase letters, digits, and dashes only. The slug becomes
 * part of the URL pattern (e.g. /schools/maple-elementary) so we keep it
 * conservative. Min length 3 to avoid trivial collisions, max 50.
 */
export const schoolSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Slug must be at least 3 characters')
  .max(50)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Slug may contain lowercase letters, digits, and dashes',
  );

export const schoolNameSchema = z
  .string()
  .trim()
  .min(2, 'School name is required')
  .max(200);

export const schoolTimezoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(50)
  // IANA timezone names look like "America/Toronto" — require a `/`.
  .regex(/^[A-Za-z_]+(\/[A-Za-z_+-]+)+$/, 'Must be an IANA timezone');

/**
 * Number of cycle days for the school (1..10). Spec section 4 schema check
 * enforces the same range at the DB layer.
 */
export const cycleDaysSchema = z.number().int().min(1).max(10);

/**
 * School year dates. The DB enforces `end > start` and
 * `end <= start + 14 months` (spec section 4). We mirror those in the
 * schema so the client gets a friendly error before hitting the action.
 */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const schoolYearSchema = z
  .object({
    schoolYearStart: dateOnlySchema,
    schoolYearEnd: dateOnlySchema,
  })
  .superRefine((v, ctx) => {
    if (v.schoolYearEnd <= v.schoolYearStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schoolYearEnd'],
        message: 'End must be after start',
      });
    }
    const start = new Date(v.schoolYearStart);
    const end = new Date(v.schoolYearEnd);
    const monthsDiff =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth());
    if (monthsDiff > 14) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schoolYearEnd'],
        message: 'School year cannot exceed 14 months',
      });
    }
  });

/**
 * Self-signup payload — `POST /auth/signup`.
 *
 * Returns the user-facing shape (no internal IDs, no password hash). The
 * server-side route action inserts the school + admin user in a single
 * transaction and returns this shape so the client can show success.
 */
export const signupSchema = z.object({
  school: z.object({
    name: schoolNameSchema,
    slug: schoolSlugSchema,
    timezone: schoolTimezoneSchema.default('America/Toronto'),
    cycleDays: cycleDaysSchema.default(5),
    schoolYearStart: dateOnlySchema,
    schoolYearEnd: dateOnlySchema,
    plan: signupPlanSchema.default('trial'),
  }),
  user: z.object({
    name: z.string().trim().min(2).max(200),
    email: emailSchema,
    password: passwordSchema,
  }),
});
export type SignupInput = z.infer<typeof signupSchema>;

// ---------------------------------------------------------------------------
// Login — email + password.
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Password reset — request + consume.
// ---------------------------------------------------------------------------

/**
 * `POST /auth/forgot` — request a reset link. We only take the email;
 * the server responds with 200 regardless of whether the email exists
 * (to avoid user enumeration).
 */
export const forgotPasswordSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/**
 * `POST /auth/reset` — consume the reset token + set a new password.
 * Per spec section 5 the token is sent in the BODY (not the URL) to avoid
 * leakage via the `Referer` header and browser history.
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// ---------------------------------------------------------------------------
// Magic link — request + consume.
// ---------------------------------------------------------------------------

export const magicLinkRequestSchema = z.object({
  email: emailSchema,
});
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestSchema>;

/**
 * `POST /auth/magic` — consume a magic-link token. Per spec section 5
 * the token is consumed via POST, not GET, so it does not leak through
 * referer headers or browser history.
 */
export const magicLinkConsumeSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});
export type MagicLinkConsumeInput = z.infer<typeof magicLinkConsumeSchema>;

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * `POST /auth/verify-email` — consume the verification token sent on signup.
 */
export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

// ---------------------------------------------------------------------------
// Phone verification (request + confirm)
// ---------------------------------------------------------------------------

export const phoneRequestSchema = z.object({
  phone: phoneSchema,
});
export type PhoneRequestInput = z.infer<typeof phoneRequestSchema>;

export const phoneConfirmSchema = z.object({
  phone: phoneSchema,
  code: smsCodeSchema,
});
export type PhoneConfirmInput = z.infer<typeof phoneConfirmSchema>;