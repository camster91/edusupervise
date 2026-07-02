// apps/web/app/routes/api.billing.portal.tsx
//
// POST /api/billing/portal — generate a Stripe Customer Portal session
// for the authenticated school. Returns the portal URL as JSON
// `{ url }`. The client can choose to redirect or open in a new tab.

import type { Route } from './+types/api.billing.portal';
import { getSession, requireRole } from '../../server/auth.server';
import { validateCsrfWithFormToken } from '../../server/csrf.server';
import {
  createPortalSession,
  getSchoolStripeCustomerId,
} from '../../server/billing.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  requireRole(session, ['school_admin']);

  try {
    // Pre-fetch the school's stripe_customer_id so we can pass it
    // through to the adapter. If it's missing, we let the adapter
    // fall back to the env default (per billing-adapter semantics).
    const customerId = await getSchoolStripeCustomerId(session.schoolId);
    logger.info(
      { schoolId: session.schoolId, hasCustomer: !!customerId },
      'billing: creating portal session',
    );

    const result = await createPortalSession({ schoolId: session.schoolId });
    return Response.json({ url: result.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'billing: portal session failed');
    return Response.json(
      { error: 'portal_failed', detail: msg },
      { status: 500 },
    );
  }
}
