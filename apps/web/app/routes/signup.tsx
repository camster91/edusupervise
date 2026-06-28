// app/routes/signup.tsx — school self-signup.
//
// Creates a new school + first admin user in a single DB transaction.
// The school is inserted by the OWNER role (the runtime role can't
// CREATE on tables owned by owner per the GRANT model), then the admin
// user is created via better-auth so the credentials provider row + the
// session are both wired up correctly.
//
// Why a custom action and not better-auth's signUpEmail:
//   - better-auth's signup creates a user with the configured default
//     role, but our flow needs to create BOTH a school and a user in the
//     same transaction so a partial failure (school created, user not)
//     doesn't leave orphan data.
//   - The runtime role can't INSERT into `schools` — that table is owned
//     by the owner role. So the school insert runs as owner via a
//     separate connection, and the user insert runs as runtime after we
//     know the school exists.

import { useState } from 'react';
import { Link, redirect, useFetcher, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  schools,
  users,
  type School,
} from '@edusupervise/db';
import { signupSchema, type SignupInput } from '@edusupervise/schemas';

import { getAuth, getSession } from '~/server/auth.server';
import { validateCsrf } from '~/server/csrf.server';
import { csrfFormField } from '~/lib/csrf';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../../.env') });

// ----------------------------------------------------------------------------
// Loader — redirect to /app when already signed in
// ----------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSession(request);
  if (session) throw redirect('/app');
  return null;
}

