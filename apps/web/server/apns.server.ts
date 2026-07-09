// apps/web/server/apns.server.ts — APNs (Apple Push Notification service)
// HTTP/2 client for EduSupervise iOS app.
//
// Phase 2 of the iOS App Store pipeline. WKWebView does NOT support the
// Web Push API, so iOS users need a separate channel — APNs. We hand-roll
// the protocol here instead of pulling in @parse/node-apn (a heavy dep
// with a stale maintainer) because Apple's HTTP/2 API is small and stable.
//
// Auth model (token-based, the modern path):
//   1. Sign a JWT with ES256 (P-256 ECDSA) using the .p8 private key
//      Apple gave us. Team ID + Key ID are the JWT claims.
//   2. Send `Authorization: bearer <jwt>` on every request.
//   3. JWT is valid for up to 60 minutes; we cache and re-sign.
//
// Required env (Cameron provides these from App Store Connect):
//   APNS_KEY_ID         — 10-char Key ID (e.g. "ABCDE12345")
//   APNS_TEAM_ID        — 10-char Team ID
//   APNS_BUNDLE_ID      — app bundle (e.g. "ca.ashbi.edusupervise")
//   APNS_KEY_P8         — PEM contents of the .p8 auth key
//   APNS_ENV            — "production" | "sandbox" (default: production)
//
// Failure modes we handle:
//   - 410 Gone          → device token retired, delete push_subscriptions row
//   - 400 BadDeviceToken → malformed token (programming error)
//   - 403 InvalidProviderToken → JWT signing mismatch (regenerate key)
//
// Out of scope:
//   - Token-based auth migration to certificate-based (deprecated path)
//   - VoIP / complication pushes (separate APNs push types)
//
// References:
//   - https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
//   - https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns

import { createPrivateKey, createSign, randomUUID, type KeyObject } from 'node:crypto';
import {
  connect as http2Connect,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
} from 'node:http2';
import { Buffer } from 'node:buffer';
import { logger } from './logger.server';

const APNS_PRODUCTION = 'https://api.push.apple.com';
const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';

const APNS_PUSH_TYPE_ALERT = 'alert';
const APNS_PRIORITY_10 = '10';

interface ApnsConfig {
  baseUrl: string;
  bundleId: string;
  teamId: string;
  keyId: string;
  /** PEM-encoded P-256 private key (.p8 contents). */
  p8Pem: string;
}

interface ApnsPayload {
  title: string;
  body?: string | null;
  /** Custom data for the iOS app to act on (deep link, kind, etc.). */
  data?: Record<string, unknown>;
  /** Optional badge count (default: don't touch the badge). */
  badge?: number;
  /** Optional sound; "default" plays the user's choice. */
  sound?: string;
}

interface SendResult {
  ok: boolean;
  /** Apple-assigned apns-id (UUID). */
  apnsId?: string;
  /** 'gone' for 410, 'invalid-token' for 400 BadDeviceToken, etc. */
  reason?: 'gone' | 'invalid-token' | 'auth-failed' | 'rate-limited' | 'unknown';
  /** HTTP status from APNs. */
  status?: number;
}

let cachedConfig: ApnsConfig | null = null;
let cachedJwt: { token: string; expiresAt: number } | null = null;

/**
 * Module-level HTTP/2 session cache, keyed on baseUrl. Apple's APNs
 * protocol model is "persistent HTTP/2" — opening a fresh TCP+TLS
 * session per push triggers their new-connection burst throttling and
 * adds 50-150ms of handshake per send. With a 100-recipient broadcast
 * via /api/notifications/test that's 100 serial handshakes; the same
 * single session can fan-out all 100 streams (HTTP/2 multiplexing).
 *
 * Session is recreated on error/close — see cleanup handler below.
 */
interface ApnsSession {
  session: ClientHttp2Session;
  keyObj: KeyObject;
}
const sessionCache = new Map<string, ApnsSession>();

function getOrCreateSession(cfg: ApnsConfig): ApnsSession | null {
  const cached = sessionCache.get(cfg.baseUrl);
  if (cached && !cached.session.closed && !cached.session.destroyed) {
    return cached;
  }
  try {
    const session = http2Connect(cfg.baseUrl);
    const keyObj = createPrivateKey({ key: cfg.p8Pem, format: 'pem' });
    const entry: ApnsSession = { session, keyObj };
    sessionCache.set(cfg.baseUrl, entry);
    // Drop from cache on error/close so the next call recreates.
    const cleanup = () => sessionCache.delete(cfg.baseUrl);
    session.once('error', (err: Error) => {
      logger.warn({ err: err.message, baseUrl: cfg.baseUrl }, 'apns: session error; will recreate on next send');
      cleanup();
    });
    session.once('close', cleanup);
    return entry;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), baseUrl: cfg.baseUrl }, 'apns: session create failed');
    return null;
  }
}

