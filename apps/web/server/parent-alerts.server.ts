// apps/web/server/parent-alerts.server.ts — Parent-facing duty alerts (Phase 3)
//
// When the Coverage Router accepts a coverage request (Phase 2B), this
// generates a targeted parent alert for each parent whose students are
// associated with the duty. The alert is stored as a draft; a v1 mock
// "send" endpoint flips it to 'sent'. v2 will dispatch via SMS
// (Twilio) or email (Resend) — both packages already exist in
// apps/web/package.json.
//
// Slice 3 §9.1: "Alert parents when their kid's bus/recess/dismissal
// supervisor changes." The product: any time EduSupervise detects a
// coverage change on a duty that touches a specific child's day, it
// auto-generates a targeted parent message. Not a mass-blast — a
// one-to-many push ONLY to the parents of the affected children.
//
// Slice 3 §2 (FERPA): "telling a parent 'your child's bus is now
// supervised by Ms. Lee instead of Mr. Brown' is legally fine. It's
// operational info adjacent to a child's schedule, not PII." Use
// operational framing, never personnel/medical framing.

import { and, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import {
  parentContacts,
  parentRouteTags,
  parentAlerts,
  coverageAssignments,
  coverageEvents,
  users,
  duties,
  getSystemClient,
  type Db,
} from '@edusupervise/db';
import { getDb, withSchoolId } from './db.server';

export type ParentAlertChannel = 'sms' | 'email' | 'app';
export type ParentAlertStatus = 'draft' | 'queued' | 'sent' | 'failed' | 'cancelled';

/**
 * Add a parent contact. Idempotent on (school_id, phone) when phone is
 * provided. Returns the new (or existing) parent id.
 */
export async function recordParentContact(args: {
  schoolId: string;
  name: string;
  phone?: string;
  email?: string;
  language?: string;
  routeTags?: string[];
}): Promise<{ id: string }> {
  // RLS-aware (slice-1 Y-02 + C-1): open a transaction with the
  // school context set so the FORCE ROW LEVEL SECURITY policy on
  // parent_contacts lets the SELECT + INSERT through.
  return withSchoolId(args.schoolId, async (tx) => {
    // Idempotency check on phone (when present)
    if (args.phone) {
      const existing = await tx
        .select({ id: parentContacts.id })
        .from(parentContacts)
        .where(and(
          eq(parentContacts.schoolId, args.schoolId),
          eq(parentContacts.phone, args.phone),
        ))
        .limit(1);
      if (existing[0]) {
        // Update tags if provided
        if (args.routeTags && args.routeTags.length > 0) {
          await setParentRouteTags(existing[0].id, args.routeTags);
        }
        return { id: existing[0].id };
      }
    }

    const [row] = await tx
      .insert(parentContacts)
      .values({
        schoolId: args.schoolId,
        name: args.name,
        phone: args.phone ?? null,
        email: args.email ?? null,
        language: args.language ?? 'en',
      })
      .returning({ id: parentContacts.id });

    if (args.routeTags && args.routeTags.length > 0) {
      await setParentRouteTags(row!.id, args.routeTags);
    }

    return { id: row!.id };
  });
}

async function setParentRouteTags(parentId: string, tags: string[]): Promise<void> {
  const db = getDb();
  // Get the school_id for the parent so we can insert with the right tenant scope.
  const [parent] = await db
    .select({ schoolId: parentContacts.schoolId })
    .from(parentContacts)
    .where(eq(parentContacts.id, parentId))
    .limit(1);
  if (!parent) return;
  // Wipe existing tags for this parent + insert new ones.
  await db.delete(parentRouteTags).where(eq(parentRouteTags.parentId, parentId));
  if (tags.length > 0) {
    await db.insert(parentRouteTags).values(
      tags.map((tag) => ({
        schoolId: parent.schoolId,
        parentId,
        tag,
      })),
    );
  }
}

/**
 * List parent contacts for a school (excludes opted-out).
 */
export async function listParentContacts(args: {
  schoolId: string;
  limit?: number;
}): Promise<Array<{
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  language: string;
  routeTags: string[];
}>> {
  return withSchoolId(args.schoolId, async (tx) => {
    const parents = await tx
      .select({
        id: parentContacts.id,
        name: parentContacts.name,
        phone: parentContacts.phone,
        email: parentContacts.email,
        language: parentContacts.language,
      })
      .from(parentContacts)
      .where(and(
        eq(parentContacts.schoolId, args.schoolId),
        isNull(parentContacts.optedOutAt),
      ))
      .limit(args.limit ?? 200);

    if (parents.length === 0) return [];

    const tags = await tx
      .select({ parentId: parentRouteTags.parentId, tag: parentRouteTags.tag })
      .from(parentRouteTags)
      .where(inArray(parentRouteTags.parentId, parents.map((p) => p.id)));

    return parents.map((p) => ({
      ...p,
      routeTags: tags.filter((t) => t.parentId === p.id).map((t) => t.tag),
    }));
  });
}

/**
 * Generate parent alerts for an accepted coverage assignment.
 *
 * Triggered by coverage.server.ts acceptCoverage() — when a teacher
 * accepts a coverage request, we look up the duty's location (e.g.,
 * "Bus 7"), find parents in the school whose route_tags include
 * that location, and create one parent_alert per matching parent in
 * 'draft' status. Idempotent on (parent_id, coverage_assignment_id).
 *
 * v1: just generates drafts. v2: dispatches via Twilio/Resend. v3:
 * routes through ParentSquare/Remind/TalkingPoints (slice 3 §6).
 */
export async function generateAlertsForAssignment(args: {
  coverageAssignmentId: string;
}): Promise<{ created: number; skipped: number }> {
  // First pass: load the assignment using the SYSTEM role (RLS-bypass).
  // This is the bootstrap look-up case — the caller (acceptCoverage) does
  // not always know the schoolId until it loads the row. We use the system
  // client for the read, then re-open with the runtime client + RLS
  // context for every subsequent touch.
  const systemClient = getSystemClient(
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL!,
  );
  const sysDb = systemClient.db;
  try {
    const [assignment] = await sysDb
      .select({
        id: coverageAssignments.id,
        schoolId: coverageAssignments.schoolId,
        dutyId: coverageAssignments.dutyId,
        originalTeacherId: coverageAssignments.originalTeacherId,
        newTeacherId: coverageAssignments.newTeacherId,
        eventId: coverageAssignments.coverageEventId,
        absenceDate: coverageEvents.absenceDate,
        dutyLocation: duties.location,
        dutyStartTime: duties.startTime,
        dutyEndTime: duties.endTime,
        originalTeacherName: users.name,
      })
      .from(coverageAssignments)
      .innerJoin(coverageEvents, eq(coverageEvents.id, coverageAssignments.coverageEventId))
      .innerJoin(duties, eq(duties.id, coverageAssignments.dutyId))
      .innerJoin(users, eq(users.id, coverageAssignments.originalTeacherId))
      .where(eq(coverageAssignments.id, args.coverageAssignmentId))
      .limit(1);
    if (!assignment) return { created: 0, skipped: 0 };
    if (!assignment.newTeacherId) return { created: 0, skipped: 0 }; // uncovered

    // RLS-aware second pass: open a transaction with app.school_id set
    // (slice-1 Y-02 + C-1) and do the new-teacher lookup + parent match +
    // insert under that context. The FORCE ROW LEVEL SECURITY policy on
    // coverage_assignments, parent_contacts, and parent_alerts admits
    // the reads/writes; WITH CHECK guarantees the schoolId matches.
    return withSchoolId(assignment.schoolId, async (tx) => {
      if (!assignment.newTeacherId) return { created: 0, skipped: 0 };
      const [newTeacher] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, assignment.newTeacherId))
        .limit(1);
      const newTeacherName = newTeacher?.name ?? 'A substitute teacher';

      // Find parents in this school whose route_tags include the duty location.
      // Exact match — v1.
      const matchingParents = await tx
        .select({ id: parentContacts.id })
        .from(parentContacts)
        .innerJoin(parentRouteTags, eq(parentRouteTags.parentId, parentContacts.id))
        .where(and(
          eq(parentContacts.schoolId, assignment.schoolId),
          eq(parentRouteTags.tag, assignment.dutyLocation),
          isNull(parentContacts.optedOutAt),
        ));

      if (matchingParents.length === 0) return { created: 0, skipped: 0 };

      const subject = `Coverage update for ${assignment.dutyLocation}`;
      const bodyShort = shortSms({
        dutyLocation: assignment.dutyLocation,
        dutyTime: `${formatTime12h(assignment.dutyStartTime)}–${formatTime12h(assignment.dutyEndTime)}`,
        date: assignment.absenceDate,
        newTeacherName,
      });
      const bodyLong = longEmail({
        dutyLocation: assignment.dutyLocation,
        dutyTime: `${formatTime12h(assignment.dutyStartTime)}–${formatTime12h(assignment.dutyEndTime)}`,
        date: assignment.absenceDate,
        originalTeacherName: assignment.originalTeacherName,
        newTeacherName,
      });

      let created = 0;
      let skipped = 0;
      for (const parent of matchingParents) {
        try {
          await tx
            .insert(parentAlerts)
            .values({
              schoolId: assignment.schoolId,
              parentId: parent.id,
              coverageAssignmentId: assignment.id,
              channel: 'sms',
              subject,
              bodyShort,
              bodyLong,
              status: 'draft',
            })
            .onConflictDoNothing({
              target: [parentAlerts.parentId, parentAlerts.coverageAssignmentId],
            });
          created += 1;
        } catch (err) {
          // Audit slice-2 RED-2: the previous catch swallowed ALL errors
          // (including real DB failures — connection drops, FK violations,
          // runtime-role denials) and silently counted them as 'skipped'.
          // The intent was idempotency on the unique(parent, assignment)
          // index, which `onConflictDoNothing` already handles WITHOUT
          // throwing. So a throw here means a real DB failure — surface it.
          const pgCode =
            err && typeof err === 'object' && 'code' in err
              ? (err as { code?: string }).code
              : undefined;
          if (pgCode === '23505') {
            // Unique violation — race with another writer for the same
            // (parent, assignment) pair. Safe to skip silently.
            skipped += 1;
          } else {
            // Real failure — log + re-throw so the transaction rolls back
            // and the coverage.accept handler reports it to the user.
            throw err;
          }
        }
      }
      return { created, skipped };
    });
  } finally {
    await systemClient.close();
  }
}

