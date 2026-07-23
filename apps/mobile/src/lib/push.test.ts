// apps/mobile/src/lib/push.test.ts
//
// Tests for the production push registration lifecycle.
//
// Why these tests matter: this file previously exercised only a stale
// `push-core.ts` copy that no production code imported. The real
// `registerForPushNotifications` / `unregisterForPushNotifications`
// paths had zero coverage. This file covers:
//   - `isValidUuidV4` strictness
//   - `buildPushApiUrl` absolute-URL construction
//   - `buildDeepLinkFromPush` strict UUID validation on deep-link payloads
//   - `registerForPushNotifications` failure-mode mapping (no_project_id,
//     permission_denied, csrf_missing, http_error)
//   - `unregisterForPushNotifications` failure-mode mapping (csrf_missing,
//     network throw, non-2xx response)
//
// We stub fetch + the Notifications API surface; we do NOT exercise the
// React Native / Expo runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mutable mock state — every mock reads through getters so per-test mutation
// is visible to the production module under test.
// ---------------------------------------------------------------------------

const state = {
  permissions: { granted: false } as { granted: boolean },
  permissionsRequests: [] as Array<{ granted: boolean }>,
  pushTokens: [] as Array<{ data: string }>,
  iosVendorId: 'vendor-id' as string | null,
  expoConfig: { extra: { eas: { projectId: 'proj-1' } } } as
    | { extra?: { eas?: { projectId?: string } } }
    | undefined,
  easConfig: undefined as { projectId?: string } | undefined,
  platformOS: 'ios' as 'ios' | 'android',
};

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: () => Promise.resolve(state.permissions),
  requestPermissionsAsync: () => {
    state.permissionsRequests.push({ granted: state.permissions.granted });
    return Promise.resolve(state.permissions);
  },
  getExpoPushTokenAsync: () => {
    const next = state.pushTokens.shift();
    if (!next) throw new Error('getExpoPushTokenAsync: no token queued');
    return Promise.resolve(next);
  },
}));

vi.mock('expo-application', () => ({
  getIosIdForVendorAsync: () =>
    state.iosVendorId === null
      ? Promise.reject(new Error('no vendor id'))
      : Promise.resolve(state.iosVendorId),
  nativeApplicationVersion: '1.0.0',
}));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return state.expoConfig;
    },
    get easConfig() {
      return state.easConfig;
    },
  },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.platformOS;
    },
    get is() {
      return { ios: state.platformOS === 'ios', android: state.platformOS === 'android' };
    },
  },
}));

