/**
 * Tests for @edusupervise/billing-adapter.
 *
 * Covers:
 *  - mock: createCheckoutSession URL shape, createPortalSession URL, mock
 *    verifyWebhook accepts "mock" signature or X-Mock-Signature header.
 *  - stripe: throws clear STRIPE_SECRET_KEY error when key is missing.
 *  - stripe: when the SDK is mocked at the test level, the wrapper forwards
 *    and returns the real session/portal URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

process.env.BILLING_PROVIDER = 'mock';

import {
  createCheckoutSession,
  createPortalSession,
  verifyWebhook,
  currentProvider,
  __testing__ as billingTesting,
} from './index.js';

describe('billing adapter — mock', () => {
  beforeEach(() => {
    process.env.BILLING_PROVIDER = 'mock';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.unmock('stripe');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('default provider is mock when BILLING_PROVIDER is unset', () => {
    delete process.env.BILLING_PROVIDER;
    expect(currentProvider()).toBe('mock');
  });

  it('createCheckoutSession returns the documented URL shape', async () => {
    const result = await createCheckoutSession({
      schoolId: 'school-abc',
      plan: 'pro',
    });
    expect(result.sessionId).toMatch(/^cs_test_[0-9a-f-]{36}$/);
    expect(result.url).toMatch(
      new RegExp(
        `^${billingTesting.MOCK_PORTAL_BASE}\\?session=cs_test_[0-9a-f-]{36}&plan=pro&school=`,
      ),
    );
    expect(decodeURIComponent(result.url)).toContain('school-abc');
  });

  it('createCheckoutSession encodes the plan in the URL', async () => {
    const r1 = await createCheckoutSession({ schoolId: 's1', plan: 'free' });
    expect(r1.url).toContain('plan=free');
    const r2 = await createCheckoutSession({ schoolId: 's2', plan: 'school' });
    expect(r2.url).toContain('plan=school');
  });

  it('createPortalSession returns the documented mock URL', async () => {
    const result = await createPortalSession({ schoolId: 'school-abc' });
    expect(result.url).toBe('http://localhost:3000/mock-stripe/portal');
  });

  it('verifyWebhook accepts the "mock" signature', () => {
    const result = verifyWebhook({
      rawBody: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }),
      signature: 'mock',
    });
    expect(result.verified).toBe(true);
    expect((result.event as { id: string }).id).toBe('evt_1');
  });

  it('verifyWebhook accepts the X-Mock-Signature header', () => {
    const result = verifyWebhook({
      rawBody: JSON.stringify({ id: 'evt_2' }),
      signature: null,
      headers: { 'x-mock-signature': 'mock' },
    });
    expect(result.verified).toBe(true);
  });

  it('verifyWebhook rejects any other signature', () => {
    const result = verifyWebhook({
      rawBody: JSON.stringify({ id: 'evt_3' }),
      signature: 'definitely-not-mock',
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/mock signature missing/);
  });

  it('verifyWebhook rejects malformed JSON in mock mode', () => {
    const result = verifyWebhook({
      rawBody: 'not-json{',
      signature: 'mock',
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it('createCheckoutSession rejects empty schoolId', async () => {
    await expect(
      createCheckoutSession({ schoolId: '', plan: 'pro' }),
    ).rejects.toThrow(/`schoolId` is required/);
  });

  it('createPortalSession rejects empty schoolId', async () => {
    await expect(createPortalSession({ schoolId: '' })).rejects.toThrow(
      /`schoolId` is required/,
    );
  });

  it('throws on unknown BILLING_PROVIDER', async () => {
    process.env.BILLING_PROVIDER = 'square';
    await expect(
      createCheckoutSession({ schoolId: 's', plan: 'pro' }),
    ).rejects.toThrow(/Unknown BILLING_PROVIDER/);
  });
});

describe('billing adapter — stripe (env-driven failures)', () => {
  beforeEach(() => {
    process.env.BILLING_PROVIDER = 'stripe';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.unmock('stripe');
  });

  afterEach(() => {
    process.env.BILLING_PROVIDER = 'mock';
    vi.restoreAllMocks();
  });

  it('throws clear "STRIPE_SECRET_KEY required" when key missing', async () => {
    await expect(
      createCheckoutSession({ schoolId: 's', plan: 'pro' }),
    ).rejects.toThrow(/STRIPE_SECRET_KEY required/);
  });

  it('throws when STRIPE_PRICE_PRO is not configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    delete process.env.STRIPE_PRICE_PRO;
    await expect(
      createCheckoutSession({ schoolId: 's', plan: 'pro' }),
    ).rejects.toThrow(/STRIPE_PRICE_PRO not configured/);
  });

  it('uses the Stripe SDK when fully configured (checkout)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_PRICE_PRO = 'price_pro_xxx';

    const fakeCreate = vi.fn().mockResolvedValue({
      id: 'cs_test_real_abc',
      url: 'https://checkout.stripe.com/c/pay/cs_test_real_abc',
    });
    const FakeStripe = vi.fn().mockImplementation(() => ({
      checkout: { sessions: { create: fakeCreate } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    }));
    vi.doMock('stripe', () => ({ default: FakeStripe }));

    vi.resetModules();
    const mod = await import(`./index.js`);
    const result = await mod.createCheckoutSession({
      schoolId: 'school-real',
      plan: 'pro',
    });

    expect(result.sessionId).toBe('cs_test_real_abc');
    expect(result.url).toBe('https://checkout.stripe.com/c/pay/cs_test_real_abc');
    expect(FakeStripe).toHaveBeenCalledWith(
      'sk_test_xxx',
      expect.objectContaining({ apiVersion: expect.any(String) }),
    );
    const callArgs = fakeCreate.mock.calls[0]![0];
    expect(callArgs.mode).toBe('subscription');
    expect(callArgs.line_items).toEqual([{ price: 'price_pro_xxx', quantity: 1 }]);
    expect(callArgs.client_reference_id).toBe('school-real');
    expect(callArgs.metadata).toEqual({ schoolId: 'school-real', plan: 'pro' });
  });

  it('uses the Stripe SDK when fully configured (portal)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_DEFAULT_CUSTOMER_ID = 'cus_xxx';

    const fakePortalCreate = vi.fn().mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/test_abc',
    });
    const FakeStripe = vi.fn().mockImplementation(() => ({
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: fakePortalCreate } },
      webhooks: { constructEvent: vi.fn() },
    }));
    vi.doMock('stripe', () => ({ default: FakeStripe }));

    vi.resetModules();
    const mod = await import(`./index.js`);
    const result = await mod.createPortalSession({ schoolId: 'school-real' });
    expect(result.url).toBe('https://billing.stripe.com/p/session/test_abc');
    expect(fakePortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_xxx' }),
    );
  });

  it('throws when Stripe SDK returns no URL', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_PRICE_PRO = 'price_pro_xxx';

    const fakeCreate = vi.fn().mockResolvedValue({ id: 'cs_x', url: null });
    const FakeStripe = vi.fn().mockImplementation(() => ({
      checkout: { sessions: { create: fakeCreate } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    }));
    vi.doMock('stripe', () => ({ default: FakeStripe }));

    vi.resetModules();
    const mod = await import(`./index.js`);
    await expect(
      mod.createCheckoutSession({ schoolId: 's', plan: 'pro' }),
    ).rejects.toThrow(/did not return a URL/);
  });
});

describe('billing adapter — stripe webhook (signature)', () => {
  beforeEach(() => {
    process.env.BILLING_PROVIDER = 'stripe';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_xxx';
    vi.unmock('stripe');
  });

  afterEach(() => {
    process.env.BILLING_PROVIDER = 'mock';
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.restoreAllMocks();
  });

  it('rejects when signature is missing', () => {
    const result = verifyWebhook({ rawBody: '{}', signature: null });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/missing Stripe-Signature/);
  });

  it('rejects a malformed signature header', () => {
    const bad = verifyWebhook({ rawBody: '{}', signature: 'not-a-stripe-sig' });
    expect(bad.verified).toBe(false);
  });

  it('rejects a signature with the wrong HMAC', () => {
    const body = '{}';
    const t = Math.floor(Date.now() / 1000).toString();
    const bad = verifyWebhook({ rawBody: body, signature: `t=${t},v1=deadbeef` });
    expect(bad.verified).toBe(false);
  });

  it('verifies a valid Stripe v1 signature', () => {
    const body = JSON.stringify({ id: 'evt_test', type: 'ping' });
    const t = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', 'whsec_test_xxx')
      .update(`${t}.${body}`)
      .digest('hex');
    const good = verifyWebhook({ rawBody: body, signature: `t=${t},v1=${sig}` });
    expect(good.verified).toBe(true);
  });

  it('returns the parsed event payload (id + type) on a valid signature', () => {
    // Regression for audit B3: prior to this fix the helper returned
    // `{ id: '', type: '' }` on signature match, which made every real
    // Stripe webhook silently rejected by billing.server.ts because
    // `event.id || event.type` was empty.
    const event = {
      id: 'evt_real_1N2AbC3XyZ',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_real', customer: 'cus_real' } },
    };
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', 'whsec_test_xxx')
      .update(`${t}.${body}`)
      .digest('hex');
    const result = verifyWebhook({
      rawBody: body,
      signature: `t=${t},v1=${sig}`,
    });
    expect(result.verified).toBe(true);
    const parsed = result.event as { id: string; type: string; data?: unknown };
    expect(parsed.id).toBe('evt_real_1N2AbC3XyZ');
    expect(parsed.type).toBe('checkout.session.completed');
    expect(parsed.data).toBeDefined();
  });

  it('rejects a valid signature whose timestamp is older than tolerance', () => {
    // Audit #14 HIGH: replay protection at signature layer. STRIPE_TOLERANCE_SEC
    // defaults to 300s (5 min, matching Stripe SDK). A captured webhook from
    // an hour ago should be rejected even if the HMAC is valid.
    const body = JSON.stringify({ id: 'evt_old', type: 'ping' });
    const oldT = (Math.floor(Date.now() / 1000) - 7200).toString(); // 2h ago
    const sig = createHmac('sha256', 'whsec_test_xxx')
      .update(`${oldT}.${body}`)
      .digest('hex');
    const result = verifyWebhook({
      rawBody: body,
      signature: `t=${oldT},v1=${sig}`,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('accepts a valid signature within tolerance window', () => {
    // Edge: timestamp exactly 60s old, well within default 300s.
    const body = JSON.stringify({ id: 'evt_recent', type: 'ping' });
    const recentT = (Math.floor(Date.now() / 1000) - 60).toString();
    const sig = createHmac('sha256', 'whsec_test_xxx')
      .update(`${recentT}.${body}`)
      .digest('hex');
    const result = verifyWebhook({
      rawBody: body,
      signature: `t=${recentT},v1=${sig}`,
    });
    expect(result.verified).toBe(true);
  });

  it('rejects a valid signature whose body has no id/type', () => {
    // The Stripe SDK's constructEvent rejects payloads that don't
    // include a real `id` and `type`; mirror that behavior so the
    // handler can rely on the guard at billing.server.ts:170-172.
    const body = JSON.stringify({ data: { object: {} } });
    const t = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', 'whsec_test_xxx')
      .update(`${t}.${body}`)
      .digest('hex');
    const result = verifyWebhook({
      rawBody: body,
      signature: `t=${t},v1=${sig}`,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('rejects a valid signature over a non-JSON body', () => {
    const body = 'not-json{';
    const t = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', 'whsec_test_xxx')
      .update(`${t}.${body}`)
      .digest('hex');
    const result = verifyWebhook({
      rawBody: body,
      signature: `t=${t},v1=${sig}`,
    });
    expect(result.verified).toBe(false);
  });

  it('throws clear error when STRIPE_WEBHOOK_SECRET missing', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() =>
      verifyWebhook({ rawBody: '{}', signature: 't=1,v1=zzz' }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET required/);
  });
});