/**
 * List parent alerts for a school, optionally filtered by status.
 */
export async function listAlerts(args: {
  schoolId: string;
  status?: ParentAlertStatus;
  limit?: number;
}): Promise<Array<{
  id: string;
  parentId: string;
  parentName: string;
  parentPhone: string | null;
  parentEmail: string | null;
  channel: ParentAlertChannel;
  subject: string | null;
  bodyShort: string;
  bodyLong: string | null;
  status: ParentAlertStatus;
  sentAt: string | null;
  createdAt: string;
  dutyLocation: string;
  dutyStartTime: string;
  dutyEndTime: string;
  absenceDate: string;
  newTeacherName: string | null;
}>> {
  return withSchoolId(args.schoolId, async (tx) => {
    const alerts = await tx
      .select({
        id: parentAlerts.id,
        parentId: parentAlerts.parentId,
        parentName: parentContacts.name,
        parentPhone: parentContacts.phone,
        parentEmail: parentContacts.email,
        channel: parentAlerts.channel,
        subject: parentAlerts.subject,
        bodyShort: parentAlerts.bodyShort,
        bodyLong: parentAlerts.bodyLong,
        status: parentAlerts.status,
        sentAt: parentAlerts.sentAt,
        createdAt: parentAlerts.createdAt,
        dutyLocation: duties.location,
        dutyStartTime: duties.startTime,
        dutyEndTime: duties.endTime,
        absenceDate: coverageEvents.absenceDate,
        newTeacherName: sql<string | null>`(
          SELECT name FROM ${users} WHERE id = ${coverageAssignments.newTeacherId}
        )`,
      })
      .from(parentAlerts)
      .innerJoin(parentContacts, eq(parentContacts.id, parentAlerts.parentId))
      .innerJoin(coverageAssignments, eq(coverageAssignments.id, parentAlerts.coverageAssignmentId))
      .innerJoin(coverageEvents, eq(coverageEvents.id, coverageAssignments.coverageEventId))
      .innerJoin(duties, eq(duties.id, coverageAssignments.dutyId))
      .where(and(
        eq(parentAlerts.schoolId, args.schoolId),
        args.status ? eq(parentAlerts.status, args.status) : sql`TRUE`,
      ))
      .orderBy(parentAlerts.createdAt)
      .limit(args.limit ?? 200);

    return alerts.map((a) => ({
      ...a,
      channel: a.channel as ParentAlertChannel,
      status: a.status as ParentAlertStatus,
      sentAt: a.sentAt ? a.sentAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    }));
  });
}

