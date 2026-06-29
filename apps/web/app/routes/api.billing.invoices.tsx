// apps/web/app/routes/api.billing.invoices.tsx
//
// GET /api/billing/invoices — list the authenticated school's Stripe
// invoices. Admin-only.
//
// In mock mode we synthesize three invoices for the UI; in real mode
// we ask Stripe for the customer's invoice list.

import type { Route } from './+types/api.billing.invoices';
import { getSession, requireRole } from '../../server/auth.server';
import { listInvoicesForSchool } from '../../server/billing.server';
import { logger } from '../../server/logger.server';

export async function action() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  requireRole(session, ['school_admin']);

  try {
    const invoices = await listInvoicesForSchool(session.schoolId);
    return Response.json({ invoices });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, schoolId: session.schoolId }, 'billing: invoice list failed');
    return Response.json(
      { error: 'invoices_failed', detail: msg },
      { status: 500 },
    );
  }
}
