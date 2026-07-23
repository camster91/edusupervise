/**
 * @edusupervise/push — public surface.
 *
 * Currently exposes only the Expo HTTP API dispatcher. Future channels
 * (FCM-direct, APNs-direct) would be added here as siblings.
 *
 * Audit 2026-07-22 P2-8: `sendBatch`, `buildExpoMessage`,
 * `classifyMessage`, `classifyFetchError`, `BatchMessageOutcome`,
 * `BatchOutcome`, `ExpoMessageResult` were re-exported here but only
 * used internally by `expo.ts` (and the package's own test). Moved
 * off the public surface so the worker-facing API is exactly what the
 * worker actually consumes.
 */
export {
  sendMobilePushToUser,
  maskToken,
  EXPO_BATCH_LIMIT,
  MAX_ACTIVE_DEVICES_PER_USER,
  EXPO_REQUEST_TIMEOUT_MS,
  type MobilePushPayload,
  type MobilePushDispatchResult,
  type PushLogger,
} from './expo.js';