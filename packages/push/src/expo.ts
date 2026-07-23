/**
 * @edusupervise/push — Expo Push HTTP API dispatcher.
 *
 * Sends a single notification to the active mobile_push_subscriptions
 * for a (user, school) tuple. The dispatcher:
 *
 *   1. Caps the set of devices it considers per user
 *      (MAX_ACTIVE_DEVICES_PER_USER), preferring the freshest
 *      last_seen_at. This is the "bounded devices" hardening — without
 *      it, a misbehaving client could re-register a near-infinite
 *      number of tokens and we would try to push to each.
 *
 *   2. Sends up to EXPO_BATCH_LIMIT (100) notifications per HTTP
 *      request. The Expo endpoint returns a per-message status array
 *      keyed by the order of the request array, so we can still
 *      attribute `DeviceNotRegistered` back to the right row.
 *
 *   3. Times out each HTTP request with AbortSignal.timeout(
 *      EXPO_REQUEST_TIMEOUT_MS). The previous version had no timeout —
 *      a stuck connection would wedge the worker forever.
 *
 *   4. Classifies outcomes as `sent` / `revoked` (DeviceNotRegistered,
 *      row is soft-deleted) / `transient` (network, timeout, 429, 5xx
 *      — safe to retry) / `permanent` (anything else from Expo — bad
 *      payload, malformed token, InvalidCredentials, etc.). The result
 *      exposes both granular counts AND a backwards-compatible
 *      `messagesFailed` (= transient + permanent) so existing callers
 *      that only read `messagesFailed` keep working.
 *
 *   5. Masks every Expo push token it puts into a log line. Tokens are
 *      user-bound (PII) and must never appear in plain text in logs.
 *
 * Why this lives in a shared package:
 *   The reminder worker (apps/worker/src/jobs/reminders.ts) and the web
 *   notifier (apps/web/server/notifications.server.ts) both call this.
 *   Sharing keeps the API contract uniform across processes.
 *
 * Best-effort contract:
 *   This function NEVER throws. All errors are logged and counted into
 *   the result object. The caller can ignore the result if it doesn't
 *   care — mobile push is parallel to email + SMS fallbacks.
 *
 * Expo HTTP API reference:
 *   POST https://exp.host/--/api/v2/push/send
 *   Body: array of { to, sound, title, body, data, priority, channelId }
 *   Response 200: { data: [{ status: 'ok' | 'error', ... }, ...] }
 *   Common per-message errors:
 *     - DeviceNotRegistered: token is dead; mark the row revoked.
 *     - InvalidCredentials:  EAS projectId / access token wrong.
 *     - MessageTooBig:       payload > 4KB; truncate.
 *     - MessageRateExceeded: back off and retry (treated as transient).
 *
 * Auth note (2026-07-06):
 *   The Expo HTTP API is OPEN for low-volume senders (~1000/sec shared).
 *   At 50-100K pushes/month we are well under that. When we cross it,
 *   add an `Authorization: Bearer <EAS_A...EN>` header here and rotate
 *   via the EAS_PROJECT_ACCESS_TOKEN env var.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  mobilePushSubscriptions,
  type Db,
} from '@edusupervise/db';

/** Default sound + channel — Android requires a channelId for the
 *  notification to surface in the system tray. iOS ignores channelId
 *  but Expo accepts the field on both platforms. */
const DEFAULT_SOUND = 'default';
const DEFAULT_CHANNEL_ID = 'reminders';
const DEFAULT_PRIORITY = 'high';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo caps a single /send POST at 100 messages. Source:
 *  https://docs.expo.dev/push-notifications/sending-notifications/#api-limitations */
export const EXPO_BATCH_LIMIT = 100;

/** Maximum devices we will dispatch to for a single user. Prevents a
 *  misbehaving client from re-registering arbitrarily many tokens.
 *  We keep the freshest MAX_ACTIVE_DEVICES_PER_USER rows by
 *  last_seen_at. */
export const MAX_ACTIVE_DEVICES_PER_USER = 50;

