// apps/web/app/routes/api.billing.checkout.tsx
//
// POST /api/billing/checkout — begin a Stripe Checkout session for a
// plan upgrade. Returns a 303 redirect to Stripe (or the mock URL).
//
// Authenticated + admin-only: per spec section 6, only the school_admin
// triggers the upgrade. We enforce the role after the session check.
//
// CSRF: validateCsrf runs first.
//
// Why a redirect instead of a JSON response with `url`:
//   - The caller is a <Form method="post"> submission from
//     /app/settings/billing. A redirect is the natural Web 1.0 flow
//     and 303 is the standard "redirect after POST" status code.

import type { Route } from './+types/api.billing.checkout';
import { redirect } from 'react-router';
import { eq } from 'drizzle-orm';
import { getDb } from '../../server/db.server';
import { createCheckoutSession } from '../../server/billing.server';
import { validateCsrf } from '../../server/csrf.server';
import {
  getSession,
  requireRole,
  requireSession,
} from '../../server/auth.server';
import { logger } from '../../server/logger.server';
import { schools } from '@edusupervise/db';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);

  const form = await request.formData();
  const planRaw = String(form.get('plan') ?? '').trim();
  if (planRaw !== 'pro' && planRaw !== 'school') {
    return Response.json({ error: 'invalid_plan' }, { status: 400 });
  }

  // Confirm the school exists in the runtime role (RLS-bound) so a
  // session for school A trying to upgrade school B fails cleanly.
  const db = getDb();
  const rows = await db
    .select({ id: schools.id })
    .from(schools)
    .where(eq(schools.id, session.schoolId))
    .limit(1);
  if (rows.length === 0) {
    return Response.json({ error: 'school_not_found' }, { status: 404 });
  }

  try {
    const result = await createCheckoutSession({
      schoolId: session.schoolId,
      plan: planRaw,
    });
    logger.info(
      {
        schoolId: session.schoolId,
        plan: planRaw,
        sessionId: (result as { sessionId?: string }).sessionId,
      },
      'billing: checkout session created',
    );
    return redirect(result.url, 303);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, schoolId: session.schoolId }, 'billing: checkout failed');
    return Response.json(
      { error: 'checkout_failed', detail: msg },
      { status: 500 },
    );
  }
}
