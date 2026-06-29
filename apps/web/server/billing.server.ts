// apps/web/server/billing.server.ts — Stripe + tier-1 billing state changes.
//
// Layered on top of `@edusupervise/billing-adapter`, which already implements
// the mock-vs-real Stripe split (BILLING_PROVIDER env var). This module:
//
//   1. Re-exports `createCheckoutSession`, `createPortalSession`,
//      `verifyWebhook` from the adapter package so route handlers have a
//      single import surface.
//   2. Adds the database side: applying a verified webhook event in a
//      transaction that INSERTs into `stripe_events` (idempotency) BEFORE
//      applying state changes. A failed state change rolls back the
//      dedup row, so Stripe's retry will re-process the event cleanly.
//   3. Implements the destructive-downgrade workflow per spec section 6
//      (plan downgrade policy): on `customer.subscription.deleted` from
//      Pro/School → Free, set `plan_downgrade_pending_to = 'free'` and
//      `plan_downgrade_effective_at = now() + 7 days`. Cron in
//      `db/cron/plan-downgrade.sql` flips the plan after the grace.
//
// Stripe SDK ~17.0.0 (pinned per spec section 3).
//
// Role choice for `handleWebhookEvent`:
//   Stripe webhooks deliver global events (not tenant-scoped), but every
//   state change they cause (`schools` rows by `stripe_customer_id`,
//   audit_log rows) crosses tenant boundaries when the system reaches
//   out to multiple subscriptions. We use the SYSTEM role
//   (`BYPASSRLS`) here — same reasoning as the worker container —
//   because the stripe_events table is global and the `schools` row
//   we mutate may belong to any tenant.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  getSystemClient,
  type Db,
  auditLog,
  notifications,
  schools,
  stripeEvents,
  type School,
} from '@edusupervise/db';
import {
  createCheckoutSession as adapterCreateCheckout,
  createPortalSession as adapterCreatePortal,
  verifyWebhook as adapterVerifyWebhook,
  type BillingProvider,
  type Plan as AdapterPlan,
} from '@edusupervise/billing-adapter';

import { logger } from './logger.server';