/** Per-request timeout (ms). The Expo /send endpoint typically replies
 *  within ~200ms for normal batches; 10s leaves headroom for slow
 *  networks without wedging the worker. */
export const EXPO_REQUEST_TIMEOUT_MS = 10_000;

/** Public payload shape — what callers pass in. */
export interface MobilePushPayload {
  title: string;
  body: string | null;
  /** Custom data for the receiving app. Expo sends the entire `data`
   *  object as JSON; the mobile app reads it from
   *  Notifications.addNotificationResponseReceivedListener. */
  data?: Record<string, unknown>;
  /** Optional kind tag (e.g. 'reminder', 'coverage'). Echoed back
   *  in the `data` field as `kind` so the mobile app can branch. */
  kind?: string;
  /** Optional deep-link URL the mobile app should open on tap. */
  linkUrl?: string | null;
  /** Sound override. Defaults to 'default'. Set to null to suppress
   *  sound (e.g. for an in-app follow-up). */
  sound?: string | null;
}

/**
 * Result of a single dispatch. Used for tests + observability.
 *
 * Backwards-compat note:
 *   The original v0.1 shape was `{ subscriptionsFound, messagesSent,
 *   tokensRevoked, messagesFailed }`. v0.2 adds `transientFailures`,
 *   `permanentFailures`, `messagesRevokedAsFailed` is removed (folded
 *   into `tokensRevoked`), `messagesFailed` is preserved as
 *   `transientFailures + permanentFailures`. Existing callers that
 *   only read `messagesFailed` keep working unchanged.
 */
export interface MobilePushDispatchResult {
  /** Number of subscription rows the dispatcher found for this user
   *  (after capping to MAX_ACTIVE_DEVICES_PER_USER). */
  subscriptionsFound: number;
  /** Number of subscription rows the dispatcher dropped because the
   *  user had more than MAX_ACTIVE_DEVICES_PER_USER active rows.
   *  The dropped rows are NOT revoked — they're just not contacted.
   *  The dispatcher picks the freshest by last_seen_at. */
  subscriptionsCapped: number;
  /** Number of notifications Expo accepted (status='ok'). */
  messagesSent: number;
  /** Number of rows soft-deleted because Expo reported
   *  DeviceNotRegistered. */
  tokensRevoked: number;
  /** Number of HTTP batches the dispatcher issued (1-N). */
  batchesSent: number;
  /** Number of batch-level HTTP failures (transport error, timeout,
   *  non-2xx without a parseable per-message status array). When a
 *  whole batch fails, every message in that batch counts here. */
  transientFailures: number;
  /** Number of per-message Expo errors that won't be repaired by a
   *  retry — bad payload, malformed token, InvalidCredentials, etc. */
  permanentFailures: number;
  /** Sum of transientFailures + permanentFailures. Preserved from
   *  v0.1 so existing callers keep working. */
  messagesFailed: number;
}

/** Logger interface — pino shape. We accept a minimal interface so
 *  callers (web, worker) can pass their own logger without coupling
 *  this package to pino's import path. */
export interface PushLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

/** A no-op logger for tests + callers that don't want to pass one. */
const NOOP_LOGGER: PushLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
};

/** Allow tests to stub `fetch` without spinning up a real HTTP server.
 *  `globalThis.fetch` is the only fetch implementation we use. */
type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

function getFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new Error(
      '@edusupervise/push: global fetch is not available. This module requires Node 18+.',
    );
  }
  return f as FetchLike;
}

/**
 * Send `payload` to every active mobile_push_subscriptions row for the
 * given (userId, schoolId), capped at MAX_ACTIVE_DEVICES_PER_USER
 * devices (newest first) and batched into groups of EXPO_BATCH_LIMIT.
 *
 * NEVER THROWS. All errors are logged and counted into the result
 * object. Callers can ignore the result if they don't care.
 */
