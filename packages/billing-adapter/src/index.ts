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
 *
 * FAIL-CLOSED semantics (audit 2026-07-21):
 *   - The default provider is NO LONGER 'mock'. When BILLING_PROVIDER is
 *     unset or empty we resolve to 'stripe' and require STRIPE_SECRET_KEY.
 *     This prevents a misconfigured prod deploy from silently running
 *     against the mock layer (which would issue bogus checkout URLs and
 *     accept the literal signature 'mock' on webhooks — both producing
 *     valid-looking but financially meaningless state mutations).
 *   - The 'mock' provider is only honoured when NODE_ENV !== 'production'
 *     AND BILLING_PROVIDER is explicitly 'mock'. In production an
 *     explicit BILLING_PROVIDER=mock is rejected with a hard error so a
 *     deploy cannot accidentally ship with the mock layer wired up.
 *   - The mock webhook verifier additionally requires ALLOW_MOCK_WEBHOOK=1
 *     to accept the literal 'mock' signature. ALLOW_MOCK_WEBHOOK must
 *     only be set in dev/test — production deploys that mistakenly route
 *     through the mock will get verification failures instead of silent
 *     acceptance.
 *
 * Net effect: a production deploy that forgets to set BILLING_PROVIDER
 * (or sets it to 'mock') fails closed — checkout/portal/webhook throw or
 * 403 instead of pretending to succeed against the mock layer.
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

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolve the active provider.
 *
 * Precedence:
 *   1. BILLING_PROVIDER unset/empty → 'stripe' (fail-closed default).
 *   2. BILLING_PROVIDER='mock'      → 'mock', but only outside production.
 *      In production this is a hard error — mock billing must never
 *      run against real traffic.
 *   3. BILLING_PROVIDER='stripe'    → 'stripe'.
 *   4. Any other value              → throws Unknown BILLING_PROVIDER.
 *
 * Tests that need the mock layer explicitly set
 *   BILLING_PROVIDER=mock NODE_ENV=test
 * before importing this module. The previous default of 'mock' (which
 * silently turned a missing env var into a money-leaking prod deploy)
 * is removed.
 */
function resolveProvider(): BillingProvider {
  const raw = (process.env.BILLING_PROVIDER ?? '').toLowerCase();
  if (raw === '') {
    // Fail-closed: an unset provider defaults to stripe, which in turn
    // requires STRIPE_SECRET_KEY. A misconfigured prod deploy surfaces
    // a clear "STRIPE_SECRET_KEY required" error instead of silently
    // running against the mock layer.
    return 'stripe';
  }
  if (raw === 'mock') {
    if (isProduction()) {
      throw new Error(
        'BILLING_PROVIDER=mock is forbidden in production. ' +
          'Unset the variable (default is now stripe) or set it explicitly to "stripe".',
      );
    }
    return 'mock';
  }
  if (raw === 'stripe') return 'stripe';
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
  //
  // FAIL-CLOSED guard (audit 2026-07-21): the literal 'mock' signature is
  // only honoured when ALLOW_MOCK_WEBHOOK=1 is set in the environment.
  // This is a second line of defence on top of the BILLING_PROVIDER=mock
  // production block: even if a deploy somehow routed through the mock
  // (e.g. via a non-production NODE_ENV in a staging environment that
  // shares billing routes), the webhook verifier will refuse to accept
  // the signature unless the operator has explicitly opted in via the
  // env var. ALLOW_MOCK_WEBHOOK must never be set in real production.
  if (process.env.ALLOW_MOCK_WEBHOOK !== '1') {
    return {
      verified: false,
      reason:
        'mock webhook verification disabled (set ALLOW_MOCK_WEBHOOK=1 in dev/test only)',
    };
  }
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
  data?: { object?: Record<string, unknown> };
  [key: string]: unknown;
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
  // Replay protection: reject signatures whose timestamp is older than the
  // configured tolerance (default 5 min, matching Stripe SDK default).
  // Defense-in-depth on top of stripe_events.id UNIQUE constraint.
  const toleranceSec = Number(process.env.STRIPE_TOLERANCE_SEC ?? 300);
  const tNum = Number(t);
  // Replay window: reject signatures older than toleranceSec AND signatures
  // dated more than toleranceSec in the future. Using abs() would let an
  // attacker who captured a fresh, valid Stripe signature mutate the header
  // `t` to `now + toleranceSec` — the body HMACs the same `${t}.${rawBody}`,
  // so the attacker gets a future-dated replay window. Audit 2026-07-22 P1-2.
  const skew = Date.now() / 1000 - tNum;
  if (!Number.isFinite(skew) || !Number.isInteger(tNum)) return null;
  if (skew < -toleranceSec || skew > toleranceSec) return null;
  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  // Signature verified — now parse the body so the caller sees a real
  // event (with id + type) rather than an empty stub. The Stripe SDK's
  // constructEvent does this for us in the async path; we mirror that
  // here for the sync HMAC path.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as { id?: unknown; type?: unknown };
  if (typeof event.id !== 'string' || typeof event.type !== 'string') return null;
  if (!event.id || !event.type) return null;
  // Return the full parsed payload (downstream reads event.data.object in
  // billing.server.ts:applyStripeEvent). The StripeWebhookEvent interface
  // above lists id/type/data but [key:string]unknown admits extras.
  return event as unknown as StripeWebhookEvent;
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
  assertMockAllowedInThisEnv('createCheckoutSession');
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
  assertMockAllowedInThisEnv('createPortalSession');
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
  // Note: production mock gating happens in resolveProvider() — a
  // BILLING_PROVIDER=mock deploy will throw at resolveProvider() call
  // time, well before we reach here. The per-function guards below
  // additionally require ALLOW_MOCK_BILLING=1 so that even a non-prod
  // environment (CI, local, staging) has to opt in explicitly.
  assertMockAllowedInThisEnv('verifyWebhook');
  return resolveProvider() === 'mock'
    ? verifyMockWebhook(input)
    : verifyRealWebhook(input);
}

/**
 * Hard-stop guard at every public entry point: refuse to dispatch into
 * the mock layer unless the operator has explicitly opted in via
 * ALLOW_MOCK_BILLING=1 (for checkout/portal) or ALLOW_MOCK_WEBHOOK=1
 * (for webhooks). The env-var split lets a deploy open checkout while
 * still rejecting mock webhooks, or vice versa. Both default to off.
 *
 * Production deploys MUST NOT set either variable. resolveProvider()
 * already throws on BILLING_PROVIDER=mock in production, so this guard
 * is a belt-and-suspenders for the BILLING_PROVIDER=stripe-but-test-routed
 * case (e.g. a staging env with NODE_ENV=staging that intentionally
 * exercises the mock layer).
 */
function assertMockAllowedInThisEnv(apiName: string): void {
  if (resolveProvider() !== 'mock') return; // stripe path — always fine
  const required =
    apiName === 'verifyWebhook' ? 'ALLOW_MOCK_WEBHOOK' : 'ALLOW_MOCK_BILLING';
  if (process.env[required] !== '1') {
    throw new Error(
      `${apiName}: mock billing path requires ${required}=1 in this environment. ` +
        `Set it explicitly in dev/test; never in production.`,
    );
  }
}

// Test-only exports
export const __testing__ = {
  MOCK_PORTAL_BASE,
  verifyStripeV1Signature,
  resolveProvider,
};

export { currentProvider };