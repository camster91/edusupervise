// apps/web/server/csrf.server.test.ts
//
// Tests for the CSRF defense layer. These tests pin:
//   - Layer 1.5 (Sec-Fetch-Site: same-origin/none required for browsers)
//   - Layer 1   (Origin/Referer matching, null Origin honored for native)
//   - Layer 2   (double-submit cookie + header/form/json body token)
//   - requireOrigin option (web = true default; native = opt-out)
//
// Audit 2026-07-22 P2-1: the XSS → push-token-hijack escalation chain
// depended on the validator accepting requests with no Origin header
// AND a stolen double-submit cookie. With requireOrigin defaulting to
// true on web routes, a same-origin XSS page can no longer bypass
// Layer 1 by omitting Origin entirely.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  validateCsrf,
  validateCsrfFromJson,
  validateCsrfWithFormToken,
} from './csrf.server';

const TOKEN = 'a'.repeat(64);

async function readJsonBody(response: { body: unknown }): Promise<unknown> {
  // Node's undici returns a Web ReadableStream; the `body` exposed via
  // the Response shape depends on the runtime. Read it to text and parse.
  const r = response as unknown as { text: () => Promise<string> };
  const text = await r.text();
  return JSON.parse(text);
}

async function expectForbiddenReason(
  r: { ok: false; response: Response },
  reason: string,
): Promise<void> {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.response.status).toBe(403);
  const body = await readJsonBody(r.response);
  expect(body).toMatchObject({
    error: 'csrf_failed',
    detail: reason,
  });
}

function requestWith(headers: Record<string, string>, body?: unknown): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { host: 'edusupervise.ashbi.ca', ...headers },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!('content-type' in headers)) {
      (init.headers as Record<string, string>)['content-type'] =
        typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json';
    }
  }
  return new Request('https://edusupervise.ashbi.ca/api/test', init);
}

function withCsrf(headers: Record<string, string> = {}): Record<string, string> {
  return {
    origin: 'https://edusupervise.ashbi.ca',
    cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
    ...headers,
  };
}

beforeEach(() => {
  delete process.env.APP_URL;
});