export async function sendMobilePushToUser(
  db: Db,
  userId: string,
  schoolId: string,
  payload: MobilePushPayload,
  logger: PushLogger = NOOP_LOGGER,
): Promise<MobilePushDispatchResult> {
  const result: MobilePushDispatchResult = {
    subscriptionsFound: 0,
    subscriptionsCapped: 0,
    messagesSent: 0,
    tokensRevoked: 0,
    batchesSent: 0,
    transientFailures: 0,
    permanentFailures: 0,
    messagesFailed: 0,
  };

  // 1. Find the active (revoked_at IS NULL) subscriptions for this
  //    user in this school, capped at MAX_ACTIVE_DEVICES_PER_USER,
  //    preferring the freshest last_seen_at. The DB query is run via
  //    the caller-supplied `db` which the caller has already set up
  //    with the right school context (RLS handles cross-tenant safety
  //    net even if not).
  let subs: Array<{ id: string; expoPushToken: string }>;
  try {
    const rows = await db
      .select({
        id: mobilePushSubscriptions.id,
        expoPushToken: mobilePushSubscriptions.expoPushToken,
      })
      .from(mobilePushSubscriptions)
      .where(
        and(
          eq(mobilePushSubscriptions.userId, userId),
          eq(mobilePushSubscriptions.schoolId, schoolId),
          isNull(mobilePushSubscriptions.revokedAt),
        ),
      )
      .orderBy(desc(mobilePushSubscriptions.lastSeenAt))
      .limit(MAX_ACTIVE_DEVICES_PER_USER + 1); // +1 to detect overflow
    subs = rows;
  } catch (err) {
    logger.error(
      { err, userId, schoolId },
      'mobile-push: failed to load subscriptions (non-fatal)',
    );
    return result;
  }

  if (subs.length > MAX_ACTIVE_DEVICES_PER_USER) {
    // We queried one extra to detect overflow; drop it and record the
    // number we are NOT contacting so callers can alert on it.
    result.subscriptionsCapped = subs.length - MAX_ACTIVE_DEVICES_PER_USER;
    subs = subs.slice(0, MAX_ACTIVE_DEVICES_PER_USER);
    logger.warn(
      {
        userId,
        schoolId,
        activeCount: subs.length + result.subscriptionsCapped,
        kept: subs.length,
        capped: result.subscriptionsCapped,
        limit: MAX_ACTIVE_DEVICES_PER_USER,
      },
      'mobile-push: user exceeds the active-device cap; capping to newest subscriptions',
    );
  }

  result.subscriptionsFound = subs.length;
  if (subs.length === 0) {
    logger.debug(
      { userId, schoolId },
      'mobile-push: no active subscriptions for user',
    );
    return result;
  }

  // 2. Batch the subs into EXPO_BATCH_LIMIT groups and POST each batch.
  //    The Expo /send endpoint accepts an array; per-message status is
  //    returned in the same order as the input array.
  for (let i = 0; i < subs.length; i += EXPO_BATCH_LIMIT) {
    const batch = subs.slice(i, i + EXPO_BATCH_LIMIT);
    result.batchesSent += 1;
    const batchOutcomes = await sendBatch(batch, payload, logger);
    if (batchOutcomes === 'batch-failed') {
      // Whole batch failed transiently — every subscription in this
      // batch counts as one transient failure.
      result.transientFailures += batch.length;
      continue;
    }
    for (let j = 0; j < batch.length; j += 1) {
      const sub = batch[j]!;
      const outcome = batchOutcomes[j] ?? 'transient';
      switch (outcome) {
        case 'sent':
          result.messagesSent += 1;
          break;
        case 'revoked': {
          result.tokensRevoked += 1;
          // Best-effort soft-delete the dead row. We don't `await` on a
          // failure — the next subscribe will overwrite it anyway.
          try {
            await db
              .update(mobilePushSubscriptions)
              .set({ revokedAt: new Date() })
              .where(eq(mobilePushSubscriptions.id, sub.id));
          } catch (err) {
            logger.warn(
              { err, subId: sub.id, userId },
              'mobile-push: failed to mark subscription revoked (non-fatal)',
            );
          }
          break;
        }
        case 'transient':
          result.transientFailures += 1;
          break;
        case 'permanent':
          result.permanentFailures += 1;
          break;
      }
    }
  }

  result.messagesFailed = result.transientFailures + result.permanentFailures;
  return result;
}