export {
  adapterCreateCheckout as createCheckoutSession,
  adapterCreatePortal as createPortalSession,
  adapterVerifyWebhook as verifyWebhook,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Plan = 'free' | 'pro' | 'school';

export interface BillingCheckoutResult {
  url: string;
}

export interface BillingPortalResult {
  url: string;
}

export type { BillingProvider };

/** Payload shape for `handleWebhookEvent`. Mirrors Stripe's structure. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  created?: number;
  livemode?: boolean;
  data?: {
    object?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Helpers used by routes + the integration test
// ---------------------------------------------------------------------------

/** Lowercase UUID validator. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Look up a school by `stripe_customer_id`. Uses the system role since
 * `schools` RLS requires `current_school_id()` to match — but we don't
 * know the school yet (that's what we're looking up). The system
 * role's `BYPASSRLS` is the documented bootstrap path for billing
 * callbacks. Same pattern as the worker.
 *
 * Returns `null` if the customer_id is unset or the row doesn't exist.
 */
export async function findSchoolByStripeCustomer(
  stripeCustomerId: string,
): Promise<School | null> {
  if (!stripeCustomerId) return null;
  const sys = openSystemClient();
  try {
    const rows = await sys.db
      .select()
      .from(schools)
      .where(eq(schools.stripeCustomerId, stripeCustomerId))
      .limit(1);
    return (rows[0] as unknown as School) ?? null;
  } finally {
    await sys.close();
  }
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

export interface HandleWebhookResult {
  /** True when the event was processed (or skipped due to duplicate). */
  processed: boolean;
  /** True when the event was a duplicate (already in stripe_events). */
  duplicate: boolean;
  /** Stable identifier for the kind of action taken — useful for tests. */
  action?: string;
}

/**
 * Verify a webhook payload's signature, then apply the resulting state
 * change in a single transaction with the dedup row.
 *
 * Sequence (mirrors spec section 6):
 *
 *   tx:
 *     1. INSERT INTO stripe_events (id, type, payload) — UNIQUE(id) throws
 *        on duplicate → caught + returns { duplicate: true, processed: true }.
 *     2. Dispatch to the per-type handler (update schools / write
 *        notifications / set plan_downgrade_pending_to).
 *     3. Commit.
 *
 * If step 2 throws, the transaction rolls back — the stripe_events row
 * is gone too. Stripe's retry will re-fire the event cleanly because we
 * didn't lock it in.
 *
 * `signature` is the value of the `Stripe-Signature` header (or 'mock' /
 * undefined for mock-provider tests). Returns `{ processed: false }`
 * when the signature does not verify — the route translates that into
 * a 401.
 */
export async function handleWebhookEvent(input: {
  rawBody: string;
  signature: string | null;
}): Promise<HandleWebhookResult> {
  // Step 1: verify signature (delegates to the adapter for mock vs real)
  const verify = adapterVerifyWebhook({
    rawBody: input.rawBody,
    signature: input.signature,
  });
  if (!verify.verified || !verify.event) {
    logger.warn(
      { reason: verify.reason },
      'billing: webhook signature rejected',
    );
    return { processed: false, duplicate: false };
  }

  const event = verify.event as StripeWebhookEvent;
  if (!event.id || !event.type) {
    logger.warn({ event }, 'billing: webhook event missing id or type');
    return { processed: false, duplicate: false };
  }

  // Step 2: apply the event in a transaction. The first INSERT is into
  // stripe_events; a UNIQUE conflict on `id` is the dedup signal.
  // We open a fresh system-role client + close it in `finally` so the
  // connection pool doesn't accumulate across webhook calls. The cached
  // client in `_systemDb` is for synchronous helpers (getSchoolStripeCustomerId,
  // etc.) which short-lived calls reuse.
  const sysForEvent = openSystemClient();
  let isDuplicate = false;
  let appliedAction: string | undefined;
  try {
    try {
      await sysForEvent.db.transaction(async (tx) => {
        // dedup row first — UNIQUE(id) conflict throws PG error
        await tx.insert(stripeEvents).values({
          id: event.id,
          type: event.type,
          payload: event as unknown as Record<string, unknown>,
        });
        // apply state change ONLY if the dedup row inserted cleanly
        appliedAction = await applyStripeEvent(tx, event);
      });
      logger.info(
        { eventId: event.id, type: event.type, action: appliedAction },
        'billing: webhook applied',
      );
      return { processed: true, duplicate: false, action: appliedAction };
    } catch (err) {
      // Postgres wraps the UNIQUE constraint violation as a
      // PostgresError with code 23505. We also accept the textual
      // match in case the error is wrapped differently.
      const code = (err as { code?: string | number }).code;
      const codeStr = code === undefined ? '' : String(code);
      const msg = err instanceof Error ? err.message : String(err);
      const codeMatches = code === 23505 || codeStr === '23505';
      const msgMatches =
        msg.includes('duplicate key value') ||
        msg.includes('unique constraint') ||
        msg.includes('unique_violation');
      if (codeMatches || msgMatches) {
        isDuplicate = true;
      } else {
        throw err;
      }
    }
    if (isDuplicate) {
      logger.info(
        { eventId: event.id, type: event.type },
        'billing: duplicate webhook (idempotent skip)',
      );
      return { processed: true, duplicate: true };
    }
    // unreachable
    return { processed: true, duplicate: false };
  } finally {
    await sysForEvent.close();
  }
}

/**
 * Dispatch the event to a per-type handler. Returns a short label so
 * tests + logs can assert what changed. Each branch is responsible
 * for using the `tx` to apply its state change — DO NOT make any
 * external calls (Stripe API, email, etc.) inside the transaction.
 *
 * Handlers implemented:
 *   - checkout.session.completed           → set stripe_customer_id /
 *                                            stripe_subscription_id,
 *                                            bump plan based on the
 *                                            metadata.plan field
 *   - customer.subscription.deleted       → set
 *                                            plan_downgrade_pending_to +
 *                                            plan_downgrade_effective_at
 *                                            if currently paid
 *   - customer.subscription.updated       → reflect status changes
 *                                            ('active' → plan bump,
 *                                             others → no plan change)
 *   - invoice.payment_failed               → write a notification
 *                                            for the school admin(s)
 */
async function applyStripeEvent(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  event: StripeWebhookEvent,
): Promise<string | undefined> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(tx, event);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(tx, event);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(tx, event);
    case 'invoice.payment_failed':
      return handlePaymentFailed(tx, event);
    default:
      logger.debug({ type: event.type }, 'billing: unhandled event type');
      return `unhandled:${event.type}`;
  }
}

