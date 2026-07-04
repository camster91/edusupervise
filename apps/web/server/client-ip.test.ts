/**
 * Tests for the safe clientIp helper (audit S-S2).
 *
 * Verifies:
 *  - TRUST_PROXY unset → XFF ignored, returns 'unknown'
 *  - TRUST_PROXY=1     → reads leftmost XFF entry (the original client)
 *  - TRUST_PROXY=1     → falls back to X-Real-IP when XFF absent
 *  - TRUST_PROXY=1     → returns 'unknown' when both headers absent
 *  - TRUST_PROXY unset → does NOT trust attacker-supplied XFF
 *  - Malformed XFF     → safe (no throw)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadClientIp() {
  // Re-import every test so the module-level TRUST_PROXY const picks
  // up the env var we set in beforeEach. Without resetModules the const
  // would be frozen at first-load time.
  vi.resetModules();
  return await import('./client-ip.server.js');
}

describe('clientIp helper (S-S2)', () => {
  let savedTrustProxy: string | undefined;

  beforeEach(() => {
    savedTrustProxy = process.env.TRUST_PROXY;
  });

  afterEach(() => {
    if (savedTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = savedTrustProxy;
    }
    vi.resetModules();
  });

  it('returns "unknown" when TRUST_PROXY is unset, even with XFF', async () => {
    delete process.env.TRUST_PROXY;
    const { clientIp } = await loadClientIp();
    const req = new Request('https://x.test/login', {
      headers: {
        'x-forwarded-for': '203.0.113.5',
        'x-real-ip': '203.0.113.5',
      },
    });
    expect(clientIp(req)).toBe('unknown');
  });

  it('returns "unknown" when TRUST_PROXY=0, even with XFF', async () => {
    process.env.TRUST_PROXY = '0';
    const { clientIp } = await loadClientIp();
    const req = new Request('https://x.test/login', {
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    expect(clientIp(req)).toBe('unknown');
  });

  it('returns leftmost XFF when TRUST_PROXY=1', async () => {
    process.env.TRUST_PROXY = '1';
    const { clientIp } = await loadClientIp();
    const req = new Request('https://x.test/login', {
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.0.1, 172.17.0.2',
      },
    });
    expect(clientIp(req)).toBe('203.0.113.5');
  });

  it('falls back to X-Real-IP when TRUST_PROXY=1 and XFF absent', async () => {
    process.env.TRUST_PROXY = '1';
    const { clientIp } = await loadClientIp();
    const req = new Request('https://x.test/login', {
      headers: { 'x-real-ip': '198.51.100.42' },
    });
    expect(clientIp(req)).toBe('198.51.100.42');
  });

  it('returns "unknown" when TRUST_PROXY=1 but no proxy headers', async () => {
    process.env.TRUST_PROXY = '1';
    const { clientIp } = await loadClientIp();
    const req = new Request('https://x.test/login');
    expect(clientIp(req)).toBe('unknown');
  });

  it('trims whitespace from the XFF entry', async () => {
    process.env.TRUST_PROXY = '1';
    const { clientIp } = await loadClientIp();
    const req = new Request('https://x.test/login', {
      headers: { 'x-forwarded-for': '   203.0.113.99   , 10.0.0.1' },
    });
    expect(clientIp(req)).toBe('203.0.113.99');
  });

  it('does not throw on malformed header values', async () => {
    process.env.TRUST_PROXY = '1';
    const { clientIp } = await loadClientIp();
    const req = new Request('https://x.test/login', {
      headers: { 'x-forwarded-for': '' },
    });
    expect(clientIp(req)).toBe('unknown');
  });
});