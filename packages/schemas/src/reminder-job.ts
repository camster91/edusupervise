/**
 * @edusupervise/schemas/reminder — Zod schema for the reminder BullMQ job
 * payload. Single source of truth used by:
 *
 *   - apps/worker/src/jobs/reminders.ts   (consume-time validation)
 *   - apps/web/server/queue.server.ts     (enqueue-time validation)
 *   - apps/web/server/queue.server.ts     (re-validation when the outbox
 *                                          flusher promotes a row to BullMQ)
 *
 * Why the schema lives here and not in the worker package: the web app
 * can't import from `@edusupervise/worker` (web → worker is a backwards
 * dependency for code-reuse reasons), and `@edusupervise/schemas` is the
 * workspace's existing share-everywhere home for Zod schemas.
 *
 * Spec section 10 mandates:
 *   "Job payload schema (Zod, validated on enqueue AND on consume)"
 *
 * Migration 0015 / Sprint 1 of the mobile companion (2026-07-06):
 *   Added 'push-expo' to the channel union. The reminder processor
 *   dispatches to Expo's HTTP API via @edusupervise/push. Same flow as
 *   email + SMS — the worker writes a `reminder_log` row with the channel
 *   so dedupe via UNIQUE(reminder_id, scheduled_for, channel) still works.
 */

import { z } from 'zod';

export const reminderJobSchema = z.object({
  schoolId: z.string().uuid({ message: 'schoolId is required (UUID)' }),
  reminderId: z.string().uuid({ message: 'reminderId is required (UUID)' }),
  assignmentId: z.string().uuid({ message: 'assignmentId is required (UUID)' }),
  userId: z.string().uuid({ message: 'userId is required (UUID)' }),
  channel: z.enum(['email', 'sms', 'push-expo']),
  scheduledFor: z.string().datetime({
    message: 'scheduledFor must be an ISO 8601 datetime',
  }),
});

export type ReminderJobPayload = z.infer<typeof reminderJobSchema>;

/** Sentinel string used by the worker when moving a poison payload. */
export const INVALID_PAYLOAD_ERROR = 'invalid_payload';
