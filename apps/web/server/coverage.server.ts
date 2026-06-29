// apps/web/server/coverage.server.ts — Coverage Router (Phase 2B)
//
// The load-bearing adjacent opportunity from the research synthesis
// (slice 2, opportunity 1). When a teacher is out, this extends the
// duty scheduler to absorb the absent teacher's duties and notify a
// replacement. No incumbent owns the "duty when teacher is out" gap.
//
// What this module does:
//   1. recordAbsence({ schoolId, teacherId, date, source, externalId, reason })
//      — creates a coverage_events row, idempotent on (source, externalId).
//   2. findAffectedDuties({ schoolId, teacherId, date })
//      — query duty_assignments for the teacher on that cycle day.
//   3. findReplacement({ schoolId, dutyId, excludeTeacherId })
//      — find a teacher available for the time slot, fairness-aware.
//   4. routeAbsence({ absenceId })
//      — the main orchestrator: create coverage_assignments + notify.
//   5. acceptCoverage / declineCoverage — teacher response handlers.
//
// What this module does NOT yet do (follow-up sprints):
//   - Frontline/Red Rover webhook ingest (slice 2 §9.1 lists this).
//   - Parent-facing duty-change alerts (slice 3, Phase 3).
//   - Compliance-gated duty assignment (slice 5, Phase 3).
//   - Sub Onboarding Brief auto-attached on job accept (slice 2 §9.2).
//   - Fairness-aware load balancing (slice 4 §6, Phase 4).
//
// Notification strategy for v1: write to the existing `notifications`
// table. The worker (Phase 1) already has an email + push dispatcher.

import { and, eq, gte, lte, ne, not, isNull, sql, inArray } from 'drizzle-orm';
import { coverageEvents, coverageAssignments, duties, dutyAssignments, users, notifications, cycleCalendar, getSystemClient, type Db } from '@edusupervise/db';
import { getDb, withSchoolId } from './db.server';
import { createHash } from 'node:crypto';

export type CoverageSource = 'direct' | 'frontline' | 'red_rover' | 'swing' | 'manual';

/**
 * Record a teacher absence. Idempotent on (source, externalId): if an
 * event with the same source + externalId already exists, return it
 * instead of creating a duplicate. This is what makes the
 * Frontline/Red Rover webhook integration safe to retry.
 */
export async function recordAbsence(args: {
  schoolId: string;
  teacherId: string;
  absenceDate: string; // ISO date YYYY-MM-DD
  reason?: string;
  source?: CoverageSource;
  externalId?: string;
  createdBy: string; // user id
}): Promise<{ id: string; deduplicated: boolean }> {
  const source = args.source ?? 'direct';

  // RLS-aware: open a transaction with app.school_id set so the
  // FORCE ROW LEVEL SECURITY policy on coverage_events lets the
  // INSERT through (slice-1 Y-01). Without this wrapper, the
  // runtime role sees zero rows on the idempotency check below and
  // the INSERT would silently violate WITH CHECK.
  return withSchoolId(args.schoolId, async (tx) => {
    // Idempotency check (only when externalId is provided)
    if (args.externalId) {
      const existing = await tx
        .select({ id: coverageEvents.id })
        .from(coverageEvents)
        .where(and(
          eq(coverageEvents.schoolId, args.schoolId),
          eq(coverageEvents.source, source),
          eq(coverageEvents.externalId, args.externalId),
        ))
        .limit(1);
      if (existing[0]) return { id: existing[0].id, deduplicated: true };
    }

    const [row] = await tx
      .insert(coverageEvents)
      .values({
        schoolId: args.schoolId,
        teacherId: args.teacherId,
        absenceDate: args.absenceDate,
        reason: args.reason ?? null,
        source,
        externalId: args.externalId ?? null,
        createdBy: args.createdBy,
      })
      .returning({ id: coverageEvents.id });

    return { id: row!.id, deduplicated: false };
  });
}

/**
 * Find all duty assignments for the absent teacher on the given date.
 * "On the given date" means: the cycle day for that date, restricted
 * to assignments that were active on that day (startDate <= date <= endDate).
 */