interface StripeLikeCheckoutSession {
  id?: string;
  customer?: string | null;
  subscription?: string | null;
  mode?: string;
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
}

async function handleCheckoutCompleted(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  event: StripeWebhookEvent,
): Promise<string> {
  const obj = event.data?.object as StripeLikeCheckoutSession | undefined;
  if (!obj) return 'checkout.session.completed:no_object';
  const stripeCustomerId = obj.customer ?? null;
  const stripeSubscriptionId = obj.subscription ?? null;
  // plan is set via metadata.plan = 'pro' | 'school' (matches our
  // createCheckoutSession call in billing-adapter). Fall back to
  // client_reference_id (the schoolId) so we know which school this is.
  const planFromMeta = (obj.metadata?.plan ?? null) as Plan | null;
  const schoolId =
    (typeof obj.metadata?.schoolId === 'string' && obj.metadata.schoolId) ||
    (typeof obj.client_reference_id === 'string' && obj.client_reference_id) ||
    null;

  if (!schoolId || !isUuid(schoolId)) {
    return 'checkout.session.completed:no_school';
  }
  if (!planFromMeta || (planFromMeta !== 'pro' && planFromMeta !== 'school')) {
    return 'checkout.session.completed:no_plan';
  }

  const updates: Record<string, unknown> = {
    stripeCustomerId,
    stripeSubscriptionId,
    updatedAt: new Date(),
  };
  // on first paid checkout, flip plan + clear any pending downgrade
  if (planFromMeta) updates.plan = planFromMeta;
  updates.planDowngradePendingTo = null;
  updates.planDowngradeEffectiveAt = null;

  await tx
    .update(schools)
    .set(updates)
    .where(eq(schools.id, schoolId));

  await tx.insert(auditLog).values({
    schoolId,
    userId: null,
    action: 'billing.plan.upgraded',
    targetType: 'school',
    targetId: schoolId,
    metadata: {
      plan: planFromMeta,
      stripeCustomerId,
      stripeSubscriptionId,
      eventId: event.id,
    } as Record<string, unknown>,
  });

  return `checkout.session.completed:plan=${planFromMeta}`;
}

interface StripeLikeSubscription {
  id?: string;
  customer?: string | null;
  status?: string;
  items?: { data?: Array<{ price?: { id?: string } }> };
  metadata?: Record<string, string> | null;
}

async function handleSubscriptionDeleted(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  event: StripeWebhookEvent,
): Promise<string> {
  const obj = event.data?.object as StripeLikeSubscription | undefined;
  if (!obj) return 'customer.subscription.deleted:no_object';
  const stripeCustomerId = obj.customer;
  if (!stripeCustomerId) return 'customer.subscription.deleted:no_customer';

  // Find the school by stripe_customer_id. RLS doesn't apply because
  // we're using the system role.
  const rows = await tx
    .select()
    .from(schools)
    .where(eq(schools.stripeCustomerId, stripeCustomerId))
    .limit(1);
  const school = rows[0];
  if (!school) {
    return 'customer.subscription.deleted:school_not_found';
  }

  // Spec section 6: Pro/School → Free is the destructive case. Trial
  // and Free don't trigger the 7-day grace.
  if (school.plan === 'pro' || school.plan === 'school') {
    const effectiveAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await tx
      .update(schools)
      .set({
        planDowngradePendingTo: 'free',
        planDowngradeEffectiveAt: effectiveAt,
        updatedAt: new Date(),
      })
      .where(eq(schools.id, school.id));
    await tx.insert(auditLog).values({
      schoolId: school.id,
      userId: null,
      action: 'billing.plan.downgrade_pending',
      targetType: 'school',
      targetId: school.id,
      metadata: {
        fromPlan: school.plan,
        toPlan: 'free',
        effectiveAt: effectiveAt.toISOString(),
        eventId: event.id,
      } as Record<string, unknown>,
    });

    // Push a notification to every active school_admin in this school.
    // System role can read users across school_id because we don't set
    // app.school_id; we scope via the explicit WHERE.
    const adminRows = await tx.execute(sql`
      SELECT id FROM users
       WHERE school_id = ${school.id}
         AND role = 'school_admin'
         AND is_active = true
    `);
    const adminIds = (
      Array.isArray(adminRows) ? adminRows : (adminRows as unknown as { rows?: unknown[] }).rows ?? []
    ) as Array<{ id: string }>;

    for (const admin of adminIds) {
      await tx.insert(notifications).values({
        schoolId: school.id,
        userId: admin.id,
        kind: 'plan.downgrade.pending',
        title: 'Subscription ended — data will be reduced in 7 days',
        body: `Your ${school.plan} plan ended. You have until ${effectiveAt
          .toISOString()
          .slice(0, 10)} to export your audit log before the plan switches to Free.`,
        linkUrl: '/app/settings/billing',
      });
    }

    return `customer.subscription.deleted:downgrade_pending:${school.id}`;
  }

  // Trial or free → no grace, just clear the stripe metadata.
  await tx
    .update(schools)
    .set({
      stripeSubscriptionId: null,
      updatedAt: new Date(),
    })
    .where(eq(schools.id, school.id));
  return `customer.subscription.deleted:noop:${school.plan}`;
}

