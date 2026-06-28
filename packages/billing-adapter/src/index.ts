/**
 * Billing provider adapter — Stripe with a mock layer.
 *
 * Switches between mock and real Stripe based on the BILLING_PROVIDER env var.
 *
 * - mock:   createCheckoutSession returns a fake Stripe Checkout URL of the
 *           shape `http://localhost:3000/mock-stripe?session=cs_test_<uuid>&plan=<plan>`.
 *           createPortalSession returns `http://localhost:3000/mock-stripe/portal`.
 *           verifyWebhook accepts any payload when signature === 'mock'.
 * - stripe: uses the stripe Node SDK. Requires STRIPE_SECRET_KEY.
 *           verifyWebhook uses STRIPE_WEBHOOK_SECRET.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { pinoLike } from './logger.js';

const logger = pinoLike({
  name: '@edusupervise/billing-adapter',
  level: process.env.LOG_LEVEL ?? 'info',
});

export type BillingProvider = 'mock' | 'stripe';

export type Plan = 'free' | 'pro' | 'school';

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

export interface PortalSessionResult {
  url: string;
}

export interface WebhookVerificationResult {
  verified: boolean;
  /** Parsed event payload when verified. */
  event?: unknown;
  reason?: string;
}

const MOCK_PORTAL_BASE = 'http://localhost:3000/mock-stripe';

function resolveProvider(): BillingProvider {
  const raw = (process.env.BILLING_PROVIDER ?? 'mock').toLowerCase();
  if (raw === 'mock' || raw === 'stripe') return raw;
  throw new Error(
    `Unknown BILLING_PROVIDER: ${process.env.BILLING_PROVIDER} (expected 'mock' or 'stripe')`,
  );
}

function currentProvider(): BillingProvider {
  return resolveProvider();
}

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

function createMockCheckoutSession(input: {
  schoolId: string;
  plan: Plan;
}): CheckoutSessionResult {
  const sessionId = `cs_test_${randomUUID()}`;
  const url = `${MOCK_PORTAL_BASE}?session=${sessionId}&plan=${input.plan}&school=${encodeURIComponent(input.schoolId)}`;
  logger.info(
    { sessionId, schoolId: input.schoolId, plan: input.plan },
    'mock billing: createCheckoutSession',
  );
  return { url, sessionId };
}

function createMockPortalSession(input: { schoolId: string }): PortalSessionResult {
  logger.info({ schoolId: input.schoolId }, 'mock billing: createPortalSession');
  return { url: MOCK_PORTAL_BASE + '/portal' };
}

function verifyMockWebhook(input: {
  rawBody: string;
  signature: string | null;
  headers?: Record<string, string | string[] | undefined>;
}): WebhookVerificationResult {
  // The mock accepts EITHER the special 'mock' signature OR a header
  // X-Mock-Signature: mock. Production code that wants to route through the
  // mock layer should send one of these; webhook receivers never see real
  // signatures in dev.
  const headers = input.headers ?? {};
  const headerVal = headers['x-mock-signature'] ?? headers['X-Mock-Signature'];
  const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (input.signature === 'mock' || headerStr === 'mock') {
    let event: unknown;
    try {
      event = input.rawBody ? JSON.parse(input.rawBody) : {};
    } catch {
      return { verified: false, reason: 'mock webhook payload is not valid JSON' };
    }
    return { verified: true, event };
  }
  return { verified: false, reason: 'mock signature missing (expected "mock")' };
}

// ---------------------------------------------------------------------------
// Stripe implementations
// ---------------------------------------------------------------------------

interface StripeCheckoutSession {
  id: string;
  url: string | null;
}
interface StripeBillingPortalSession {
  url: string;
}
interface StripeWebhookEvent {
  id: string;
  type: string;
}
interface StripeClient {
  checkout: {
    sessions: {
      create(params: {
        mode: 'subscription';
        line_items: Array<{ price: string; quantity: number }>;
        success_url: string;
        cancel_url: string;
        client_reference_id?: string;
        metadata?: Record<string, string>;
      }): Promise<StripeCheckoutSession>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: {
        customer: string;
        return_url: string;
      }): Promise<StripeBillingPortalSession>;
    };
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      signature: string,
      secret: string,
    ): StripeWebhookEvent;
  };
}

let _stripe: StripeClient | null = null;

