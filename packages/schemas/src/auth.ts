// packages/schemas/src/auth.ts — shared Zod schemas for every auth flow.
//
// The same schema validates the client form submission (via
// @hookform/resolvers/zod) and the server action input (via
// `schema.parse(formData)`), so the contract is enforced once.
//
// Conventions:
//   - One schema per flow (login / signup / forgot / reset / magic /
//     verify-email / verify-phone). Each is a single exported constant
//     so consumers can re-use them across both sides.
//   - `signupSchema` is the multi-step form: school + admin in one
//     transaction. The server-side action uses the SAME schema; no
//     client-only / server-only drift.
//   - Errors are user-facing strings. The action layer translates these
//     to plain English on the form via `react-hook-form`'s error
//     binding. They are NOT leakage of internal state — they read as
//     a form error to the user, not as a stack trace.
//   - All string fields are trimmed before length checks so a pasted
//     "  alice@example.com  " doesn't blow the email validator.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} is required`)
    .max(max, `${label} is too long`);

/** Lowercased + trimmed email; the canonical form we store in `users.email`. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(254, 'Email is too long')
  .email('Enter a valid email address');

/** Password rules — min 8 chars, no other complexity requirements per spec. */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

/** School slug — kebab-case, lowercase, 3..40 chars. Used in `schools.slug`. */
export const schoolSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/,
    'Slug must be lowercase letters, numbers, and dashes (3-40 chars, no leading/trailing dash)',
  );

/** E.164-ish phone — `+` then 7..15 digits. Used in `users.phone`. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164 format (e.g. +14165551234)');

/** IANA timezone string. Used in `schools.timezone`. */
export const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'Timezone is required')
  .max(64, 'Timezone is too long');

/** YYYY-MM-DD date string. */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  /** Optional `redirectTo` path — used by /login?next=... query params. */
  redirectTo: z.string().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Signup — creates a school + first admin in ONE transaction
// ---------------------------------------------------------------------------

export const signupSchema = z
  .object({
    schoolName: trimmed(1, 200, 'School name'),
    schoolSlug: schoolSlugSchema,
    timezone: timezoneSchema.default('America/Toronto'),
    cycleDays: z.coerce
      .number()
      .int()
      .min(1, 'Cycle days must be at least 1')
      .max(10, 'Cycle days must be 10 or fewer')
      .default(5),
    schoolYearStart: dateStringSchema,
    schoolYearEnd: dateStringSchema,
    adminName: trimmed(1, 200, 'Admin name'),
    adminEmail: emailSchema,
    adminPassword: passwordSchema,
    /** Honeypot — bots fill every input, humans don't see this field. */
    website: z.string().max(0).optional(),
  })
  .refine((data) => data.schoolYearEnd > data.schoolYearStart, {
    message: 'School year end must be after start',
    path: ['schoolYearEnd'],
  })
  .refine((data) => data.adminEmail !== data.adminName, {
    message: 'Email and name cannot match',
    path: ['adminEmail'],
  });
export type SignupInput = z.infer<typeof signupSchema>;

// ---------------------------------------------------------------------------
// Forgot password — request a reset link
// ---------------------------------------------------------------------------

export const forgotSchema = z.object({
  email: emailSchema,
  website: z.string().max(0).optional(), // honeypot
});
export type ForgotInput = z.infer<typeof forgotSchema>;

// ---------------------------------------------------------------------------
// Reset password — token + new password
// ---------------------------------------------------------------------------

export const resetSchema = z
  .object({
    token: z.string().min(1, 'Reset token is required'),
    newPassword: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ResetInput = z.infer<typeof resetSchema>;

// ---------------------------------------------------------------------------
// Magic link — consumed via POST per spec
// ---------------------------------------------------------------------------

export const magicConsumeSchema = z.object({
  token: z.string().min(1, 'Magic-link token is required'),
});
export type MagicConsumeInput = z.infer<typeof magicConsumeSchema>;

export const magicRequestSchema = z.object({
  email: emailSchema,
  website: z.string().max(0).optional(),
});
export type MagicRequestInput = z.infer<typeof magicRequestSchema>;

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

// ---------------------------------------------------------------------------
// Phone verification — request a code, then confirm
// ---------------------------------------------------------------------------

export const verifyPhoneRequestSchema = z.object({
  phone: phoneSchema,
});
export type VerifyPhoneRequestInput = z.infer<typeof verifyPhoneRequestSchema>;

export const verifyPhoneConfirmSchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'Code must be 4-8 digits'),
});
export type VerifyPhoneConfirmInput = z.infer<typeof verifyPhoneConfirmSchema>;

// ---------------------------------------------------------------------------
// CSRF form helper — the hidden `_csrf` input on every form
// ---------------------------------------------------------------------------

/**
 * Reusable schema for any form that has a CSRF hidden input alongside
 * its payload. The route handler validates `_csrf` against the cookie
 * via `validateCsrfFromForm` after parsing the FormData.
 */
export const csrfFieldSchema = z.object({
  _csrf: z.string().min(1, 'Missing CSRF token'),
});