// apps/web/app/routes/api.mobile.push.unsubscribe.ts
//
// POST /api/mobile/push/unsubscribe — mark the caller's Expo push
// token as revoked (soft-delete). Called on mobile logout.
//
// Auth: getSession() required. CSRF REQUIRED (security review E-008,
// 2026-07-06). See api.mobile.push.subscribe.ts for the rationale —
// treating mutation endpoints uniformly is a stronger invariant than
// a per-endpoint exemption, and the cost (one extra GET on first
// launch to populate the CSRF cookie) is negligible.
//
// Body: { csrf, expoPushToken }
//
// Behaviour:
//   Sets `revoked_at = now()` on the matching row. We DON'T hard-
//   delete (security review E-006) because:
//     (a) the row is useful for analytics ("how many devices
//         registered total this month?")
//     (b) the dispatcher in @edusupervise/push already filters
//         `revoked_at IS NULL` so the soft-delete is invisible to
//         dispatch.
//     (c) audit / recovery — a hard delete is irreversible; soft
//         delete lets us reconstruct "this user was subscribed on
//         this device on this date" for support cases.
//   A subsequent /subscribe re-enables it (the upsert clears the
//   column).
//
// Idempotency: a re-unsubscribe of an already-revoked row is a no-op
// (the UPDATE matches 0 rows after revoked_at is already set; the
// success path is identical). Calling with an unknown token returns
// 204 anyway — the client doesn't need to know whether the row
// existed, and surfacing 404 leaks the existence of tokens.

import { and, eq, isNull } from 'drizzle-orm';
import type { Route } from './+types/api.mobile.push.unsubscribe';
import { z } from 'zod';
import { getSession } from '../../server/auth.server';
import { getDb } from '../../server/db.server';
import { validateCsrfFromJson } from '../../server/csrf.server';
import { logger } from '../../server/logger.server';
import { mobilePushSubscriptions } from '@edusupervise/db';
import { maskToken } from '@edusupervise/push';

const unsubscribeBodySchema = z.object({
  expoPushToken: z
    .string()
    .min(1)
    .max(255)
    .regex(/^ExponentPushToken\[.+\]$/, {
      message: 'expoPushToken must look like "ExponentPushToken[xxx]"',
    }),
});

export async function loader() {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  // 1. Parse body FIRST — validateCsrfFromJson reads csrf from the
  //    body, not a header.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: 'malformed_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Response.json(
      { error: 'invalid_body' },
      { status: 400 },
    );
  }
  const body = raw as Record<string, unknown>;

  // 2. CSRF check (Layer 1: origin/referer; Layer 2: cookie + body.csrf).
  const csrf = validateCsrfFromJson(request, body, { requireOrigin: false });
  if (!csrf.ok) return csrf.response;

  // 3. Auth.
  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 4. Validate the rest of the body.
  const parsed = unsubscribeBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'invalid_body',
        detail: parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  const { expoPushToken } = parsed.data;
  const db = getDb();
  try {
    // Only revoke active rows. If the row was already revoked, this
    // matches 0 rows and we still return 204 (idempotent success).
    // The user_id + revoked_at IS NULL filter is the second line of
    // defense against a CSRF-style attack: a stolen session can only
    // revoke THIS USER'S tokens, not another user's.
    await db
      .update(mobilePushSubscriptions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mobilePushSubscriptions.userId, session.userId),
          eq(mobilePushSubscriptions.expoPushToken, expoPushToken),
          isNull(mobilePushSubscriptions.revokedAt),
        ),
      );
  } catch (err) {
    logger.error(
      { err, userId: session.userId, schoolId: session.schoolId },
      'mobile-push.unsubscribe: update failed',
    );
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  logger.info(
    {
      userId: session.userId,
      schoolId: session.schoolId,
      token: maskToken(expoPushToken),
    },
    'mobile-push.unsubscribe: revoked',
  );

  return new Response(null, { status: 204 });
}