async function handleSubscriptionUpdated(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  event: StripeWebhookEvent,
): Promise<string> {
  const obj = event.data?.object as StripeLikeSubscription | undefined;
  if (!obj || !obj.customer) {
    return 'customer.subscription.updated:no_object';
  }
  // For now we just refresh stripe_subscription_id; plan flips are
  // handled by checkout.session.completed. Past-due is a "soft"
  // signal — we don't enforce hard limits yet (Tier 1.5).
  const rows = await tx
    .select()
    .from(schools)
    .where(eq(schools.stripeCustomerId, obj.customer))
    .limit(1);
  const school = rows[0];
  if (!school) return 'customer.subscription.updated:school_not_found';
  if (obj.status === 'past_due') {
    await tx.insert(auditLog).values({
      schoolId: school.id,
      userId: null,
      action: 'billing.invoice.past_due',
      targetType: 'school',
      targetId: school.id,
      metadata: { eventId: event.id } as Record<string, unknown>,
    });
    return 'customer.subscription.updated:past_due';
  }
  return 'customer.subscription.updated:noop';
}

async function handlePaymentFailed(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  event: StripeWebhookEvent,
): Promise<string> {
  const obj = event.data?.object as { customer?: string | null } | undefined;
  if (!obj || !obj.customer) return 'invoice.payment_failed:no_object';
  const rows = await tx
    .select()
    .from(schools)
    .where(eq(schools.stripeCustomerId, obj.customer))
    .limit(1);
  const school = rows[0];
  if (!school) return 'invoice.payment_failed:school_not_found';
  await tx.insert(auditLog).values({
    schoolId: school.id,
    userId: null,
    action: 'billing.invoice.payment_failed',
    targetType: 'school',
    targetId: school.id,
    metadata: { eventId: event.id } as Record<string, unknown>,
  });
  return 'invoice.payment_failed:audit_logged';
}

// ---------------------------------------------------------------------------
// Cron-driven downgrade flip
// ---------------------------------------------------------------------------

/**
 * Called by the nightly cron (db/cron/plan-downgrade.sql wraps this as
 * pure SQL — but we expose it for the integration test so the test can
 * exercise the flip without spinning up a `psql` subprocess).
 *
 * Returns the school ids whose plan flipped from a paid plan (or paid
 * pending) to free. Empty array means there's nothing to do today.
 */
export async function runDailyDowngradeFlip(): Promise<string[]> {
  const sys = openSystemClient();
  try {
    return await sys.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schools)
        .where(
          sql`${schools.planDowngradePendingTo} = 'free'
              AND ${schools.planDowngradeEffectiveAt} IS NOT NULL
              AND ${schools.planDowngradeEffectiveAt} <= now()`,
        );
      const flipped: string[] = [];
      for (const row of rows) {
        await tx
          .update(schools)
          .set({
            plan: 'free',
            planDowngradePendingTo: null,
            planDowngradeEffectiveAt: null,
            updatedAt: new Date(),
          })
          .where(eq(schools.id, row.id));
        await tx.insert(auditLog).values({
          schoolId: row.id,
          userId: null,
          action: 'billing.plan.downgrade_applied',
          targetType: 'school',
          targetId: row.id,
          metadata: { previousPlan: row.plan, toPlan: 'free' } as Record<
            string,
            unknown
          >,
        });
        // Notify admins.
        const adminRows = await tx.execute(sql`
          SELECT id FROM users
           WHERE school_id = ${row.id}
             AND role = 'school_admin'
             AND is_active = true
        `);
        const adminIds = (Array.isArray(adminRows)
          ? adminRows
          : (adminRows as unknown as { rows?: unknown[] }).rows ?? []) as Array<{
          id: string;
        }>;
        for (const admin of adminIds) {
          await tx.insert(notifications).values({
            schoolId: row.id,
            userId: admin.id,
            kind: 'plan.downgrade.applied',
            title: 'Plan switched to Free',
            body: 'Your plan has been switched to Free. Your audit log will now be retained for 7 days.',
            linkUrl: '/app/settings/billing',
          });
        }
        flipped.push(row.id);
      }
      return flipped;
    });
  } finally {
    await sys.close();
  }
}