describe('validateCsrf — Layer 1.5 (Sec-Fetch-Site)', () => {
  it('rejects cross-site fetch (audit P2-1: browser-honest XSS escalation)', async () => {
    const req = requestWith({
      ...withCsrf(),
      'sec-fetch-site': 'cross-site',
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(false);
    if (!r.ok) await expectForbiddenReason(r, 'sec_fetch_site_cross_site');
  });

  it('accepts same-origin Sec-Fetch-Site', async () => {
    const req = requestWith({
      ...withCsrf(),
      'sec-fetch-site': 'same-origin',
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(true);
  });

  it('accepts none Sec-Fetch-Site (e.g. document navigation)', async () => {
    const req = requestWith({
      ...withCsrf(),
      'sec-fetch-site': 'none',
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(true);
  });

  it('passes through non-browser clients (no Sec-Fetch-Site)', async () => {
    // curl, server-to-server, native clients all omit this header.
    const req = requestWith({
      ...withCsrf(),
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(true);
  });
});

describe('validateCsrf — requireOrigin option (default = true)', () => {
  it('rejects a web request with no Origin AND no Referer', async () => {
    // XSS-style escalation: the page knows the cookie + the token but
    // omits Origin. Before P2-1 this passed; after the fix it doesn't.
    const req = requestWith({
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(false);
    if (!r.ok) await expectForbiddenReason(r, 'missing_origin');
  });

  it('accepts native `Origin: null` (allowed by originMatches)', async () => {
    // RFC 6454 §7: native-app fetch() sends literal Origin: null.
    // Layer-1 originMatches allows this; Layer 2 (cookie + token) still binds.
    const req = requestWith({
      origin: 'null',
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(true);
  });

  it('accepts no-Origin when caller passes requireOrigin: false', async () => {
    // Use case: api.mobile.push.* routes opt out explicitly.
    const req = requestWith({
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req, { requireOrigin: false });
    expect(r.ok).toBe(true);
  });
});

describe('validateCsrf — Layer 1 (Origin/Referer match)', () => {
  it('rejects a different-origin POST', async () => {
    const req = requestWith({
      origin: 'https://evil.example',
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(false);
    if (!r.ok) await expectForbiddenReason(r, 'origin_mismatch');
  });

  it('accepts a referer that matches host', async () => {
    const req = requestWith({
      referer: 'https://edusupervise.ashbi.ca/app/today',
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(true);
  });

  it('rejects a referer with a different host', async () => {
    const req = requestWith({
      referer: 'https://evil.example/x',
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(false);
  });

  it('accepts APP_URL as an allowed host', async () => {
    process.env.APP_URL = 'https://app.edusupervise.ca';
    const req = requestWith({
      origin: 'https://app.edusupervise.ca',
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(true);
  });
});

describe('validateCsrf — Layer 2 (double-submit)', () => {
  it('rejects when cookie is missing', async () => {
    const req = requestWith({
      origin: 'https://edusupervise.ashbi.ca',
      [CSRF_HEADER_NAME]: TOKEN,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(false);
    if (!r.ok) await expectForbiddenReason(r, 'missing_token');
  });

  it('rejects when header token is missing', async () => {
    const req = requestWith({
      origin: 'https://edusupervise.ashbi.ca',
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(false);
  });

  it('rejects when header token does not equal cookie token', async () => {
    const req = requestWith({
      origin: 'https://edusupervise.ashbi.ca',
      cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
      [CSRF_HEADER_NAME]: 'b'.repeat(64),
    });
    const r = validateCsrf(req);
    expect(r.ok).toBe(false);
    if (!r.ok) await expectForbiddenReason(r, 'token_mismatch');
  });
});

describe('validateCsrfWithFormToken — form-submit variant', () => {
  it('accepts a form POST with matching cookie + form csrf field', async () => {
    const fd = new FormData();
    fd.set('csrf', TOKEN);
    const req = requestWith(
      { origin: 'https://edusupervise.ashbi.ca', cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      fd,
    );
    const r = validateCsrfWithFormToken(req, fd);
    expect(r.ok).toBe(true);
  });

  it('rejects when Sec-Fetch-Site is cross-site', async () => {
    const fd = new FormData();
    fd.set('csrf', TOKEN);
    const req = requestWith(
      {
        origin: 'https://edusupervise.ashbi.ca',
        cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
        'sec-fetch-site': 'cross-site',
      },
      fd,
    );
    const r = validateCsrfWithFormToken(req, fd);
    expect(r.ok).toBe(false);
  });

  it('rejects a form POST with no Origin (web route default)', async () => {
    const fd = new FormData();
    fd.set('csrf', TOKEN);
    const req = requestWith(
      { cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      fd,
    );
    const r = validateCsrfWithFormToken(req, fd);
    expect(r.ok).toBe(false);
    if (!r.ok) await expectForbiddenReason(r, 'missing_origin');
  });

  it('rejects mismatched cookie + form csrf', async () => {
    const fd = new FormData();
    fd.set('csrf', 'b'.repeat(64));
    const req = requestWith(
      { origin: 'https://edusupervise.ashbi.ca', cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      fd,
    );
    const r = validateCsrfWithFormToken(req, fd);
    expect(r.ok).toBe(false);
  });
});

describe('validateCsrfFromJson — JSON-body variant', () => {
  it('accepts a JSON body with matching cookie + body.csrf', async () => {
    const req = requestWith(
      { origin: 'https://edusupervise.ashbi.ca', cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      { csrf: TOKEN },
    );
    const r = validateCsrfFromJson(req, { csrf: TOKEN });
    expect(r.ok).toBe(true);
  });

  it('rejects when Sec-Fetch-Site is cross-site', async () => {
    const req = requestWith(
      {
        origin: 'https://edusupervise.ashbi.ca',
        cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
        'sec-fetch-site': 'cross-site',
      },
      { csrf: TOKEN },
    );
    const r = validateCsrfFromJson(req, { csrf: TOKEN });
    expect(r.ok).toBe(false);
  });

  it('rejects a JSON body with no Origin (web route default)', async () => {
    const req = requestWith(
      { cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      { csrf: TOKEN },
    );
    const r = validateCsrfFromJson(req, { csrf: TOKEN });
    expect(r.ok).toBe(false);
    if (!r.ok) await expectForbiddenReason(r, 'missing_origin');
  });

  it('accepts native Origin: null when requireOrigin: false', async () => {
    // The api.mobile.push.* routes pass this explicitly so the React
    // Native client (which sends Origin: null) still works.
    const req = requestWith(
      { origin: 'null', cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      { csrf: TOKEN },
    );
    const r = validateCsrfFromJson(req, { csrf: TOKEN }, { requireOrigin: false });
    expect(r.ok).toBe(true);
  });

  it('accepts no-Origin at all when requireOrigin: false (mobile curl debug)', async () => {
    const req = requestWith(
      { cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      { csrf: TOKEN },
    );
    const r = validateCsrfFromJson(req, { csrf: TOKEN }, { requireOrigin: false });
    expect(r.ok).toBe(true);
  });

  it('rejects mismatched body.csrf vs cookie', async () => {
    const req = requestWith(
      { origin: 'https://edusupervise.ashbi.ca', cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      { csrf: 'b'.repeat(64) },
    );
    const r = validateCsrfFromJson(req, { csrf: 'b'.repeat(64) });
    expect(r.ok).toBe(false);
  });
});