/** Per-message outcome for one batch. Order matches the input array. */
export type BatchMessageOutcome =
  | 'sent'
  | 'revoked'
  | 'transient'
  | 'permanent';

/** Per-batch outcome: either one outcome per message, or the literal
 *  string `'batch-failed'` meaning the whole batch failed (transport,
 *  timeout, non-2xx without a parseable per-message status array). */
export type BatchOutcome = BatchMessageOutcome[] | 'batch-failed';

/**
 * Send a single batch (up to EXPO_BATCH_LIMIT subscriptions) and
 * classify each per-message outcome. Exported for tests.
 *
 * Does NOT mutate the DB — the caller is responsible for marking
 * subscriptions revoked based on the returned outcomes.
 */
export async function sendBatch(
  subs: Array<{ id: string; expoPushToken: string }>,
  payload: MobilePushPayload,
  logger: PushLogger = NOOP_LOGGER,
): Promise<BatchOutcome> {
  if (subs.length === 0) return [];
  if (subs.length > EXPO_BATCH_LIMIT) {
    throw new Error(
      `sendBatch called with ${subs.length} subs; max is EXPO_BATCH_LIMIT=${EXPO_BATCH_LIMIT}. ` +
        'Use sendMobilePushToUser for the full pipeline.',
    );
  }

  const messages = subs.map((s) => buildExpoMessage(s.expoPushToken, payload));

  let res: FetchResponse;
  try {
    const fetchImpl = getFetch();
    // AbortSignal.timeout is a Node 17+ global. It rejects with a
    // DOMException('TimeoutError') if the request doesn't complete in
    // EXPO_REQUEST_TIMEOUT_MS — the catch block classifies that as
    // a transient batch failure.
    res = await fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(EXPO_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = classifyFetchError(err);
    logger.warn(
      {
        err,
        reason,
        batchSize: subs.length,
        timeoutMs: EXPO_REQUEST_TIMEOUT_MS,
        // Don't log tokens; just log the batch size.
      },
      'mobile-push: HTTP transport error (transient; whole batch failed)',
    );
    return 'batch-failed';
  }

  // Per Expo docs, a 429 is a rate-limit signal — treat as transient
  // at the batch level (don't try to parse a per-message array).
  if (res.status === 429) {
    logger.warn(
      { status: res.status, batchSize: subs.length },
      'mobile-push: Expo returned 429 (transient; whole batch failed)',
    );
    return 'batch-failed';
  }

  if (!res.ok) {
    // 5xx → transient. 4xx (other than 429) → permanent config error.
    const isTransient = res.status >= 500;
    logger.warn(
      {
        status: res.status,
        batchSize: subs.length,
        classification: isTransient ? 'transient' : 'permanent',
      },
      'mobile-push: Expo HTTP error (whole batch failed)',
    );
    if (isTransient) {
      return Array<BatchMessageOutcome>(subs.length).fill('transient');
    }
    return Array<BatchMessageOutcome>(subs.length).fill('permanent');
  }

  let responseBody: ExpoPushResponse;
  try {
    responseBody = (await res.json()) as ExpoPushResponse;
  } catch (err) {
    logger.warn(
      { err, status: res.status, batchSize: subs.length },
      'mobile-push: non-JSON response from Expo (transient; whole batch failed)',
    );
    return 'batch-failed';
  }

  const data = responseBody.data ?? [];
  if (data.length !== subs.length) {
    // Expo should echo one entry per message. If it doesn't, the
    // contract is broken — treat the whole batch as transient so the
    // caller's retry policy picks it up.
    logger.warn(
      {
        batchSize: subs.length,
        dataLen: data.length,
      },
      'mobile-push: Expo response data length mismatch (transient; whole batch failed)',
    );
    return 'batch-failed';
  }

  const outcomes: BatchMessageOutcome[] = [];
  for (let i = 0; i < subs.length; i += 1) {
    const sub = subs[i]!;
    const item = data[i]!;
    outcomes.push(classifyMessage(item, sub.expoPushToken, logger));
  }
  return outcomes;
}

/** Build one Expo push message body. Exported for tests. */
export function buildExpoMessage(
  expoPushToken: string,
  payload: MobilePushPayload,
): Record<string, unknown> {
  return {
    to: expoPushToken,
    sound: payload.sound === undefined ? DEFAULT_SOUND : payload.sound,
    title: payload.title,
    body: payload.body ?? undefined,
    channelId: DEFAULT_CHANNEL_ID,
    priority: DEFAULT_PRIORITY,
    data: {
      ...(payload.data ?? {}),
      kind: payload.kind,
      linkUrl: payload.linkUrl,
    },
  };
}

interface ExpoPushResponse {
  data?: Array<{
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string; [k: string]: unknown };
  }>;
  errors?: Array<{ code: string; message: string }>;
}

