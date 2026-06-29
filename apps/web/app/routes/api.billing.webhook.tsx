// apps/web/app/routes/api.billing.webhook.tsx
//
// POST /api/billing/webhook — Stripe webhook receiver.
//
// Differences from a normal mutation route:
//   - NO CSRF — Stripe signs the body with STRIPE_WEBHOOK_SECRET
//     and the verifier in billing.server.ts uses crypto.timingSafeEqual.
//     A CSRF check would always fail because Stripe isn't a logged-in
//     user.
//   - NO session requirement — same reason.
//   - idempotency: the first INSERT into `stripe_events` is what
//     dedupes; see billing.server.ts#handleWebhookEvent.
//
// Returns:
//   - 200 OK on processed or duplicate
//   - 400 on signature failure (Stripe will retry)
//   - 200 (with `processed: false`) when the body is empty / malformed
//     so Stripe doesn't loop forever on a bad payload

import type { Route } from './+types/api.billing.webhook';
import { handleWebhookEvent } from '../../server/billing.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  // Reject everything except POST. RR7 routes are POST-by-default
  // for POST forms, but a defensive check doesn't hurt.
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!rawBody || rawBody.length === 0) {
    return Response.json({ error: 'empty_body' }, { status: 400 });
  }

  let result;
  try {
    result = await handleWebhookEvent({ rawBody, signature });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'billing: webhook handler threw');
    // Returning 500 lets Stripe retry. The transaction has been
    // rolled back so the dedup row is gone too.
    return Response.json({ error: 'handler_failed', detail: msg }, { status: 500 });
  }

  if (!result.processed) {
    // Signature verification failed — return 400 so Stripe's logs
    // show "Bad request" and the user investigates their endpoint
    // configuration.
    return Response.json({ error: 'signature_invalid' }, { status: 400 });
  }

  return Response.json({
    received: true,
    duplicate: result.duplicate,
    action: result.action ?? null,
  });
}
