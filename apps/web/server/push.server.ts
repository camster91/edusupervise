// apps/web/server/push.server.ts — Web Push helper (stub)
//
// Full Web Push integration is planned for Phase 2. This stub:
//   - accepts the same interface `sendPushToUser` callers expect
//   - logs what would have been pushed
//   - returns void
//
// When the real implementation lands, replace the body of
// `sendPushToUser` with the actual web-push library call. The contract
// (signature + return type) is fixed; downstream code shouldn't change.
//
// VAPID config to wire up when this becomes real:
//   - VAPID_PUBLIC_KEY (in app.secrets)
//   - VAPID_PRIVATE_KEY (in app.secrets)
//   - VAPID_SUBJECT (mailto:admin@edusupervise.ashbi.ca)
//   - web-push npm package (already in package.json via `@types/web-push`)
//
// See `docs/runbooks/push-debug.md` for the failure-mode checklist:
//   - 401 from push service → VAPID keys mismatch
//   - 404 → endpoint unregistered (we delete the row)
//   - 410 Gone → endpoint retired, we delete the row
//   - Browser blocks → user has notifications denied (UI surface this)

import { logger } from './logger.server';

export interface PushPayload {
  title: string;
  body: string | null;
  linkUrl: string | null;
  tag: string | null;
  data: Record<string, unknown>;
}

export async function sendPushToUser(
  userId: string,
  schoolId: string,
  payload: PushPayload,
): Promise<void> {
  // Stub: log what would have been pushed. Replace with web-push call:
  //   const subscriptions = await getPushSubscriptionsForUser(userId, schoolId);
  //   for (const sub of subscriptions) {
  //     try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
  //     catch (err) {
  //       if (err.statusCode === 410) await deletePushSubscription(sub.endpoint);
  //       else throw err;
  //     }
  //   }
  logger.info(
    {
      userId,
      schoolId,
      title: payload.title,
      tag: payload.tag,
      dataKeys: Object.keys(payload.data),
    },
    'push.stub: would have sent (no real VAPID config yet)',
  );
}