/**
 * Load APNs config from env. Returns null if any required field is
 * missing — callers should treat that as "APNs not configured" and
 * skip silently (most installs won't have the .p8 wired until Cameron
 * provisions the App Store Connect key).
 */
export function getApnsConfig(): ApnsConfig | null {
  if (cachedConfig) return cachedConfig;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  const p8Pem = process.env.APNS_KEY_P8;
  const env = (process.env.APNS_ENV ?? 'production').toLowerCase();
  if (!keyId || !teamId || !bundleId || !p8Pem) return null;
  cachedConfig = {
    baseUrl: env === 'sandbox' ? APNS_SANDBOX : APNS_PRODUCTION,
    bundleId,
    teamId,
    keyId,
    p8Pem,
  };
  return cachedConfig;
}

/**
 * Sign a fresh APNs JWT. Cached in-memory until ~50 min old (Apple
 * rejects tokens older than 60 min). We re-sign lazily on next call.
 */
export function getApnsJwt(cfg: ApnsConfig, keyObj: KeyObject): string | null {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expiresAt > now + 60) {
    return cachedJwt.token;
  }

  const header = { alg: 'ES256', kid: cfg.keyId };
  const payload = { iss: cfg.teamId, iat: now };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // sign() returns DER-encoded ASN.1 sequence; APNs requires the raw
  // r||s form, 32 bytes each. convertDerToRaw handles that.
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const derSig = signer.sign(keyObj);
  const rawSig = convertDerToRaw(derSig);
  const sigB64 = base64urlRaw(rawSig);

  const token = `${signingInput}.${sigB64}`;
  cachedJwt = { token, expiresAt: now + 50 * 60 };
  return token;
}

/**
 * Send a push to a single device token.
 *
 * Returns SendResult; caller (push.server.ts) inspects `reason` to
 * decide whether to delete the subscription row.
 */
