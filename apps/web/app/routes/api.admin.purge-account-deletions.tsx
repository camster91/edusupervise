// app/routes/api.admin.purge-account-deletions.tsx
//
// Internal-only endpoint to hard-delete all users with
// pending_deletion_at < now(). Called by the daily cron
// (/root/edusupervise-secrets/daily-account-deletion-purge.sh).
//
// Auth: shared-secret header (X-Cron-Secret) matches process.env
// (CRON_SECRET). No session, no CSRF, no user enumeration surface.
// Rate-limit: 1/hr/IP via the standard rate-limit helper.
//
// Why not just hit /account/delete/confirm? That's user-facing. This
// route is admin/system-only and never linked from the UI.

import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { purgeAccountDeletions } from '../../server/account-deletion.server';

const RATE_LIMIT = { key: 'purge-cron', max: 4, windowSec: 60 * 60 } as const;

function authorized(request: Request): boolean {
  const provided = request.headers.get('x-cron-secret')?.trim();
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    // CRON_SECRET not set = endpoint disabled. Refuse all.
    return false;
  }
  if (!provided || provided.length !== expected.length) return false;
  // Constant-time compare
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  return new Response(
    JSON.stringify({ error: 'method_not_allowed' }),
    { status: 405, headers: { 'content-type': 'application/json' } },
  );
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'method_not_allowed' }),
      { status: 405, headers: { 'content-type': 'application/json' } },
    );
  }
  if (!authorized(request)) {
    return new Response(
      JSON.stringify({ error: 'unauthorized' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }

  try {
    const result = await purgeAccountDeletions();
    return new Response(
      JSON.stringify({ ok: true, ...result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (err) {
    console.error('[purge-account-deletions] failed', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'internal' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}
