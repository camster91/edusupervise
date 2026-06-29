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
  const db = getDb();

  // Idempotency check on phone (when present)
  if (args.phone) {
    const existing = await db
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

  const [row] = await db
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
  const db = getDb();

  // Load the assignment with its duty + the original teacher name.
  const [assignment] = await db
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
  if (!assignment.newTeacherId) return { created: 0, skipped: 0 }; // uncovered — no new teacher to alert about

  // Find the new teacher name for the message body.
  const [newTeacher] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, assignment.newTeacherId))
    .limit(1);
  const newTeacherName = newTeacher?.name ?? 'A substitute teacher';

  // Find parents in this school whose route_tags include the duty location.
  // Exact match — v1: "Bus 7" must match tag "Bus 7". v2: fuzzy match
  // (e.g., "Bus 7" matches tag "Bus").
  const matchingParents = await withSchoolId(assignment.schoolId, async (tx) => {
    return tx
      .select({ id: parentContacts.id })
      .from(parentContacts)
      .innerJoin(parentRouteTags, eq(parentRouteTags.parentId, parentContacts.id))
      .where(and(
        eq(parentContacts.schoolId, assignment.schoolId),
        eq(parentRouteTags.tag, assignment.dutyLocation),
        isNull(parentContacts.optedOutAt),
      ));
  });

  if (matchingParents.length === 0) return { created: 0, skipped: 0 };

  // Generate the message templates.
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

  // Insert one alert per parent. Idempotent on (parent_id, assignment_id)
  // — ON CONFLICT DO NOTHING (we handle the unique index in the migration).
  let created = 0;
  let skipped = 0;
  for (const parent of matchingParents) {
    try {
      await db
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
      // Conflict = already generated. Skip.
      skipped += 1;
    }
  }

  return { created, skipped };
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
export async function markAlertSent(alertId: string): Promise<void> {
  const db = getDb();
  await db
    .update(parentAlerts)
    .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
    .where(eq(parentAlerts.id, alertId));
}

export async function cancelAlert(alertId: string): Promise<void> {
  const db = getDb();
  await db
    .update(parentAlerts)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(parentAlerts.id, alertId));
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
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
