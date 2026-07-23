// Vitest setup for billing-adapter.
//
// Pin the provider to mock AND opt in to the mock layer via the explicit
// ALLOW_MOCK_* env vars. The fail-closed guard in src/index.ts refuses
// to dispatch into the mock layer unless these are set, so existing
// tests that exercise the mock layer must turn them on. Tests that want
// the strict env behaviour (refuses mock unless opted in) clear them
// in their own beforeEach.
//
// NODE_ENV is pinned to 'test' so the production BLOCK on
// BILLING_PROVIDER=mock never trips. Tests that exercise the
// production-time block set NODE_ENV='production' explicitly.
process.env.BILLING_PROVIDER = 'mock';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.ALLOW_MOCK_BILLING = '1';
process.env.ALLOW_MOCK_WEBHOOK = '1';