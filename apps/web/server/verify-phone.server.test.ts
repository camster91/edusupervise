// apps/web/server/verify-phone.server.test.ts — regression tests for
// the NODE_ENV gate around the Twilio Verify dev fallback (audit B2,
// 2026-07-04 — dev fallback previously accepted the fixed code 123456
// in any environment, including production if Twilio env vars were
// missing for any reason).
//
// What's being guarded:
//   - dev (NODE_ENV !== 'production'): the dev fallback works —
//     sendVerificationCode returns true without throwing, and
//     verifyCode accepts "123456" and rejects anything else.
//   - production + no Twilio creds: sendVerificationCode throws,
//     verifyCode throws. The throw is the loud failure mode the B2
//     fix introduced; previously these paths silently accepted
//     arbitrary codes.
//   - production + creds: the function path-throughs the stub
//     behaviour (returns true for send, false for verify) — the
//     real Twilio wiring is a Tier 2 TODO and the test should NOT
//     pin that future behaviour.
//
// Note: process.env.NODE_ENV is mutated by individual tests. Each
// test restores it in afterEach to keep the suite independent.

import { describe, it, expect, afterEach, vi } from 'vitest';

// Re-import each test body so the module-level NODE_ENV evaluation
// happens fresh per test. We use vi.resetModules() + dynamic import
// so the requireTwilioCredsInProduction() guard reads the
// currently-set env vars rather than the module-load snapshot.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_TWILIO = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID,
};

afterEach(() => {
  // Restore env so the next test sees a clean slate.
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  for (const [k, v] of Object.entries(ORIGINAL_TWILIO)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

interface VerifyPhoneModule {
  sendVerificationCode: (phone: string) => Promise<boolean>;
  verifyCode: (phone: string, code: string) => Promise<boolean>;
}

async function loadFresh(): Promise<VerifyPhoneModule> {
  vi.resetModules();
  return (await import('./verify-phone.server.js')) as unknown as VerifyPhoneModule;
}

describe('verify-phone NODE_ENV gate (B2 regression guard)', () => {
  it('dev: sendVerificationCode returns true without throwing (dev fallback logs the code)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    const { sendVerificationCode } = await loadFresh();
    await expect(sendVerificationCode('+14165551234')).resolves.toBe(true);
  });

  it('dev: verifyCode accepts "123456" via the dev fallback', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    const { verifyCode } = await loadFresh();
    await expect(verifyCode('+14165551234', '123456')).resolves.toBe(true);
  });

  it('dev: verifyCode rejects any code other than "123456"', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    const { verifyCode } = await loadFresh();
    await expect(verifyCode('+14165551234', '654321')).resolves.toBe(false);
    await expect(verifyCode('+14165551234', '')).resolves.toBe(false);
  });

  it('production + no Twilio creds: sendVerificationCode throws (loud failure)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    const { sendVerificationCode } = await loadFresh();
    // The B2 fix throws a descriptive error. The route catches it
    // and returns 503, so this throw is the failure signal that
    // wakes on-call rather than silently bypassing phone verify.
    await expect(sendVerificationCode('+14165551234')).rejects.toThrow(
      /TWILIO_ACCOUNT_SID.*production/i,
    );
  });

  it('production + no Twilio creds: verifyCode throws (loud failure)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    const { verifyCode } = await loadFresh();
    // The pre-fix code would have returned true for "123456" here —
    // full account-takeover path. The post-fix throws.
    await expect(verifyCode('+14165551234', '123456')).rejects.toThrow(
      /TWILIO_ACCOUNT_SID.*production/i,
    );
  });

  it('production + Twilio creds: sendVerificationCode path-throughs the stub (returns true)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'testtoken';
    process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtestservice';

    const { sendVerificationCode } = await loadFresh();
    // Tier 1 stub: real Twilio wiring is a TODO, so the function
    // logs a warn and returns true. This test pins that contract so
    // a future real-wiring PR can update the assertion.
    await expect(sendVerificationCode('+14165551234')).resolves.toBe(true);
  });

  it('production + Twilio creds: verifyCode path-throughs the stub (returns false)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'testtoken';
    process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtestservice';

    const { verifyCode } = await loadFresh();
    // Tier 1 stub: returns false because the real Twilio Verify API
    // call isn't wired yet. This is a deliberate "no-op until tier
    // 2" — the test prevents a refactor from silently flipping the
    // behaviour to "always true".
    await expect(verifyCode('+14165551234', '123456')).resolves.toBe(false);
  });
});