// apps/web/server/reminders.server.ts — per-duty reminder CRUD.
//
// The reminder table is keyed on `assignment_id` (not `duty_id`) so a
// reminder lives only as long as the teacher is assigned to that duty.
// If Ms. Chen's Cafeteria Lunch A ends and Mr. Daniels takes over, the
// old reminder for Ms. Chen goes away automatically (FK ON DELETE
// CASCADE), and a fresh reminder is needed for the new assignment.
// This matches the reference prototype's intent and avoids ghost
// reminders firing for the wrong teacher.
//
// Worker pipeline (apps/worker/src/jobs/reminders.ts):
//   - cron tick (every minute) scans duty_assignments for the next
//     60 minutes, joins reminders, enqueues BullMQ jobs on the
//     `reminders` queue
//   - worker validates, composes the message, calls
//     @edusupervise/email + @edusupervise/sms, writes reminder_log
//
// This module only owns CRUD + list-for-display. The worker owns
// dispatch.

import { and, eq, desc } from 'drizzle-orm';
import { reminders, dutyAssignments, duties, users, getSystemClient } from '@edusupervise/db';
import { logger } from './logger.server';

export interface ReminderRow {
  id: string;
  schoolId: string;
  assignmentId: string;
  userId: string | null;
  /** Recipient display name, joined from users. */
  userName: string | null;
  /** The duty's location, joined for the UI. */
  dutyLocation: string;
  dutyStartTime: string;
  minutesBefore: number;
  isEnabled: boolean;
  notifyEmail: boolean;
  notifySms: boolean;
  customMessage: string | null;
  createdAt: string;
}

interface CreateInput {
  assignmentId: string;
  minutesBefore: number;
  notifyEmail?: boolean;
  notifySms?: boolean;
  customMessage?: string | null;
}

interface UpdateInput {
  minutesBefore?: number;
  notifyEmail?: boolean;
  notifySms?: boolean;
  customMessage?: string | null;
  isEnabled?: boolean;
}

const MAX_MINUTES = 10080; // 7 days
const MAX_CUSTOM_MESSAGE_LEN = 500;

/**
 * List all reminders for a duty, across assignments. Used by the
 * inline DutyCard UI to show the total reminders set up regardless
 * of which teacher is currently assigned.
 */
export async function listRemindersForDuty(
  dutyId: string,
  schoolId: string,
): Promise<ReminderRow[]> {
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return [];
  const { db, close } = getSystemClient(url);
  try {
    // Join: reminders → assignments → duties + users
    const rows = await db
      .select({
        id: reminders.id,
        schoolId: reminders.schoolId,
        assignmentId: reminders.assignmentId,
        minutesBefore: reminders.minutesBefore,
        isEnabled: reminders.isEnabled,
        notifyEmail: reminders.notifyEmail,
        notifySms: reminders.notifySms,
        customMessage: reminders.customMessage,
        createdAt: reminders.createdAt,
        userId: dutyAssignments.userId,
        userName: users.name,
        dutyLocation: duties.location,
        dutyStartTime: duties.startTime,
      })
      .from(reminders)
      .innerJoin(dutyAssignments, eq(dutyAssignments.id, reminders.assignmentId))
      .innerJoin(duties, eq(duties.id, dutyAssignments.dutyId))
      .leftJoin(users, eq(users.id, dutyAssignments.userId))
      .where(and(eq(reminders.schoolId, schoolId), eq(dutyAssignments.dutyId, dutyId)))
      .orderBy(desc(reminders.createdAt));

    return rows.map((r) => ({
      id: r.id,
      schoolId: r.schoolId,
      assignmentId: r.assignmentId,
      userId: r.userId,
      userName: r.userName,
      dutyLocation: r.dutyLocation,
      dutyStartTime: r.dutyStartTime ?? '',
      minutesBefore: r.minutesBefore,
      isEnabled: r.isEnabled,
      notifyEmail: r.notifyEmail,
      notifySms: r.notifySms,
      customMessage: r.customMessage,
      createdAt: r.createdAt.toISOString(),
    }));
  } finally {
    await close();
  }
}

export interface CreateResult {
  ok: boolean;
  reminderId?: string;
  error?: string;
}

export async function createReminder(
  schoolId: string,
  createdBy: string,
  input: CreateInput,
): Promise<CreateResult> {
  if (input.minutesBefore < 0 || input.minutesBefore > MAX_MINUTES) {
    return { ok: false, error: `minutesBefore must be between 0 and ${MAX_MINUTES}` };
  }
  if (!input.notifyEmail && !input.notifySms) {
    return { ok: false, error: 'At least one channel (email or sms) must be enabled.' };
  }
  if (input.customMessage && input.customMessage.length > MAX_CUSTOM_MESSAGE_LEN) {
    return { ok: false, error: `Custom message too long (max ${MAX_CUSTOM_MESSAGE_LEN} chars).` };
  }

  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return { ok: false, error: 'Server misconfigured.' };
  const { db, close } = getSystemClient(url);
  try {
    // Validate the assignment belongs to this school.
    const [assignment] = await db
      .select({ id: dutyAssignments.id, schoolId: dutyAssignments.schoolId })
      .from(dutyAssignments)
      .where(and(
        eq(dutyAssignments.id, input.assignmentId),
        eq(dutyAssignments.schoolId, schoolId),
      ))
      .limit(1);

    if (!assignment) {
      return { ok: false, error: 'Assignment not found in this school.' };
    }

    const [row] = await db
      .insert(reminders)
      .values({
        schoolId,
        assignmentId: input.assignmentId,
        minutesBefore: input.minutesBefore,
        notifyEmail: input.notifyEmail ?? true,
        notifySms: input.notifySms ?? false,
        customMessage: input.customMessage?.trim() || null,
        createdBy,
        isEnabled: true,
      })
      .returning({ id: reminders.id });
    if (!row) return { ok: false, error: 'Insert failed.' };

    logger.info(
      { reminderId: row.id, schoolId, assignmentId: input.assignmentId, minutesBefore: input.minutesBefore },
      'reminders: created',
    );
    return { ok: true, reminderId: row.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, msg, schoolId, input }, 'reminders: create failed');
    return { ok: false, error: msg };
  } finally {
    await close();
  }
}