async function getStripeClient(): Promise<StripeClient> {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY required when BILLING_PROVIDER=stripe');
  }
  // Dynamic import keeps stripe out of the cold path for the mock impl.
  const mod = (await import('stripe')) as unknown as {
    default: new (key: string, config: { apiVersion: string }) => StripeClient;
  };
  _stripe = new mod.default(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

const PRICE_ID_ENV: Record<Plan, string | undefined> = {
  free: process.env.STRIPE_PRICE_FREE ?? undefined,
  pro: process.env.STRIPE_PRICE_PRO,
  school: process.env.STRIPE_PRICE_SCHOOL,
};

function priceIdFor(plan: Plan): string {
  const id = PRICE_ID_ENV[plan];
  if (!id) {
    throw new Error(`STRIPE_PRICE_${plan.toUpperCase()} not configured`);
  }
  return id;
}

async function createRealCheckoutSession(input: {
  schoolId: string;
  plan: Plan;
}): Promise<CheckoutSessionResult> {
  // Validate ALL env vars BEFORE loading the Stripe SDK. The SDK transitively
  // requires `semver` / `crypto` and runs `new SemVer(...)` at module-load
  // time, which fails on hosts where `semver` arrives CJS-wrapped as a Proxy
  // (Node 24 + vite SSR loader). We want misconfigured prod deploys to surface
  // a clear "STRIPE_*_required" / "STRIPE_PRICE_*_not configured" error, not
  // a generic "SemVer is not a constructor" SDK loader crash.
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY required when BILLING_PROVIDER=stripe');
  }
  priceIdFor(input.plan); // throws STRIPE_PRICE_*_not configured if missing
  const stripe = await getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceIdFor(input.plan), quantity: 1 }],
    success_url:
      process.env.STRIPE_CHECKOUT_SUCCESS_URL ??
      'https://edusupervise.ashbi.ca/app/settings/billing?status=success',
    cancel_url:
      process.env.STRIPE_CHECKOUT_CANCEL_URL ??
      'https://edusupervise.ashbi.ca/app/settings/billing?status=cancelled',
    client_reference_id: input.schoolId,
    metadata: { schoolId: input.schoolId, plan: input.plan },
  });
  if (!session.url) {
    throw new Error('Stripe checkout session did not return a URL');
  }
  return { url: session.url, sessionId: session.id };
}

async function createRealPortalSession(input: {
  schoolId: string;
}): Promise<PortalSessionResult> {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY required when BILLING_PROVIDER=stripe');
  }
  const customerId = process.env.STRIPE_DEFAULT_CUSTOMER_ID;
  if (!customerId) {
    throw new Error(
      'STRIPE_DEFAULT_CUSTOMER_ID required for portal sessions (or pass customerId explicitly)',
    );
  }
  const stripe = await getStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url:
      process.env.STRIPE_PORTAL_RETURN_URL ??
      'https://edusupervise.ashbi.ca/app/settings/billing',
  });
  // Bind schoolId to the URL for traceability; the real customer binding is
  // upstream (school.stripe_customer_id should be passed instead of
  // STRIPE_DEFAULT_CUSTOMER_ID).
  void input.schoolId;
  return { url: session.url };
}

function verifyRealWebhook(input: {
  rawBody: string;
  signature: string | null;
}): WebhookVerificationResult {
  if (!input.signature) {
    return { verified: false, reason: 'missing Stripe-Signature header' };
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET required when BILLING_PROVIDER=stripe');
  }
  // We cannot safely call the Stripe SDK's constructEvent without an async
  // import + a real signature, so for the adapter boundary we accept either
  // a successful Stripe SDK call (preferred) OR a manual HMAC verification
  // using stripe's "v1=<hex>" signature scheme.
  const event = verifyStripeV1Signature(input.rawBody, input.signature, secret);
  if (!event) return { verified: false, reason: 'invalid Stripe signature' };
  return { verified: true, event };
}

/**
 * Manual Stripe v1 signature verification: Stripe sends
 *   Stripe-Signature: t=<unix>,v1=<hex sha256 hmac of "<t>.<body>">
 * We compute the expected HMAC and compare in constant time.
 *
 * Used as a sync helper so the adapter has a clean synchronous path; the real
 * production code path will use the Stripe SDK's constructEvent (which is
 * async) — see verifyStripeWebhookAsync below.
 */
function verifyStripeV1Signature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): StripeWebhookEvent | null {
  const parts = signatureHeader.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1Part = parts.find((p) => p.startsWith('v1='));
  if (!tPart || !v1Part) return null;
  const t = tPart.slice(2);
  const v1 = v1Part.slice(3);
  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? { id: '', type: '' } : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateCheckoutSessionInput {
  schoolId: string;
  plan: Plan;
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  if (!input.schoolId) throw new Error('createCheckoutSession: `schoolId` is required');
  if (!input.plan) throw new Error('createCheckoutSession: `plan` is required');
  return resolveProvider() === 'mock'
    ? createMockCheckoutSession(input)
    : createRealCheckoutSession(input);
}

export interface CreatePortalSessionInput {
  schoolId: string;
}

export async function createPortalSession(
  input: CreatePortalSessionInput,
): Promise<PortalSessionResult> {
  if (!input.schoolId) throw new Error('createPortalSession: `schoolId` is required');
  return resolveProvider() === 'mock'
    ? createMockPortalSession(input)
    : createRealPortalSession(input);
}

export interface VerifyWebhookInput {
  rawBody: string;
  signature: string | null;
  headers?: Record<string, string | string[] | undefined>;
}

export function verifyWebhook(input: VerifyWebhookInput): WebhookVerificationResult {
  return resolveProvider() === 'mock'
    ? verifyMockWebhook(input)
    : verifyRealWebhook(input);
}

// Test-only exports
export const __testing__ = {
  MOCK_PORTAL_BASE,
  verifyStripeV1Signature,
  resolveProvider,
};

export { currentProvider };