export async function sendApnsPush(
  deviceToken: string,
  payload: ApnsPayload,
): Promise<SendResult> {
  const cfg = getApnsConfig();
  if (!cfg) {
    return { ok: false, reason: 'auth-failed' };
  }
  const entry = getOrCreateSession(cfg);
  if (!entry) {
    return { ok: false, reason: 'auth-failed' };
  }
  const jwt = getApnsJwt(cfg, entry.keyObj);
  if (!jwt) {
    return { ok: false, reason: 'auth-failed' };
  }

  const apnsId = randomUUID();
  const body = JSON.stringify({
    aps: {
      alert: {
        title: payload.title,
        body: payload.body ?? undefined,
      },
      badge: payload.badge,
      sound: payload.sound ?? 'default',
      'mutable-content': 1,
    },
    ...payload.data, // flatten custom fields at top level for the JS bridge
  });

  // Use the cached session (NOT a fresh connection) so we stay within
  // Apple's persistent-HTTP/2 protocol model. The session is owned by
  // sessionCache; we never close it here. safeResolve only closes the
  // per-request stream, never the underlying session.
  const session = entry.session;
  return new Promise<SendResult>((resolve) => {
    let req: ClientHttp2Stream | null = null;
    let resolved = false;
    const safeResolve = (r: SendResult) => {
      if (resolved) return;
      resolved = true;
      try { req?.close(); } catch {}
      // NOTE: do NOT session.close() here — the session is shared
      // across all sends on this baseUrl. Lifecycle is owned by
      // sessionCache (recreated on error/close events).
      resolve(r);
    };

    session.on('error', (err: Error) => {
      logger.warn({ err: err.message, apnsId }, 'apns: session error');
      safeResolve({ ok: false, reason: 'unknown' });
    });

    req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': APNS_PUSH_TYPE_ALERT,
      'apns-priority': APNS_PRIORITY_10,
      'apns-id': apnsId,
      'content-type': 'application/json',
    });
    req.on('response', (headers: IncomingHttpHeaders) => {
        const status = (headers[':status'] as number | undefined) ?? 0;
        const apnsIdBack = headers['apns-id'];
        let body = '';
        req!.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        req!.on('end', () => {
          if (status === 200) {
            logger.info({ apnsId: apnsIdBack, status }, 'apns: push delivered');
            safeResolve({ ok: true, apnsId: String(apnsIdBack), status });
            return;
          }
          let reason: SendResult['reason'] = 'unknown';
          if (status === 410) reason = 'gone';
          else if (status === 400) reason = 'invalid-token';
          else if (status === 403) reason = 'auth-failed';
          else if (status === 429) reason = 'rate-limited';
          logger.warn(
            { apnsId, status, reason, body: body.slice(0, 200) },
            'apns: push failed',
          );
          safeResolve({ ok: false, reason, status });
        });
    });

    req.on('error', (err: Error) => {
      logger.warn({ err: err.message, apnsId }, 'apns: transport error');
      safeResolve({ ok: false, reason: 'unknown' });
    });

    req.setTimeout(8000, () => {
      logger.warn({ apnsId }, 'apns: request timeout');
      safeResolve({ ok: false, reason: 'unknown' });
    });

    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Crypto helpers — kept private since they're APNs-specific.
// ---------------------------------------------------------------------------

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlRaw(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Convert a DER-encoded ECDSA signature (ASN.1 sequence of two INTEGERs)
 * to the raw r||s form (32 bytes each) that APNs requires.
 *
 * Layout in DER: 0x30 LEN 0x02 RLEN R... 0x02 SLEN S...
 *
 * **P-256 only.** We sign with ES256 (P-256, ~256-bit curve) so r and s
 * are always at most 33 bytes (32 bytes + possible leading 0x00 sign
 * padding). Larger curves (P-384, P-521) would produce 48 / 66-byte
 * values that overflow our 32-byte pad. Apple's APNs only accepts
 * ES256, so this constraint is firm. Audited 2026-07-09.
 *
 * Length sanity checks throw on malformed input with descriptive
 * errors — the previous implementation used `der[N]!` non-null
 * assertions that crashed with cryptic TypeError messages instead.
 */
function convertDerToRaw(der: Buffer): Buffer {
  if (der.length < 8) {
    throw new Error(`convertDerToRaw: DER signature too short (${der.length} bytes; minimum 8 for P-256)`);
  }
  if (der[0] !== 0x30) {
    throw new Error(`convertDerToRaw: expected outer SEQUENCE tag 0x30, got 0x${der[0]!.toString(16)}`);
  }
  // Short-form DER length only (P-256 sig is always < 128 bytes).
  let offset = 2;
  if ((der[1]! & 0x80) !== 0) {
    throw new Error('convertDerToRaw: long-form DER length not supported (P-256 sig always fits in short-form)');
  }

  // Read R: tag 0x02 + length byte + rLen bytes.
  if (der[offset] !== 0x02) {
    throw new Error(`convertDerToRaw: expected INTEGER tag 0x02 for R, got 0x${der[offset]!.toString(16)}`);
  }
  offset++;
  const rLen = der[offset]!;
  if (rLen === 0 || rLen > 33) {
    throw new Error(`convertDerToRaw: R length ${rLen} out of range (1-33 for P-256)`);
  }
  offset++;
  const r = der.subarray(offset, offset + rLen);
  offset += rLen;

  // Read S: tag 0x02 + length byte + sLen bytes.
  if (der[offset] !== 0x02) {
    throw new Error(`convertDerToRaw: expected INTEGER tag 0x02 for S, got 0x${der[offset]!.toString(16)}`);
  }
  offset++;
  const sLen = der[offset]!;
  if (sLen === 0 || sLen > 33) {
    throw new Error(`convertDerToRaw: S length ${sLen} out of range (1-33 for P-256)`);
  }
  offset++;
  const s = der.subarray(offset, offset + sLen);

  // Strip leading 0x00 sign-byte padding if present. After this,
  // r and s are each at most 32 bytes.
  const rNorm = r.length === 33 && r[0] === 0x00 ? r.subarray(1) : r;
  const sNorm = s.length === 33 && s[0] === 0x00 ? s.subarray(1) : s;
  if (rNorm.length > 32 || sNorm.length > 32) {
    throw new Error('convertDerToRaw: normalized R/S length exceeds 32 bytes (P-256 invariant violated)');
  }

  // Left-pad each to exactly 32 bytes.
  const rPadded = Buffer.alloc(32);
  const sPadded = Buffer.alloc(32);
  rNorm.copy(rPadded, 32 - rNorm.length);
  sNorm.copy(sPadded, 32 - sNorm.length);

  return Buffer.concat([rPadded, sPadded]);
}