vi.mock('./api', () => ({
  getApiBaseUrl: () => 'https://example.test',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultCookieHeader = 'edusupervise.session=abc; __Host-edusupervise.csrf=tok';
const defaultGetCookieHeader = async () => defaultCookieHeader;
const defaultGetCsrfToken = async () => 'tok';

beforeEach(() => {
  state.permissions = { granted: false };
  state.permissionsRequests = [];
  state.pushTokens = [{ data: 'ExponentPushToken[real-token]' }];
  state.iosVendorId = 'vendor-id';
  state.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };
  state.easConfig = undefined;
  state.platformOS = 'ios';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isValidUuidV4
// ---------------------------------------------------------------------------

describe('isValidUuidV4', () => {
  it('accepts a canonical UUID v4', async () => {
    const { isValidUuidV4 } = await import('./push');
    expect(isValidUuidV4('4e57d620-4ba2-4d6e-89b1-66c9b2a9a000')).toBe(true);
  });

  it('rejects UUIDs whose version nibble is not 4', async () => {
    const { isValidUuidV4 } = await import('./push');
    // 3rd group starts with "1" → not v4
    expect(isValidUuidV4('4e57d620-1ba2-1d6e-89b1-66c9b2a9a000')).toBe(false);
    // v1 should also fail
    expect(isValidUuidV4('4e57d620-1ba2-1d6e-89b1-66c9b2a9a000')).toBe(false);
  });

  it('rejects UUIDs whose variant bits are not 10xx', async () => {
    const { isValidUuidV4 } = await import('./push');
    // 4th group starts with "c" → wrong variant
    expect(isValidUuidV4('4e57d620-4ba2-4d6e-c9b1-66c9b2a9a000')).toBe(false);
  });

  it('rejects non-strings', async () => {
    const { isValidUuidV4 } = await import('./push');
    expect(isValidUuidV4(undefined)).toBe(false);
    expect(isValidUuidV4(123)).toBe(false);
    expect(isValidUuidV4({})).toBe(false);
    expect(isValidUuidV4(null)).toBe(false);
  });

  it('rejects javascript: phishing strings', async () => {
    const { isValidUuidV4 } = await import('./push');
    expect(isValidUuidV4('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty strings and arbitrary short strings', async () => {
    const { isValidUuidV4 } = await import('./push');
    expect(isValidUuidV4('')).toBe(false);
    expect(isValidUuidV4('not-a-uuid')).toBe(false);
    expect(isValidUuidV4('4e57d620-4ba2-4d6e-89b1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPushApiUrl
// ---------------------------------------------------------------------------

describe('buildPushApiUrl', () => {
  it('appends the path to the base, with no double slash', async () => {
    const { buildPushApiUrl } = await import('./push');
    expect(buildPushApiUrl('/api/mobile/push/subscribe', 'https://example.test')).toBe(
      'https://example.test/api/mobile/push/subscribe',
    );
  });

  it('strips a trailing slash on the base', async () => {
    const { buildPushApiUrl } = await import('./push');
    expect(buildPushApiUrl('/api/mobile/push/unsubscribe', 'https://example.test/')).toBe(
      'https://example.test/api/mobile/push/unsubscribe',
    );
  });

  it('falls back to getApiBaseUrl when no base is provided', async () => {
    const { buildPushApiUrl } = await import('./push');
    expect(buildPushApiUrl('/api/mobile/push/subscribe')).toBe(
      'https://example.test/api/mobile/push/subscribe',
    );
  });
});

// ---------------------------------------------------------------------------
// buildDeepLinkFromPush (security review E-007)
// ---------------------------------------------------------------------------

describe('buildDeepLinkFromPush', () => {
  it('routes coverage + valid UUID to coverage screen with assignmentId', async () => {
    const { buildDeepLinkFromPush } = await import('./push');
    const result = buildDeepLinkFromPush({
      kind: 'coverage',
      coverageAssignmentId: '4e57d620-4ba2-4d6e-89b1-66c9b2a9a000',
    });
    expect(result).toEqual({
      pathname: '/(app)/coverage',
      params: { assignmentId: '4e57d620-4ba2-4d6e-89b1-66c9b2a9a000' },
    });
  });

  it('drops to coverage screen with no params when coverageAssignmentId is not UUID v4', async () => {
    const { buildDeepLinkFromPush } = await import('./push');
    const result = buildDeepLinkFromPush({
      kind: 'coverage',
      coverageAssignmentId: 'javascript:alert(1)',
    });
    expect(result).toEqual({ pathname: '/(app)/coverage', params: {} });
  });

  it('routes reminder with valid dutyId to today screen', async () => {
    const { buildDeepLinkFromPush } = await import('./push');
    const result = buildDeepLinkFromPush({
      kind: 'reminder',
      dutyId: '4e57d620-4ba2-4d6e-89b1-66c9b2a9a000',
    });
    expect(result).toEqual({
      pathname: '/(app)/today',
      params: { dutyId: '4e57d620-4ba2-4d6e-89b1-66c9b2a9a000' },
    });
  });

  it('ignores linkUrl (server-controlled) entirely', async () => {
    const { buildDeepLinkFromPush } = await import('./push');
    const result = buildDeepLinkFromPush({
      kind: 'reminder',
      dutyId: '4e57d620-4ba2-4d6e-89b1-66c9b2a9a000',
      linkUrl: 'https://evil.example/phish',
    });
    expect(result.pathname).toBe('/(app)/today');
    expect((result.params as Record<string, string>).linkUrl).toBeUndefined();
  });

  it('falls back to today screen with no params for undefined input', async () => {
    const { buildDeepLinkFromPush } = await import('./push');
    expect(buildDeepLinkFromPush(undefined)).toEqual({
      pathname: '/(app)/today',
      params: {},
    });
  });
});

// ---------------------------------------------------------------------------
// registerForPushNotifications — failure modes
// ---------------------------------------------------------------------------

describe('registerForPushNotifications', () => {
  it('returns permission_denied when notifications permission is refused', async () => {
    state.permissions = { granted: false };

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(result).toEqual({ ok: false, reason: 'permission_denied' });
    expect(state.permissionsRequests).toEqual([{ granted: false }]);
  });

  it('returns no_project_id when neither expoConfig.extra.eas.projectId nor easConfig.projectId is set', async () => {
    state.permissions = { granted: true };
    state.expoConfig = undefined;
    state.easConfig = undefined;

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_project_id');
      expect(result.detail).toMatch(/projectId/i);
    }
  });

  it('falls back to easConfig.projectId when expoConfig.extra.eas is missing', async () => {
    state.permissions = { granted: true };
    state.expoConfig = undefined;
    state.easConfig = { projectId: 'fallback-proj' };
    // Token queued by beforeEach; happy path continues to fetch 200.

    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns http_error with csrf-missing detail when csrf is null', async () => {
    state.permissions = { granted: true };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      async () => null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('http_error');
      expect(result.detail).toMatch(/csrf/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns http_error when fetch receives a non-2xx response', async () => {
    state.permissions = { granted: true };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 })),
    );

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('http_error');
      expect(result.detail).toMatch(/403/);
    }
  });

  it('returns ok:true with token when the server accepts the subscription', async () => {
    state.permissions = { granted: true };
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(result).toEqual({ ok: true, token: 'ExponentPushToken[real-token]' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const callArgs = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const [calledUrl, init] = callArgs;
    expect(calledUrl).toBe('https://example.test/api/mobile/push/subscribe');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Cookie).toBe(defaultCookieHeader);
    const body = JSON.parse(init.body as string);
    expect(body.csrf).toBe('tok');
    expect(body.expoPushToken).toBe('ExponentPushToken[real-token]');
    expect(body.platform).toBe('ios');
    expect(body.deviceId).toBe('vendor-id');
  });

  it('passes android platform when Platform.OS is android', async () => {
    state.permissions = { granted: true };
    state.platformOS = 'android';
    state.iosVendorId = null; // simulates Android (no vendor id)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(result.ok).toBe(true);
    const callArgs = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const [, init] = callArgs;
    const body = JSON.parse(init.body as string);
    expect(body.platform).toBe('android');
    // deviceId is null on Android (per implementation), so the field is omitted
    expect('deviceId' in body).toBe(false);
  });

  it('returns http_error when getExpoPushTokenAsync throws', async () => {
    state.permissions = { granted: true };
    state.pushTokens = []; // no token queued → mock throws

    const { registerForPushNotifications } = await import('./push');
    const result = await registerForPushNotifications(
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('http_error');
      expect(result.detail).toMatch(/getExpoPushTokenAsync/);
    }
  });
});

// ---------------------------------------------------------------------------
// unregisterForPushNotifications — failure modes
// ---------------------------------------------------------------------------

describe('unregisterForPushNotifications', () => {
  it('returns false when csrf is null', async () => {
    const { unregisterForPushNotifications } = await import('./push');
    const ok = await unregisterForPushNotifications(
      'ExponentPushToken[whatever]',
      defaultGetCookieHeader,
      async () => null,
    );
    expect(ok).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const { unregisterForPushNotifications } = await import('./push');
    const ok = await unregisterForPushNotifications(
      'ExponentPushToken[whatever]',
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(ok).toBe(false);
  });

  it('returns false when server returns a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('expired', { status: 401 })),
    );

    const { unregisterForPushNotifications } = await import('./push');
    const ok = await unregisterForPushNotifications(
      'ExponentPushToken[whatever]',
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(ok).toBe(false);
  });

  it('returns true when server returns 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const { unregisterForPushNotifications } = await import('./push');
    const ok = await unregisterForPushNotifications(
      'ExponentPushToken[whatever]',
      defaultGetCookieHeader,
      defaultGetCsrfToken,
    );
    expect(ok).toBe(true);
  });
});