/** Element shape of ExpoPushResponse.data. Extracted so the public
 *  classifyMessage signature is stable independent of the container. */
export type ExpoMessageResult = NonNullable<ExpoPushResponse['data']>[number];

/**
 * Classify a single Expo response item. Returns:
 *   - 'sent'      — Expo accepted the message.
 *   - 'revoked'   — DeviceNotRegistered; the row should be marked
 *                   revoked_at = now().
 *   - 'permanent' — payload/credential errors retries will not repair.
 *   - 'transient' — defensive default for malformed/missing items.
 */
export function classifyMessage(
  item: ExpoMessageResult | undefined,
  expoPushToken: string,
  logger: PushLogger,
): BatchMessageOutcome {
  if (!item) {
    logger.warn(
      { expoPushToken: maskToken(expoPushToken) },
      'mobile-push: missing per-message data from Expo',
    );
    return 'transient';
  }
  if (item.status === 'ok') return 'sent';
  // status === 'error'
  const errCode = item.details?.error;
  if (errCode === 'DeviceNotRegistered') {
    // The user uninstalled the app, the token is dead, or the OS
    // told Expo the device is no longer reachable. Mark the row
    // revoked so we don't keep hitting Expo with it.
    logger.info(
      { expoPushToken: maskToken(expoPushToken) },
      'mobile-push: DeviceNotRegistered — marking subscription revoked',
    );
    return 'revoked';
  }
  // All other Expo errors are permanent at the per-message level:
  // InvalidCredentials, MessageTooBig, InvalidProviderToken, etc.
  // None of these get repaired by a retry.
  logger.warn(
    {
      errCode,
      message: item.message,
      expoPushToken: maskToken(expoPushToken),
    },
    'mobile-push: Expo returned permanent error',
  );
  return 'permanent';
}

/** Classify a fetch-level error into a reason tag for logs. */
export function classifyFetchError(
  err: unknown,
): 'timeout' | 'aborted' | 'network' | 'unknown' {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as { name?: string; code?: string };
  if (e.name === 'TimeoutError') {
    return 'timeout';
  }
  if (e.name === 'AbortError') {
    return 'aborted';
  }
  // undici / node fetch ECONNRESET / ECONNREFUSED / EAI_AGAIN all
  // surface as `code: '...'` strings.
  if (typeof e.code === 'string' && /^(ECONN|EAI_|EPIPE)/.test(e.code)) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Mask a push token for log lines. Keeps the full token in the DB but
 * never in logs — Expo push tokens are user-bound (PII). Format:
 * first 8 chars + ellipsis + last 4 chars. Tokens shorter than 12
 * chars collapse to "***".
 */
export function maskToken(token: string): string {
  if (typeof token !== 'string' || token.length <= 12) return '***';
  return `${token.slice(0, 9)}…${token.slice(-5)}`;
}