/**
 * Mock "send" — flips the alert from 'draft' to 'sent'. v1: just
 * updates the status. v2: actually dispatches via Twilio/Resend.
 */
export async function markAlertSent(alertId: string, schoolId: string): Promise<void> {
  // RLS-aware (slice-1 Y-02 + C-1): wrap in withSchoolId so the FORCE
  // ROW LEVEL SECURITY policy on parent_alerts admits the UPDATE. The
  // WITH CHECK clause also verifies school_id matches the GUC, so a
  // wrong schoolId in the call would surface as a 0-row update + a
  // thrown error.
  await withSchoolId(schoolId, async (tx) => {
    await tx
      .update(parentAlerts)
      .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
      .where(eq(parentAlerts.id, alertId));
  });
}

export async function cancelAlert(alertId: string, schoolId: string): Promise<void> {
  await withSchoolId(schoolId, async (tx) => {
    await tx
      .update(parentAlerts)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(parentAlerts.id, alertId));
  });
}

// ---------------------------------------------------------------------------
// Message templates (slice 3 §9.1 design)
// ---------------------------------------------------------------------------

/**
 * SMS-length message (max 160 chars). Operational framing, never
 * personnel/medical (slice 3 §2).
 */
function shortSms(args: {
  dutyLocation: string;
  dutyTime: string;
  date: string;
  newTeacherName: string;
}): string {
  const date = new Date(args.date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${args.dutyLocation} (${args.dutyTime}) on ${date} is now covered by ${args.newTeacherName}. Reply STOP to opt out.`;
}

function longEmail(args: {
  dutyLocation: string;
  dutyTime: string;
  date: string;
  originalTeacherName: string;
  newTeacherName: string;
}): string {
  const date = new Date(args.date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return [
    `Dear parent,`,
    ``,
    `Quick update about ${args.dutyLocation} on ${date}, ${args.dutyTime}.`,
    ``,
    `Your child's regular supervisor (${args.originalTeacherName}) is unavailable. ${args.newTeacherName} will be covering this duty.`,
    ``,
    `No action needed. If you have any questions, please contact the school office.`,
    ``,
    `— The school`,
    ``,
    `(To stop receiving these updates, reply STOP.)`,
  ].join('\n');
}

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = (h ?? 0) >= 12 ? 'PM' : 'AM';
  const h12 = (h ?? 0) % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
