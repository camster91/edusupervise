// apps/web/app/routes/api.push.vapid-public-key.ts — expose the VAPID
// public key to the browser so pushManager.subscribe() can use it.
//
// Public (no auth required) — the public key isn't secret. The SW
// calls this on every page load so key rotation by redeploy propagates
// without an app version bump.
//
// Cached aggressively via Cache-Control: the key only changes on a
// server-side VAPID rotation, which is a deliberate ops action.

import type { Route } from './+types/api.push.vapid-public-key';

export async function loader(_args: Route.LoaderArgs) {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  if (!publicKey) {
    return Response.json(
      { error: 'vapid_not_configured' },
      { status: 503 },
    );
  }
  return Response.json(
    { publicKey },
    {
      headers: {
        // Long-lived cache so the SW doesn't fetch on every page load,
        // but short enough that a manual key rotation propagates within
        // a working day.
        'Cache-Control': 'public, max-age=3600, must-revalidate',
      },
    },
  );
}