// ---------------------------------------------------------------------------
// Cross-tenant bootstrap: stripe customer creation
// ---------------------------------------------------------------------------

/**
 * Set / update the school's stripe_customer_id. The checkout flow needs
 * a customer to exist BEFORE checkout.session.create; for the mock layer
 * we let the webhook carry it (or call this directly from the portal
 * route when the customer doesn't exist yet).
 */
export async function setSchoolStripeCustomer(
  schoolId: string,
  stripeCustomerId: string,
  stripeSubscriptionId: string | null = null,
): Promise<void> {
  if (!isUuid(schoolId)) {
    throw new Error(`setSchoolStripeCustomer: invalid schoolId ${schoolId}`);
  }
  const sys = openSystemClient();
  try {
    await sys.db
      .update(schools)
      .set({
        stripeCustomerId,
        stripeSubscriptionId,
        updatedAt: new Date(),
      })
      .where(eq(schools.id, schoolId));
  } finally {
    await sys.close();
  }
}

/**
 * Read the school's `stripe_customer_id` (used by the portal route, which
 * needs to pass `customer` to Stripe). Falls back to the global env
 * default if unset (per billing-adapter behavior).
 */
export async function getSchoolStripeCustomerId(
  schoolId: string,
): Promise<string | null> {
  if (!isUuid(schoolId)) return null;
  const sys = openSystemClient();
  try {
    const rows = await sys.db
      .select({ stripeCustomerId: schools.stripeCustomerId })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1);
    return rows[0]?.stripeCustomerId ?? null;
  } finally {
    await sys.close();
  }
}

// ---------------------------------------------------------------------------
// Invoices (mock + real)
// ---------------------------------------------------------------------------

export interface InvoiceSummary {
  id: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  created: number;
  hostedInvoiceUrl: string | null;
  number: string | null;
}

/**
 * Return the school's invoices. In mock mode we synthesize three "demo"
 * invoices so the UI can render the table. In real mode we ask Stripe.
 */
export async function listInvoicesForSchool(
  schoolId: string,
): Promise<InvoiceSummary[]> {
  // Customer id is required for the Stripe API; the portal route passes
  // it through if it's set, otherwise uses the env default. This function
  // is called from /api/billing/invoices which is authenticated, so we
  // need a real customer or fall back to the mock.
  const customerId = await getSchoolStripeCustomerId(schoolId);
  if (process.env.BILLING_PROVIDER === 'mock' || !customerId) {
    return mockInvoices(schoolId);
  }

  // Real path — use the billing-adapter's Stripe singleton via the
  // dynamic import. Pre-validate env first per memory rule.
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error(
      'STRIPE_SECRET_KEY required for listing real invoices. ' +
        'BILLING_PROVIDER=mock should be set in dev.',
    );
  }
  const { default: Stripe } = (await import('stripe')) as unknown as {
    default: new (key: string, config: { apiVersion: string }) => StripeClient;
  };
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });
  const list = await stripe.invoices.list({ customer: customerId, limit: 24 });
  return list.data.map((inv) => ({
    id: inv.id,
    amountDue: inv.amount_due ?? 0,
    amountPaid: inv.amount_paid ?? 0,
    currency: inv.currency ?? 'usd',
    status: inv.status ?? 'unknown',
    created: inv.created ?? 0,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    number: inv.number ?? null,
  }));
}

