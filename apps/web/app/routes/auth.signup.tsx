// apps/web/app/routes/auth.signup.tsx — POST /auth/signup.
//
// Creates a school + first admin in a SINGLE transaction, then signs the
// admin in via better-auth. Per spec section 5 + section 7.
//
// Why we don't use better-auth's built-in POST /sign-up/email:
//   - The spec requires the signup to create a SCHOOL (tenant) AND the
//     first admin user in a single transaction. better-auth's sign-up
//     creates only a user — adding the school afterwards would be a
//     separate query and could leave an orphan user if the school insert
//     failed (or vice-versa). So we run our own transaction, insert both
//     rows + the credential account + an audit row, then ask better-auth
//     to mint a session for the new admin.
//
// CSRF: validated via validateCsrfFromForm using the hidden `_csrf`
// form field.
//
// Honeypot: `website` field is hidden in the form. A bot fills every
// input; a human never sees it. If `website` is non-empty after
// validation we silently 200 (don't tip off the bot) but skip the
// transaction.

import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { redirect } from 'react-router';

import {
  schools,
  users,
  type School,
  type User,
} from '@edusupervise/db';
import { signupSchema } from '@edusupervise/schemas/auth';

import { getAuth } from '~/server/auth.server';
import {
  buildCsrfSetCookie,
  buildCsrfSetCookieSecure,
  generateCsrfToken,
  validateCsrfFromForm,
} from '~/server/csrf.server';
import { getDb } from '~/server/db.server';
import {
  buildRateLimitedResponse,
  consume,
} from '~/server/rate-limit.server';

import type { Route } from './+types/auth.signup';

export async function action({ request }: Route.ActionArgs) {
  // 1. CSRF validation.
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  // 2. Rate-limit by IP — 5 signups / hour / IP (matches login bucket;
  //    signup is rarer than login so this is conservative).
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const rl = consume('login', `signup:${ip}`, {
    max: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) return buildRateLimitedResponse(rl);

  // 3. Parse input.
  const raw = Object.fromEntries(formData);
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'invalid_input',
        issues: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  // 4. Honeypot — silently succeed so bots don't learn.
  if (parsed.data.website && parsed.data.website.length > 0) {
    return Response.json({ ok: true });
  }

  // 5. Fast-fail on duplicate slug (before opening a transaction).
  const db = getDb();
  const existing = await db
    .select({ id: schools.id })
    .from(schools)
    .where(eq(schools.slug, parsed.data.schoolSlug))
    .limit(1);
  if (existing.length > 0) {
    return Response.json(
      {
        error: 'invalid_input',
        issues: { schoolSlug: ['Slug is already taken'] },
      },
      { status: 400 },
    );
  }

  // 6. The transaction — creates the school, the admin user, the
  //    better-auth credential account, and an audit_log row. All four
  //    writes commit atomically; if any fails, the whole signup rolls
  //    back.
  let created: { school: School; user: User };
  try {
    const passwordHash = await bcrypt.hash(parsed.data.adminPassword, 12);

    created = await db.transaction(async (tx) => {
      const [school] = await tx
        .insert(schools)
        .values({
          slug: parsed.data.schoolSlug,
          name: parsed.data.schoolName,
          timezone: parsed.data.timezone,
          cycleDays: parsed.data.cycleDays,
          schoolYearStart: parsed.data.schoolYearStart,
          schoolYearEnd: parsed.data.schoolYearEnd,
          plan: 'trial',
          trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        .returning();
      if (!school) throw new Error('school insert returned no row');

      // The `users` table has WITH CHECK (school_id = current_school_id()),
      // so the INSERT needs `app.school_id` set in this transaction.
      await tx.execute(sql`SELECT set_config('app.school_id', ${school.id}, true)`);

      const [user] = await tx
        .insert(users)
        .values({
          schoolId: school.id,
          email: parsed.data.adminEmail,
          name: parsed.data.adminName,
          role: 'school_admin',
          isActive: true,
          // password_hash stays NULL — bcrypt hash lives in auth_account.password
        })
        .returning();
      if (!user) throw new Error('user insert returned no row');

      // The better-auth credential account, with the bcrypt hash.
      await tx.execute(
        sql`INSERT INTO auth_account (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${user.id}, ${user.id}, 'credential', ${passwordHash}, now(), now())`,
      );

      // Audit row — the admin signed themselves up.
      await tx.execute(
        sql`INSERT INTO audit_log (school_id, user_id, action, target_type, target_id, metadata, created_at)
            VALUES (${school.id}, ${user.id}, 'school.signup', 'school', ${school.id},
                    ${JSON.stringify({ slug: school.slug })}::jsonb, now())`,
      );

      return { school, user };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[auth.signup] transaction failed:', message);
    if (message.includes('users_school_id_email_unique')) {
      return Response.json(
        {
          error: 'invalid_input',
          issues: { adminEmail: ['Email already in use at this school'] },
        },
        { status: 400 },
      );
    }
    if (message.includes('schools_slug_unique')) {
      return Response.json(
        {
          error: 'invalid_input',
          issues: { schoolSlug: ['Slug is already taken'] },
        },
        { status: 400 },
      );
    }
    return Response.json(
      { error: 'signup_failed', detail: message },
      { status: 500 },
    );
  }

  // 7. Sign the admin in via better-auth — mint a session cookie.
  const signInResult = await getAuth().api.signInEmail({
    body: {
      email: parsed.data.adminEmail,
      password: parsed.data.adminPassword,
    },
    asResponse: true,
    headers: request.headers,
  });

  // 8. Build the post-signup response: redirect to /app, copy the
  //    session cookie from better-auth's response, rotate the CSRF
  //    cookie per spec.
  const newCsrf = generateCsrfToken();
  const headers = new Headers();
  headers.set('location', '/app');
  // Forward all Set-Cookie headers from better-auth (session + any
  // auxiliary cookies).
  const setCookies =
    signInResult.headers.getSetCookie?.() ??
    (signInResult.headers.get('set-cookie')
      ? [signInResult.headers.get('set-cookie')!]
      : []);
  for (const sc of setCookies) headers.append('set-cookie', sc);
  // Rotate CSRF cookie on login (spec section 5).
  headers.append('set-cookie', buildCsrfSetCookieSecure(newCsrf));
  // The non-prod variant is kept as a fallback in case Secure is
  // rejected by a test runner using http://. The `buildCsrfSetCookie`
  // export exists for that purpose — referenced here so it isn't
  // tree-shaken away in case a downstream consumer wires it.
  void buildCsrfSetCookie;

  return new Response(null, { status: 303, headers });
}

// Loader: redirect to /signup (the UI route handles rendering).
export async function loader({ request: _request }: Route.LoaderArgs) {
  return redirect('/signup');
}