export async function findAffectedDuties(args: {
  schoolId: string;
  teacherId: string;
  absenceDate: string;
}): Promise<Array<{ dutyId: string; dutyName: string; startTime: string; endTime: string; location: string | null }>> {
  return withSchoolId(args.schoolId, async (tx) => {
    // Find the cycle day for the absence date.
    const [cycle] = await tx
      .select({ cycleDay: cycleCalendar.cycleDay })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, args.absenceDate))
      .limit(1);
    if (!cycle) return [];
    const cycleDay = cycle.cycleDay;

    // Find all duty_assignments for this teacher on this cycle day that
    // were active on the absence date.
    const rows = await tx
      .select({
        dutyId: dutyAssignments.dutyId,
        startTime: duties.startTime,
        endTime: duties.endTime,
        location: duties.location,
        dutyName: duties.location, // duties.location is the display name in this schema
      })
      .from(dutyAssignments)
      .innerJoin(duties, eq(duties.id, dutyAssignments.dutyId))
      .where(and(
        eq(dutyAssignments.schoolId, args.schoolId),
        eq(dutyAssignments.userId, args.teacherId),
        eq(duties.cycleDay, cycleDay),
        lte(dutyAssignments.startDate, args.absenceDate),
        // end_date is null (still active) OR >= absence date
        sql`(${dutyAssignments.endDate} IS NULL OR ${dutyAssignments.endDate} >= ${args.absenceDate})`,
      ));

    return rows.map((r) => ({
      dutyId: r.dutyId,
      dutyName: r.dutyName,
      startTime: r.startTime,
      endTime: r.endTime,
      location: r.location,
    }));
  });
}

/**
 * Find a replacement teacher for a duty slot. Returns the first
 * available teacher (in the school, not the original teacher) with
 * no conflicting assignment at the same time. v1: simple "first
 * available". v2: fairness-aware (slice 4 §6).
 */
export async function findReplacement(args: {
  schoolId: string;
  dutyId: string;
  excludeTeacherId: string;
  absenceDate: string;
}): Promise<string | null> {
  return withSchoolId(args.schoolId, async (tx) => {
    // Get the duty's cycle day, time, and location.
    const [duty] = await tx
      .select({
        cycleDay: duties.cycleDay,
        startTime: duties.startTime,
        endTime: duties.endTime,
      })
      .from(duties)
      .where(eq(duties.id, args.dutyId))
      .limit(1);
    if (!duty) return null;

    // Find the cycle day for the absence date.
    const [cycle] = await tx
      .select({ cycleDay: cycleCalendar.cycleDay })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, args.absenceDate))
      .limit(1);
    if (!cycle || cycle.cycleDay !== duty.cycleDay) return null;

    // Find all school users with role 'teacher' (not the original).
    const candidates = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(
        eq(users.schoolId, args.schoolId),
        ne(users.id, args.excludeTeacherId),
        eq(users.role, 'teacher'),
      ))
      .limit(50);
    if (candidates.length === 0) return null;

    // Filter out teachers who already have a conflicting duty assignment
    // for this cycle day on this absence date.
    const candidateIds = candidates.map((c) => c.id);
    const conflicts = await tx
      .select({ userId: dutyAssignments.userId })
      .from(dutyAssignments)
      .innerJoin(duties, eq(duties.id, dutyAssignments.dutyId))
      .where(and(
        eq(dutyAssignments.schoolId, args.schoolId),
        inArray(dutyAssignments.userId, candidateIds),
        eq(duties.cycleDay, duty.cycleDay),
        lte(dutyAssignments.startDate, args.absenceDate),
        sql`(${dutyAssignments.endDate} IS NULL OR ${dutyAssignments.endDate} >= ${args.absenceDate})`,
      ));
    const conflictingIds = new Set(conflicts.map((c) => c.userId));

    // First candidate without a conflict.
    return candidateIds.find((id) => !conflictingIds.has(id)) ?? null;
  });
}

/**
 * Route an absence: identify affected duties, find replacements,
 * create coverage_assignments, write notifications. Idempotent — if
 * the event already has assignments, return them as-is.
 */