function mockInvoices(schoolId: string): InvoiceSummary[] {
  // Stable id derived from schoolId for test reproducibility.
  const baseId = `in_mock_${schoolId.slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      id: `${baseId}_0001`,
      amountDue: 0,
      amountPaid: 4900,
      currency: 'usd',
      status: 'paid',
      created: now - 30 * 86_400,
      hostedInvoiceUrl: 'http://localhost:3000/mock-stripe/invoice/1',
      number: 'MOCK-0001',
    },
    {
      id: `${baseId}_0002`,
      amountDue: 0,
      amountPaid: 4900,
      currency: 'usd',
      status: 'paid',
      created: now - 60 * 86_400,
      hostedInvoiceUrl: 'http://localhost:3000/mock-stripe/invoice/2',
      number: 'MOCK-0002',
    },
    {
      id: `${baseId}_0003`,
      amountDue: 4900,
      amountPaid: 0,
      currency: 'usd',
      status: 'open',
      created: now - 5 * 86_400,
      hostedInvoiceUrl: 'http://localhost:3000/mock-stripe/invoice/3',
      number: 'MOCK-0003',
    },
  ];
}

// ---------------------------------------------------------------------------
// System-DB singleton helpers (similar to db.server.ts#getDb)
// ---------------------------------------------------------------------------

/**
 * Open a fresh system-role Drizzle client. Caller MUST close it after
 * use. Used by:
 *   - `handleWebhookEvent` (one short-lived transaction per webhook)
 *   - `runDailyDowngradeFlip` (one short-lived transaction per cron tick)
 *   - Integration tests
 *
 * Why not cache the pool:
 *   - Each webhook call is a separate short-lived transaction. Caching
 *     the pool across calls means we never drain it on container
 *     shutdown; a leaked connection would block startup of a new
 *     replica. With open-per-call + close-per-call we get clean
 *     shutdown semantics at the cost of a small per-call overhead
 *     (postgres.js connection pool is fast to set up).
 */
function openSystemClient(): { db: Db; close: () => Promise<void> } {
  const url =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'billing.server: SYSTEM_DATABASE_URL or DATABASE_URL is not set. ' +
        'Export SYSTEM_DATABASE_URL=postgres://edusupervise_system:...',
    );
  }
  return getSystemClient(url, { max: 2 });
}

/** Test seam: no-op stub. (We don't cache the pool any more.) */
export function resetBillingSystemDb(): void {
  /* deprecated — open-per-call replaces the cached pool */
}

/** Test seam: no-op stub. (We don't cache the pool any more.) */
export function setBillingSystemDb(
  _db: { db: Db; close: () => Promise<void> } | null,
): void {
  /* deprecated */
}

// ---------------------------------------------------------------------------
// Ad-hoc: an HMAC signing helper used for the integration test mocks
// ---------------------------------------------------------------------------

/**
 * Build a synthetic Stripe `Stripe-Signature` header value compatible with
 * the billing-adapter's verifier when BILLING_PROVIDER=stripe.
 * Format: `t=<unix>,v1=<hex hmac>`.
 *
 * This is the lower-level primitive the test uses; production code
 * should never need to call it — Stripe sends pre-signed events.
 */
export function buildStripeV1Signature(rawBody: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Verify a freshly-built V1 signature (constant-time). */
export function verifyStripeV1SignatureInHouse(
  rawBody: string,
  header: string,
  secret: string,
): boolean {
  const parts = header.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1Part = parts.find((p) => p.startsWith('v1='));
  if (!tPart || !v1Part) return false;
  const t = tPart.slice(2);
  const v1 = v1Part.slice(3);
  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stub-interface for the Stripe SDK so we don't need to import it at
// module load. Both branches (mock + real) compile against this shape.
// ---------------------------------------------------------------------------

interface StripeClient {
  invoices: {
    list(params: {
      customer: string;
      limit?: number;
    }): Promise<{
      data: Array<{
        id: string;
        amount_due?: number | null;
        amount_paid?: number | null;
        currency?: string | null;
        status?: string | null;
        created?: number | null;
        hosted_invoice_url?: string | null;
        number?: string | null;
      }>;
    }>;
  };
}

/** Generate a random UUID v4 (used by test fixtures). */
export const newWebhookEventId = (): string => `evt_test_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

// silence the unused-import warning when only types are referenced
const _unused: AdapterPlan[] = ['free', 'pro', 'school'];
void _unused;
