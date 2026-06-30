// apps/web/app/routes/app.api.demo.reset.ts
//
// POST /app/api/demo/reset — Wipe + re-seed the current demo school.
// Auth required (school_admin, plan in {demo, demo_expired}).
// CSRF-protected via form-body helper.
//
// On success: extends demo_expires_at to now + 30 days, plan to 'demo'.

import { redirect } from 'react-router';
import type { Route } from './+types/app.api.demo.reset';
import { validateCsrfWithFormToken } from '../../server/csrf.server';
import { getSession } from '../../server/auth.server';
import { resetDemoSchool } from '../../server/signup.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  const session = await getSession(request);
  if (!session || session.role !== 'school_admin') {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    await resetDemoSchool({ schoolId: session.schoolId, userId: session.userId });
  } catch (err) {
    logger.error({ err, userId: session.userId }, 'demo.reset: failed');
    return Response.json({ error: 'Reset failed. Please try again.' }, { status: 500 });
  }

  return redirect('/app/today', {
    headers: {
      // The "demo was reset" toast lives on the client; for now we rely
      // on the next loader's data showing the new seed data as proof.
      'Set-Cookie': '',
    },
  });
}