export async function updateReminder(
  schoolId: string,
  reminderId: string,
  patch: UpdateInput,
): Promise<CreateResult> {
  if (patch.minutesBefore !== undefined &&
      (patch.minutesBefore < 0 || patch.minutesBefore > MAX_MINUTES)) {
    return { ok: false, error: `minutesBefore must be between 0 and ${MAX_MINUTES}` };
  }
  if (patch.notifyEmail === false && patch.notifySms === false) {
    return { ok: false, error: 'At least one channel must remain enabled.' };
  }
  if (patch.customMessage !== undefined && patch.customMessage !== null &&
      patch.customMessage.length > MAX_CUSTOM_MESSAGE_LEN) {
    return { ok: false, error: `Custom message too long (max ${MAX_CUSTOM_MESSAGE_LEN} chars).` };
  }

  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return { ok: false, error: 'Server misconfigured.' };
  const { db, close } = getSystemClient(url);
  try {
    const result = await db
      .update(reminders)
      .set({
        ...(patch.minutesBefore !== undefined ? { minutesBefore: patch.minutesBefore } : {}),
        ...(patch.notifyEmail !== undefined ? { notifyEmail: patch.notifyEmail } : {}),
        ...(patch.notifySms !== undefined ? { notifySms: patch.notifySms } : {}),
        ...(patch.customMessage !== undefined ? { customMessage: patch.customMessage?.trim() || null } : {}),
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
      })
      .where(and(eq(reminders.id, reminderId), eq(reminders.schoolId, schoolId)));

    if (result.rowCount === 0) {
      return { ok: false, error: 'Reminder not found.' };
    }
    return { ok: true };
  } finally {
    await close();
  }
}

export async function toggleReminder(
  schoolId: string,
  reminderId: string,
): Promise<CreateResult> {
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return { ok: false, error: 'Server misconfigured.' };
  const { db, close } = getSystemClient(url);
  try {
    // Atomic toggle: UPDATE ... SET is_enabled = NOT is_enabled
    const result = await db.execute(
      // raw SQL because Drizzle's .update() can't toggle a column directly
      // without a read-then-write race.
      // The cast ${reminders.isEnabled} expands to the column name; we
      // reference the table by its PG name.
      // SAFETY: scoped by school_id via WHERE.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ sql: `UPDATE reminders SET is_enabled = NOT is_enabled, updated_at = now()
               WHERE id = $1 AND school_id = $2`, params: [reminderId, schoolId] } as any),
    );
    if ((result as { rowCount?: number }).rowCount === 0) {
      return { ok: false, error: 'Reminder not found.' };
    }
    return { ok: true };
  } finally {
    await close();
  }
}

export async function deleteReminder(
  schoolId: string,
  reminderId: string,
): Promise<CreateResult> {
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return { ok: false, error: 'Server misconfigured.' };
  const { db, close } = getSystemClient(url);
  try {
    const result = await db
      .delete(reminders)
      .where(and(eq(reminders.id, reminderId), eq(reminders.schoolId, schoolId)));
    if (result.rowCount === 0) {
      return { ok: false, error: 'Reminder not found.' };
    }
    logger.info({ reminderId, schoolId }, 'reminders: deleted');
    return { ok: true };
  } finally {
    await close();
  }
}

/**
 * Look up the most recent assignment for a duty + user. Used by the
 * UI to know which assignment_id to attach a new reminder to. When
 * a teacher has multiple assignments (e.g. they take over from
 * someone), the most recent is the active one.
 */
export async function findActiveAssignmentForDuty(
  schoolId: string,
  dutyId: string,
): Promise<{ id: string; userId: string; userName: string } | null> {
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  const { db, close } = getSystemClient(url);
  try {
    const [row] = await db
      .select({
        id: dutyAssignments.id,
        userId: dutyAssignments.userId,
        userName: users.name,
      })
      .from(dutyAssignments)
      .leftJoin(users, eq(users.id, dutyAssignments.userId))
      .where(and(
        eq(dutyAssignments.schoolId, schoolId),
        eq(dutyAssignments.dutyId, dutyId),
      ))
      .orderBy(desc(dutyAssignments.startDate))
      .limit(1);
    return row?.id ? { id: row.id, userId: row.userId ?? '', userName: row.userName ?? 'Unknown' } : null;
  } finally {
    await close();
  }
}