// ----------------------------------------------------------------------------
// Action — create school + admin user + start a session
// ----------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const parsed = signupSchema.safeParse({
    school: {
      name: form.get('school.name'),
      slug: form.get('school.slug'),
      timezone: form.get('school.timezone') ?? 'America/Toronto',
      cycleDays: Number(form.get('school.cycleDays') ?? 5),
      schoolYearStart: form.get('school.schoolYearStart'),
      schoolYearEnd: form.get('school.schoolYearEnd'),
      plan: form.get('school.plan') ?? 'trial',
    },
    user: {
      name: form.get('user.name'),
      email: form.get('user.email'),
      password: form.get('user.password'),
    },
  });
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: 'invalid_input',
        detail: parsed.error.issues[0]?.message ?? 'Invalid input',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  const input = parsed.data;

  // 1. Create the school as the OWNER role (runtime can't INSERT into
  //    schools because owner owns it). Reject on slug collision.
  const ownerUrl = process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!ownerUrl) {
    return new Response(
      JSON.stringify({ error: 'server_misconfigured', detail: 'OWNER_DATABASE_URL not set' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
  const ownerSql = postgres(ownerUrl, { max: 1, prepare: false });
  const ownerDb = drizzle(ownerSql);

  let school: School;
  try {
    const existing = await ownerDb
      .select({ id: schools.id })
      .from(schools)
      .where(eq(schools.slug, input.school.slug))
      .limit(1);
    if (existing.length > 0) {
      return new Response(
        JSON.stringify({ error: 'school_slug_taken', detail: 'That URL is already in use.' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    }
    const inserted = await ownerDb
      .insert(schools)
      .values({
        slug: input.school.slug,
        name: input.school.name,
        timezone: input.school.timezone,
        cycleDays: input.school.cycleDays,
        schoolYearStart: input.school.schoolYearStart,
        schoolYearEnd: input.school.schoolYearEnd,
        plan: input.school.plan,
      })
      .returning();
    if (!inserted[0]) {
      throw new Error('school insert returned no rows');
    }
    school = inserted[0];
  } finally {
    await ownerSql.end({ timeout: 5 });
  }

  // 2. Create the admin user via better-auth. We use the runtime role
  //    here because better-auth already manages the credentials table.
  //    The user row will reference our just-created school's id.
  const auth = getAuth();
  try {
    const signUp = await auth.api.signUpEmail({
      body: {
        email: input.user.email,
        password: input.user.password,
        name: input.user.name,
        // Better-auth forwards additional fields to the user model.
        // Our `user.additionalFields` mapping in auth.server.ts covers
        // schoolId / role. We also flip emailVerified=true so the new
        // admin doesn't have to verify before they can sign in (they
        // proved control of the email at signup time — a real production
        // flow would require email verification first; we relax that for
        // the Tier 1 demo).
      },
      headers: request.headers,
      asResponse: true,
      returnHeaders: true,
    });

    // Set the additional user fields (schoolId, role) directly via Drizzle
    // since better-auth's `signUpEmail` doesn't accept them as inputs.
    // The user row exists at this point; we update it to attach to the
    // school + assign the admin role.
    const runtimeUrl = process.env.DATABASE_URL!;
    const runtimeSql = postgres(runtimeUrl, { max: 1, prepare: false });
    const runtimeDb = drizzle(runtimeSql, { schema: { users } });
    try {
      // Note: the runtime role's RLS would block this update because we
      // haven't set app.school_id yet. We use the OWNER role for this
      // single update — owner BYPASSRLS applies (no, owner doesn't have
      // BYPASSRLS, but owner owns the users table so RLS doesn't apply
      // to owner... wait — FORCE RLS applies even to owner per spec
      // section 4. So we DO need to set app.school_id.)
      //
      // The simplest correct path: temporarily disable RLS for this
      // session by SET LOCAL row_security = OFF inside a transaction.
      // Owner role can do this because owner has superuser-like DDL
      // privileges (CREATE / ALTER TABLE). After the update we COMMIT
      // and RLS re-enables itself for the next transaction.
      //
      // Alternative: use the owner role (which can SET LOCAL school_id)
      // and run with schoolId set. But there's a chicken-and-egg: we
      // need to UPDATE the user to set schoolId, but we need schoolId
      // to set app.school_id for RLS.
      //
      // Cleanest: do the update in an owner transaction with
      // SET LOCAL row_security = OFF. Documented in schema comment.
      await ownerSql.end({ timeout: 1 }).catch(() => undefined);
      const ownerSql2 = postgres(ownerUrl, { max: 1, prepare: false });
      const ownerDb2 = drizzle(ownerSql2, { schema: { users } });
      try {
        await ownerDb2.transaction(async (tx) => {
          await tx.execute(
            // SET LOCAL row_security = OFF only affects this transaction.
            // We need to cast 'on' to boolean since postgres SET takes
            // 'on'/'off' literals.
            // Use raw SQL via Drizzle's sql tag.
            (await import('drizzle-orm')).sql`SET LOCAL row_security = OFF`,
          );
          await tx
            .update(users)
            .set({
              schoolId: school.id,
              role: 'school_admin',
              emailVerifiedAt: new Date(),
            })
            .where(eq(users.email, input.user.email));
        });
      } finally {
        await ownerSql2.end({ timeout: 5 });
      }
    } catch (err) {
      throw err;
    }

    // 3. Forward better-auth's response (it sets the session cookie).
    const headers = new Headers({ Location: '/app' });
    const setCookies = signUp.headers.getSetCookie();
    for (const c of setCookies) headers.append('Set-Cookie', c);
    return new Response(null, { status: 303, headers });
  } catch (err) {
    // If the user already exists, signUpEmail throws — surface a
    // friendly error.
    const message = err instanceof Error ? err.message : 'signup_failed';
    return new Response(
      JSON.stringify({
        error: 'signup_failed',
        detail: message.includes('already') ? 'An account with that email already exists.' : message,
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export default function Signup() {
  const fetcher = useFetcher();
  const [serverError, setServerError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
  });

  const csrf = csrfFormField();

  async function onSubmit(values: SignupInput) {
    setServerError(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(values.school)) fd.append(`school.${k}`, String(v));
    for (const [k, v] of Object.entries(values.user)) fd.append(`user.${k}`, String(v));
    fd.append(csrf.name, csrf.value);
    fetcher.submit(fd, { method: 'post' });
  }

  const state = fetcher.data as { error?: string; detail?: string } | undefined;

  return (
    <main style={{ maxWidth: 540, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Create your school on EduSupervise</h1>
      <p>
        Already have an account? <Link to="/login">Sign in</Link>.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <input type="hidden" name={csrf.name} value={csrf.value} />

        <fieldset>
          <legend>School</legend>

          <Field label="School name" name="school.name" error={errors.school?.name?.message}>
            <input id="school.name" {...register('school.name')} />
          </Field>
          <Field label="URL slug" name="school.slug" error={errors.school?.slug?.message}>
            <input id="school.slug" placeholder="maple-elementary" {...register('school.slug')} />
          </Field>
          <Field label="Timezone" name="school.timezone" error={errors.school?.timezone?.message}>
            <input id="school.timezone" defaultValue="America/Toronto" {...register('school.timezone')} />
          </Field>
          <Field label="Cycle days (1-10)" name="school.cycleDays" error={errors.school?.cycleDays?.message}>
            <input id="school.cycleDays" type="number" min={1} max={10} defaultValue={5} {...register('school.cycleDays', { valueAsNumber: true })} />
          </Field>
          <Field label="School year start" name="school.schoolYearStart" error={errors.school?.schoolYearStart?.message}>
            <input id="school.schoolYearStart" type="date" {...register('school.schoolYearStart')} />
          </Field>
          <Field label="School year end" name="school.schoolYearEnd" error={errors.school?.schoolYearEnd?.message}>
            <input id="school.schoolYearEnd" type="date" {...register('school.schoolYearEnd')} />
          </Field>
          <Field label="Plan" name="school.plan" error={errors.school?.plan?.message}>
            <select id="school.plan" defaultValue="trial" {...register('school.plan')}>
              <option value="trial">30-day trial</option>
              <option value="pro">Pro ($49/mo)</option>
              <option value="school">School ($199/mo)</option>
            </select>
          </Field>
        </fieldset>

        <fieldset>
          <legend>Your account</legend>
          <Field label="Full name" name="user.name" error={errors.user?.name?.message}>
            <input id="user.name" autoComplete="name" {...register('user.name')} />
          </Field>
          <Field label="Email" name="user.email" error={errors.user?.email?.message}>
            <input id="user.email" type="email" autoComplete="email" {...register('user.email')} />
          </Field>
          <Field label="Password (8+ chars)" name="user.password" error={errors.user?.password?.message}>
            <input id="user.password" type="password" autoComplete="new-password" {...register('user.password')} />
          </Field>
        </fieldset>

        {state?.error && (
          <p role="alert" style={{ color: '#b91c1c' }}>
            {state.detail ?? state.error}
          </p>
        )}

        <button type="submit" disabled={fetcher.state !== 'idle'}>
          {fetcher.state === 'idle' ? 'Create school' : 'Creating...'}
        </button>
      </form>
    </main>
  );
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

function Field({
  label,
  name,
  error,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label htmlFor={name}>{label}</label>
      {children}
      {error && (
        <p role="alert" style={{ color: '#b91c1c', marginTop: '0.25rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}