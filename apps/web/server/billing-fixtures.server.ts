// apps/web/server/billing-fixtures.server.ts
//
// Test/dev-only helpers for the billing flow. Used by the
// /app/settings/billing dev tools (when NODE_ENV !== 'production')
// and by the integration tests to set up state without going through
// Stripe.
//
// NOT exported from any public route. Importing this module in
// production code is a code smell — the integration tests are the
// primary consumer.

import { eq } from 'drizzle-orm';
import {
  auditLog,
  getSystemClient,
  schools,
} from '@edusupervise/db';

/**
 * Force-set a school to the Pro plan without going through Stripe.
 * Mirrors what `checkout.session.completed` does for a real customer.
 * Uses the system role (BYPASSRLS) — the test setup owns it.
 *
 * In production this would be Stripe webhook-only.
 */
export async function upgradeToProForTesting(schoolId: string): Promise<void> {
  const url =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('upgradeToProForTesting: DATABASE_URL not set');
  const { db, close } = getSystemClient(url);
  try {
    await db
      .update(schools)
      .set({
        plan: 'pro',
        planDowngradePendingTo: null,
        planDowngradeEffectiveAt: null,
        stripeCustomerId: `cus_test_${schoolId.slice(0, 8)}`,
        stripeSubscriptionId: `sub_test_${schoolId.slice(0, 8)}`,
        updatedAt: new Date(),
      })
      .where(eq(schools.id, schoolId));
    await db.insert(auditLog).values({
      schoolId,
      userId: null,
      action: 'billing.plan.upgraded.test',
      targetType: 'school',
      targetId: schoolId,
      metadata: { plan: 'pro', source: 'test_fixture' } as Record<string, unknown>,
    });
  } finally {
    await close();
  }
}