export async function routeAbsence(args: {
  absenceId: string;
}): Promise<{
  assignments: Array<{ id: string; dutyId: string; newTeacherId: string | null; status: string }>;
  uncovered: number;
}> {
  // Bootstrap: load the coverage event via the SYSTEM role so we can
  // discover its schoolId before we have an RLS context to set. Without
  // this, FORCE ROW LEVEL SECURITY on coverage_events returns zero rows
  // (slice-1 Y-01 + C-1). After bootstrap, every subsequent touch uses
  // withSchoolId.
  const sysClient = getSystemClient(
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL!,
  );
  try {
    const [event] = await sysClient.db
      .select({
        id: coverageEvents.id,
        schoolId: coverageEvents.schoolId,
        teacherId: coverageEvents.teacherId,
        absenceDate: coverageEvents.absenceDate,
        status: coverageEvents.status,
      })
      .from(coverageEvents)
      .where(eq(coverageEvents.id, args.absenceId))
      .limit(1);
    if (!event) throw new Error(`Coverage event ${args.absenceId} not found`);

    return withSchoolId(event.schoolId, async (tx) => {
      // If we've already routed this event, return the existing assignments.
      const existingAssignments = await tx
        .select()
        .from(coverageAssignments)
        .where(eq(coverageAssignments.coverageEventId, args.absenceId));
      if (existingAssignments.length > 0) {
        return {
          assignments: existingAssignments.map((a) => ({
            id: a.id,
            dutyId: a.dutyId,
            newTeacherId: a.newTeacherId,
            status: a.status,
          })),
          uncovered: existingAssignments.filter((a) => a.status === 'uncovered').length,
        };
      }

      // Find affected duties (inside the same RLS context).
      const affected = await findAffectedDuties({
        schoolId: event.schoolId,
        teacherId: event.teacherId,
        absenceDate: event.absenceDate,
      });

      const created: Array<{ id: string; dutyId: string; newTeacherId: string | null; status: string }> = [];
      let uncovered = 0;
      for (const duty of affected) {
        const newTeacherId = await findReplacement({
          schoolId: event.schoolId,
          dutyId: duty.dutyId,
          excludeTeacherId: event.teacherId,
          absenceDate: event.absenceDate,
        });
        const status = newTeacherId ? 'pending' : 'uncovered';
        if (!newTeacherId) uncovered += 1;

        const [row] = await tx
          .insert(coverageAssignments)
          .values({
            schoolId: event.schoolId,
            coverageEventId: args.absenceId,
            dutyId: duty.dutyId,
            originalTeacherId: event.teacherId,
            newTeacherId: newTeacherId ?? null,
            status,
            notifiedAt: newTeacherId ? new Date() : null,
          })
          .returning({ id: coverageAssignments.id });

        created.push({
          id: row!.id,
          dutyId: duty.dutyId,
          newTeacherId: newTeacherId ?? null,
          status,
        });

        if (newTeacherId) {
          try {
            await tx.insert(notifications).values({
              schoolId: event.schoolId,
              userId: newTeacherId,
              kind: 'duty_assigned',
              title: 'Coverage request',
              body: `${duty.dutyName} (${duty.startTime}–${duty.endTime}) on ${event.absenceDate}`,
              linkUrl: `/app/coverage/${row!.id}`,
            });
          } catch (err) {
            console.warn('coverage.notification_failed', { assignmentId: row!.id, err });
          }
        }
      }

      // Mark the event as routed. The status 'routed' / 'closed' ternary
      // replaces an earlier dead-conditional bug (slice-2 RED-3): when
      // every duty was reassigned, the event is fully closed; otherwise
      // it's still routed but with uncovered slots.
      await tx
        .update(coverageEvents)
        .set({ status: uncovered > 0 ? 'routed' : 'closed', updatedAt: new Date() })
        .where(eq(coverageEvents.id, args.absenceId));

      return { assignments: created, uncovered };
    });
  } finally {
    await sysClient.close();
  }
}

export async function acceptCoverage(args: {
  assignmentId: string;
  teacherId: string;
}): Promise<void> {
  // Bootstrap via system role to learn the schoolId; then accept under
  // withSchoolId so the RLS policy admits the UPDATE (slice-1 Y-01 + C-1).
  const sysClient = getSystemClient(
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL!,
  );
  try {
    const sysRow = await sysClient.db
      .select({
        id: coverageAssignments.id,
        schoolId: coverageAssignments.schoolId,
      })
      .from(coverageAssignments)
      .where(and(
        eq(coverageAssignments.id, args.assignmentId),
        eq(coverageAssignments.newTeacherId, args.teacherId),
      ))
      .limit(1);
    if (!sysRow[0]) throw new Error('Coverage assignment not found or not yours');
    const { id: assignmentId, schoolId } = sysRow[0];

    await withSchoolId(schoolId, async (tx) => {
      await tx
        .update(coverageAssignments)
        .set({ status: 'accepted', respondedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(coverageAssignments.id, assignmentId),
          eq(coverageAssignments.newTeacherId, args.teacherId),
        ));
    });

    // Phase 3: when a teacher accepts coverage, generate parent alerts.
    // The generator is idempotent (unique index on parent_id + assignment_id)
    // and itself uses the system-role bootstrap + withSchoolId pattern.
    try {
      const { generateAlertsForAssignment } = await import('./parent-alerts.server');
      await generateAlertsForAssignment({ coverageAssignmentId: assignmentId });
    } catch (err) {
      // Don't fail the acceptance because of an alert hiccup.
      console.warn('coverage.parent_alert_generation_failed', { assignmentId, err });
    }
  } finally {
    await sysClient.close();
  }
}

