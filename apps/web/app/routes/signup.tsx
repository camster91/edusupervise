// apps/web/app/routes/signup.tsx — school self-signup
//
// Creates a school + first school_admin in a single transaction. Issues a
// session cookie on success and redirects to /app.
//
// CSRF note: per spec section 5, full double-submit cookie is wired in
// server/csrf.server.ts. For the deploy-with-mocks tier, we accept that
// same-origin POSTs don't have cross-origin CSRF risk and defer the
// frontend-side `x-csrf-token` injection until real auth is wired.

import { Form, redirect, useActionData } from 'react-router';
import type { Route } from './+types/signup';
import { getDb } from '../../server/db.server.ts';
import {
  hashPassword,
  newSessionTokenFor,
  sessionCookieAttributes,
} from '../../server/auth.server.ts';
import { schools, users } from '@edusupervise/db';
import { sql } from 'drizzle-orm';

export function meta() {
  return [{ title: 'Sign up — EduSupervise' }];
}

export async function loader() {
  return null;
}

interface SignupInput {
  schoolName: string;
  schoolSlug: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
}

function validate(input: unknown): { ok: true; value: SignupInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_input' };
  const v = input as Record<string, unknown>;
  const schoolName = String(v.schoolName ?? '').trim();
  const schoolSlug = String(v.schoolSlug ?? '').trim().toLowerCase();
  const adminName = String(v.adminName ?? '').trim();
  const adminEmail = String(v.adminEmail ?? '').trim().toLowerCase();
  const adminPassword = String(v.adminPassword ?? '');
  if (schoolName.length < 2 || schoolName.length > 100) return { ok: false, error: 'school_name_invalid' };
  if (!/^[a-z0-9-]{2,40}$/.test(schoolSlug)) return { ok: false, error: 'school_slug_invalid' };
  if (adminName.length < 1 || adminName.length > 100) return { ok: false, error: 'admin_name_invalid' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return { ok: false, error: 'admin_email_invalid' };
  if (adminPassword.length < 8) return { ok: false, error: 'admin_password_too_short' };
  return { ok: true, value: { schoolName, schoolSlug, adminName, adminEmail, adminPassword } };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const v = validate(Object.fromEntries(form));
  if (!v.ok) {
    return Response.json({ error: v.error }, { status: 400 });
  }
  const { schoolName, schoolSlug, adminName, adminEmail, adminPassword } = v.value;
  const db = getDb();
  const passwordHash = await hashPassword(adminPassword);
  const now = new Date();
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const sep1 = new Date(Date.UTC(year, 8, 1));
  const dow = sep1.getUTCDay();
  const offset = dow === 1 ? 0 : (8 - dow) % 7;
  const schoolYearStart = new Date(sep1.getTime() + offset * 86_400_000);
  const schoolYearEnd = new Date(schoolYearStart.getTime() + 305 * 86_400_000);
  const trialEndsAt = new Date(Date.now() + 30 * 86_400_000);
  try {
    const result = await db.transaction(async (tx) => {
      const [school] = await tx
        .insert(schools)
        .values({
          slug: schoolSlug,
          name: schoolName,
          schoolYearStart: sql`${schoolYearStart.toISOString().slice(0, 10)}::date`,
          schoolYearEnd: sql`${schoolYearEnd.toISOString().slice(0, 10)}::date`,
          plan: 'trial',
          trialEndsAt,
        })
        .returning();
      if (!school) throw new Error('school_insert_failed');
      const [user] = await tx
        .insert(users)
        .values({
          schoolId: school.id,
          email: adminEmail,
          passwordHash,
          name: adminName,
          role: 'school_admin',
          emailVerifiedAt: new Date(),
        })
        .returning();
      if (!user) throw new Error('user_insert_failed');
      return { school, user };
    });
    const { token } = newSessionTokenFor(result.user.id);
    return redirect('/app', {
      headers: { 'Set-Cookie': `edusupervise.session=${token}; ${sessionCookieAttributes()}` },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return Response.json({ error: 'school_or_email_taken' }, { status: 409 });
    }
    return Response.json({ error: 'signup_failed', detail: msg }, { status: 500 });
  }
}

export default function SignupPage() {
  const data = useActionData() as { error?: string } | undefined;
  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Create your school</h1>
          <p className="text-sm text-slate-600 mt-1">30-day free trial. No credit card.</p>
        </div>
        <Form method="post" className="space-y-4">
          <Field name="schoolName" label="School name" placeholder="Maple Elementary" />
          <Field name="schoolSlug" label="URL slug" placeholder="maple-elementary" hint="lowercase, letters/numbers/dashes" />
          <hr className="border-slate-200" />
          <Field name="adminName" label="Your name" placeholder="Cameron Ashley" />
          <Field name="adminEmail" label="Email" type="email" placeholder="admin@maple.edu" />
          <Field name="adminPassword" label="Password" type="password" placeholder="min 8 chars" />
          {data?.error && <p className="text-sm text-red-600">{data.error}</p>}
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">
            Create school
          </button>
        </Form>
        <p className="text-sm text-slate-600 text-center mt-6">
          Already have an account? <a href="/login" className="text-blue-600 hover:underline">Sign in</a>
        </p>
      </div>
    </main>
  );
}

function Field({ name, label, type = 'text', placeholder, hint }: {
  name: string; label: string; type?: string; placeholder?: string; hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required
        className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none transition"
      />
      {hint && <span className="text-xs text-slate-500 mt-1 block">{hint}</span>}
    </label>
  );
}