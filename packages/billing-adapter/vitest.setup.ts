// Vitest setup for billing-adapter — no mock log paths needed here; just pin
// the provider to mock by default so accidental `verifyWebhook()` calls in
// other test files don't trip on the strict Stripe env requirements.
process.env.BILLING_PROVIDER = 'mock';