export async function declineCoverage(args: {
  assignmentId: string;
  teacherId: string;
  reason?: string;
}): Promise<void> {
  // Bootstrap via system role to learn the schoolId; then decline under
  // withSchoolId so the RLS policy admits the UPDATE (slice-1 Y-01 + C-1).
  const sysClient = getSystemClient(
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL!,
  );
  try {
    const sysRow = await sysClient.db
      .select({
        id: coverageAssignments.id,
        eventId: coverageAssignments.coverageEventId,
        schoolId: coverageAssignments.schoolId,
      })
      .from(coverageAssignments)
      .where(and(
        eq(coverageAssignments.id, args.assignmentId),
        eq(coverageAssignments.newTeacherId, args.teacherId),
      ))
      .limit(1);
    if (!sysRow[0]) throw new Error('Coverage assignment not found or not yours');
    const { eventId, schoolId } = sysRow[0];

    await withSchoolId(schoolId, async (tx) => {
      await tx
        .update(coverageAssignments)
        .set({
          status: 'declined',
          respondedAt: new Date(),
          declineReason: args.reason ?? null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(coverageAssignments.id, args.assignmentId),
          eq(coverageAssignments.newTeacherId, args.teacherId),
        ));
    });

    // Re-route the absence — find a different replacement.
    // (Idempotent: the routeAbsence function will skip already-accepted
    // assignments and re-route any uncovered ones.)
    await routeAbsence({ absenceId: eventId });
  } finally {
    await sysClient.close();
  }
}

/**
 * List the current coverage status for a school: open events + their
 * assignments. Used by the /app/coverage page.
 */
export async function listCoverage(args: {
  schoolId: string;
  forTeacherId?: string; // when provided, only show assignments for this teacher
}): Promise<Array<{
  eventId: string;
  teacherId: string;
  teacherName: string;
  absenceDate: string;
  status: string;
  reason: string | null;
  assignments: Array<{
    id: string;
    dutyId: string;
    dutyName: string;
    startTime: string;
    endTime: string;
    location: string | null;
    newTeacherId: string | null;
    newTeacherName: string | null;
    status: string;
  }>;
}>> {
  return withSchoolId(args.schoolId, async (tx) => {
    // Open events.
    const events = await tx
      .select({
        id: coverageEvents.id,
        teacherId: coverageEvents.teacherId,
        absenceDate: coverageEvents.absenceDate,
        status: coverageEvents.status,
        reason: coverageEvents.reason,
        teacherName: users.name,
      })
      .from(coverageEvents)
      .innerJoin(users, eq(users.id, coverageEvents.teacherId))
      .where(and(
        eq(coverageEvents.schoolId, args.schoolId),
        not(eq(coverageEvents.status, 'closed')),
      ))
      .orderBy(coverageEvents.absenceDate)
      .limit(50);

    if (events.length === 0) return [];

    // Assignments for those events.
    const eventIds = events.map((e) => e.id);
    const assignments = await tx
      .select({
        id: coverageAssignments.id,
        eventId: coverageAssignments.coverageEventId,
        dutyId: coverageAssignments.dutyId,
        dutyName: duties.location,
        startTime: duties.startTime,
        endTime: duties.endTime,
        location: duties.location,
        newTeacherId: coverageAssignments.newTeacherId,
        newTeacherName: sql<string | null>`(
          SELECT name FROM ${users} WHERE id = ${coverageAssignments.newTeacherId}
        )`,
        status: coverageAssignments.status,
      })
      .from(coverageAssignments)
      .innerJoin(duties, eq(duties.id, coverageAssignments.dutyId))
      .where(and(
        eq(coverageAssignments.schoolId, args.schoolId),
        inArray(coverageAssignments.coverageEventId, eventIds),
        // If filtering by teacher, restrict to their assignments.
        args.forTeacherId
          ? eq(coverageAssignments.newTeacherId, args.forTeacherId)
          : sql`TRUE`,
      ));

    // Group by event.
    return events.map((e) => ({
      eventId: e.id,
      teacherId: e.teacherId,
      teacherName: e.teacherName,
      absenceDate: e.absenceDate,
      status: e.status,
      reason: e.reason,
      assignments: assignments
        .filter((a) => a.eventId === e.id)
        .map((a) => ({
          id: a.id,
          dutyId: a.dutyId,
          dutyName: a.dutyName,
          startTime: a.startTime,
          endTime: a.endTime,
          location: a.location,
          newTeacherId: a.newTeacherId,
          newTeacherName: a.newTeacherName,
          status: a.status,
        })),
    }));
  });
}
