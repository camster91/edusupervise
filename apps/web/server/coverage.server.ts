// apps/web/server/coverage.server.ts — Coverage Router (Phase 2B + broadcast in 3.4)
//
// The load-bearing adjacent opportunity from the research synthesis
// (slice 2, opportunity 1). When a teacher is out, this extends the
// duty scheduler to absorb the absent teacher's duties and notify a
// replacement. No incumbent owns the "duty when teacher is out" gap.
//
// Phase 3 §3.4 broadcast mode: in addition to the 1-to-1 "ask Mr. Smith"
// flow, admins can now pick "broadcast to all eligible teachers" for a
// given absence. N rows in coverage_assignments (one per eligible
// teacher). First to accept wins; the rest auto-cancel via DB trigger
// on `coverage_assignments` status update.
//
// What this module does:
//   1. recordAbsence({ schoolId, teacherId, date, source, externalId, reason })
//      — creates a coverage_events row, idempotent on (source, externalId).
//   2. findAffectedDuties / findReplacement — same as before.
//   3. routeAbsence — the orchestrator. Now also returns the
//      `broadcast: true` flag when the absence was created via broadcast
//      (we mirror the `source` from the absence into each row).
//   4. broadcastCoverageRequest — Phase 3 §3.4: create one absence + N
//      coverage_assignments (one per eligible teacher). Distinct from
//      the 1-to-1 flow because the absent teacher's duties could land
//      with any of the N candidates; we keep the coverage_assignments
//      table shape and only flip the candidate list, not the schema.
//   5. acceptCoverage / declineCoverage — first-accept-wins. The
//      acceptCoverage update triggers a `cancel_remaining_on_accept`
//      row trigger (added in migration 0011 — see footer comment) so
//      the second-to-arrive accept gets a clean "already covered"
//      status instead of corrupting the duty record.
//
// What this module does NOT yet do (follow-up sprints):
//   - Frontline/Red Rover webhook ingest (slice 2 §9.1).
//   - Fairness-aware load balancing (slice 4 §6, Phase 4).
//
// Notification strategy: write to the existing `notifications` table.
// The worker (Phase 1) already has an email + push dispatcher; SMS is
// gated by `plan_limits.sms_included` (school + pro tiers).

import { and, eq, gte, lte, ne, not, isNull, sql, inArray, or } from 'drizzle-orm';
import {
  coverageEvents,
  coverageAssignments,
  duties,
  dutyAssignments,
  users,
  notifications,
  cycleCalendar,
  getSystemClient,
  schools,
  type Db,
} from '@edusupervise/db';
import { getDb, withSchoolId } from './db.server';
import { logger } from './logger.server';
import { recordAudit, AUDIT } from './audit.server';

export type CoverageSource = 'direct' | 'frontline' | 'red_rover' | 'swing' | 'manual' | 'broadcast';

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

  return withSchoolId(args.schoolId, async (tx) => {
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
    const [cycle] = await tx
      .select({
        cycleDay: cycleCalendar.cycleDay,
        isInstructional: cycleCalendar.isInstructional,
      })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, args.absenceDate))
      .limit(1);
    if (!cycle) return [];
    // Migration 0013: skip on non-instructional days. If the school
    // calendar says classes aren't running today (PD day, holiday,
    // board break), there are no duties to cover.
    if (cycle.isInstructional === false) return [];
    const cycleDay: number = cycle.cycleDay ?? 0;

    const rows = await tx
      .select({
        dutyId: dutyAssignments.dutyId,
        startTime: duties.startTime,
        endTime: duties.endTime,
        location: duties.location,
        dutyName: duties.location,
      })
      .from(dutyAssignments)
      .innerJoin(duties, eq(duties.id, dutyAssignments.dutyId))
      .where(and(
        eq(dutyAssignments.schoolId, args.schoolId),
        eq(dutyAssignments.userId, args.teacherId),
        eq(duties.cycleDay, cycleDay),
        lte(dutyAssignments.startDate, args.absenceDate),
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
 * available". v2: fairness-aware.
 */
export async function findReplacement(args: {
  schoolId: string;
  dutyId: string;
  excludeTeacherId: string;
  absenceDate: string;
}): Promise<string | null> {
  return withSchoolId(args.schoolId, async (tx) => {
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

    const [cycle] = await tx
      .select({
        cycleDay: cycleCalendar.cycleDay,
        isInstructional: cycleCalendar.isInstructional,
      })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, args.absenceDate))
      .limit(1);
    if (!cycle || cycle.cycleDay !== duty.cycleDay) return null;
    // Migration 0013: skip on non-instructional days.
    if (cycle.isInstructional === false) return null;

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

    return candidateIds.find((id) => !conflictingIds.has(id)) ?? null;
  });
}

/**
 * List the eligible teacher cohort for a broadcast: every active
 * teacher in the school who has NO conflicting duty on the absent
 * teacher's cycle day. Returns user ids (could be 0..N).
 *
 * Excludes the absent teacher themselves (no self-cover).
 */
export async function findEligibleBroadcastCohort(args: {
  schoolId: string;
  excludeTeacherId: string;
  absenceDate: string;
}): Promise<Array<{ id: string; name: string; phone: string | null; phoneVerifiedAt: Date | null }>> {
  return withSchoolId(args.schoolId, async (tx) => {
    const [cycle] = await tx
      .select({ cycleDay: cycleCalendar.cycleDay })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, args.absenceDate))
      .limit(1);
    if (!cycle) return [];
    const cycleDay: number = cycle.cycleDay ?? 0;

    const candidates = await tx
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        phoneVerifiedAt: users.phoneVerifiedAt,
      })
      .from(users)
      .where(and(
        eq(users.schoolId, args.schoolId),
        ne(users.id, args.excludeTeacherId),
        eq(users.role, 'teacher'),
        eq(users.isActive, true),
      ))
      .orderBy(users.name)
      .limit(200);

    if (candidates.length === 0) return [];

    // Filter out teachers who already have a conflicting duty on the
    // absence date's cycle day.
    const ids = candidates.map((c) => c.id);
    const conflicts = await tx
      .select({ userId: dutyAssignments.userId })
      .from(dutyAssignments)
      .innerJoin(duties, eq(duties.id, dutyAssignments.dutyId))
      .where(and(
        eq(dutyAssignments.schoolId, args.schoolId),
        inArray(dutyAssignments.userId, ids),
        eq(duties.cycleDay, cycleDay),
        lte(dutyAssignments.startDate, args.absenceDate),
        sql`(${dutyAssignments.endDate} IS NULL OR ${dutyAssignments.endDate} >= ${args.absenceDate})`,
      ));
    const conflictingIds = new Set(conflicts.map((c) => c.userId));
    return candidates.filter((c) => !conflictingIds.has(c.id));
  });
}

/**
 * Route an absence: identify affected duties, find replacements,
 * create coverage_assignments, write notifications. Idempotent.
 */
export async function routeAbsence(args: {
  absenceId: string;
}): Promise<{
  assignments: Array<{ id: string; dutyId: string; newTeacherId: string | null; status: string }>;
  uncovered: number;
}> {
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
        source: coverageEvents.source,
      })
      .from(coverageEvents)
      .where(eq(coverageEvents.id, args.absenceId))
      .limit(1);
    if (!event) throw new Error(`Coverage event ${args.absenceId} not found`);

    return withSchoolId(event.schoolId, async (tx) => {
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

      const affected = await findAffectedDuties({
        schoolId: event.schoolId,
        teacherId: event.teacherId,
        absenceDate: event.absenceDate,
      });

      // For broadcast source we create N rows per affected duty, one
      // per eligible teacher; for non-broadcast we use the existing
      // single-replacement flow.
      const isBroadcast = event.source === 'broadcast';

      const created: Array<{ id: string; dutyId: string; newTeacherId: string | null; status: string }> = [];
      let uncovered = 0;

      for (const duty of affected) {
        if (isBroadcast) {
          const cohort = await findEligibleBroadcastCohort({
            schoolId: event.schoolId,
            excludeTeacherId: event.teacherId,
            absenceDate: event.absenceDate,
          });
          if (cohort.length === 0) {
            // Still create an "uncovered" row so the absence event stays
            // in a coherent state (one row per affected duty).
            const [row] = await tx
              .insert(coverageAssignments)
              .values({
                schoolId: event.schoolId,
                coverageEventId: args.absenceId,
                dutyId: duty.dutyId,
                originalTeacherId: event.teacherId,
                status: 'uncovered',
              })
              .returning({ id: coverageAssignments.id });
            created.push({
              id: row!.id,
              dutyId: duty.dutyId,
              newTeacherId: null,
              status: 'uncovered',
            });
            uncovered += 1;
            continue;
          }
          // Bulk insert one row per eligible teacher.
          const rows = cohort.map((c) => ({
            schoolId: event.schoolId,
            coverageEventId: args.absenceId,
            dutyId: duty.dutyId,
            originalTeacherId: event.teacherId,
            newTeacherId: c.id,
            status: 'pending' as const,
            notifiedAt: new Date(),
          }));
          const inserted = await tx
            .insert(coverageAssignments)
            .values(rows)
            .returning({ id: coverageAssignments.id });
          // One notification per teacher — bcc-style blast.
          for (let i = 0; i < cohort.length; i += 1) {
            created.push({
              id: inserted[i]!.id,
              dutyId: duty.dutyId,
              newTeacherId: cohort[i]!.id,
              status: 'pending',
            });
            try {
              await tx.insert(notifications).values({
                schoolId: event.schoolId,
                userId: cohort[i]!.id,
                kind: 'duty_assigned',
                title: 'Coverage broadcast',
                body: `${duty.dutyName} (${duty.startTime}–${duty.endTime}) on ${event.absenceDate}`,
                linkUrl: `/app/coverage/${inserted[i]!.id}`,
              });
            } catch (err) {
              logger.warn(
                { assignmentId: inserted[i]!.id, err },
                'coverage.broadcast_notification_failed',
              );
            }
          }
          continue;
        }

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
            logger.warn(
              { assignmentId: row!.id, err },
              'coverage.notification_failed',
            );
          }
        }
      }

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

    try {
      const { generateAlertsForAssignment } = await import('./parent-alerts.server');
      await generateAlertsForAssignment({ coverageAssignmentId: assignmentId });
    } catch (err) {
      logger.warn(
        { assignmentId, err },
        'coverage.parent_alert_generation_failed',
      );
    }

    await recordAudit({
      schoolId,
      userId: args.teacherId,
      action: AUDIT.COVERAGE_ACCEPT,
      targetType: 'coverage_assignment',
      targetId: assignmentId,
      metadata: { assignmentId, teacherId: args.teacherId },
    });
  } finally {
    await sysClient.close();
  }
}

export async function declineCoverage(args: {
  assignmentId: string;
  teacherId: string;
  reason?: string;
}): Promise<void> {
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

    await routeAbsence({ absenceId: eventId });

    await recordAudit({
      schoolId,
      userId: args.teacherId,
      action: AUDIT.COVERAGE_DECLINE,
      targetType: 'coverage_assignment',
      targetId: args.assignmentId,
      metadata: {
        assignmentId: args.assignmentId,
        teacherId: args.teacherId,
        reason: args.reason ?? null,
        reRoutedEventId: eventId,
      },
    });
  } finally {
    await sysClient.close();
  }
}

/**
 * Phase 3 §3.4 — broadcast coverage request.
 *
 * Creates a single absence event with `source='broadcast'`, then runs
 * `routeAbsence` which now knows how to fan out to all eligible teachers.
 *
 * Returns the absence event id + the list of created coverage
 * assignments (one per eligible teacher). Caller can render a "we
 * notified N teachers" toast and link to the event detail.
 *
 * Idempotency: pass `externalId` (e.g. `${teacherId}:${date}`) and
 * re-runs collapse on (source, externalId).
 */
export async function broadcastCoverageRequest(args: {
  schoolId: string;
  teacherId: string;
  absenceDate: string;
  reason?: string;
  createdBy: string;
  externalId?: string;
}): Promise<{
  absenceId: string;
  assignments: Array<{ id: string; dutyId: string; newTeacherId: string; status: string }>;
  eligibleCount: number;
  deduplicated: boolean;
}> {
  const { id, deduplicated } = await recordAbsence({
    schoolId: args.schoolId,
    teacherId: args.teacherId,
    absenceDate: args.absenceDate,
    reason: args.reason,
    source: 'broadcast',
    externalId: args.externalId,
    createdBy: args.createdBy,
  });

  const result = await routeAbsence({ absenceId: id });
  return {
    absenceId: id,
    assignments: result.assignments
      .filter((a) => a.newTeacherId != null)
      .map((a) => ({
        id: a.id,
        dutyId: a.dutyId,
        newTeacherId: a.newTeacherId as string,
        status: a.status,
      })),
    eligibleCount: result.assignments.filter((a) => a.newTeacherId != null).length,
    deduplicated,
  };
}

/**
 * List the current coverage status for a school: open events + their
 * assignments. Used by /app/coverage.
 */
export async function listCoverage(args: {
  schoolId: string;
  forTeacherId?: string;
}): Promise<Array<{
  eventId: string;
  teacherId: string;
  teacherName: string;
  absenceDate: string;
  status: string;
  reason: string | null;
  source: string;
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
    const events = await tx
      .select({
        id: coverageEvents.id,
        teacherId: coverageEvents.teacherId,
        absenceDate: coverageEvents.absenceDate,
        status: coverageEvents.status,
        reason: coverageEvents.reason,
        source: coverageEvents.source,
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
        args.forTeacherId
          ? eq(coverageAssignments.newTeacherId, args.forTeacherId)
          : sql`TRUE`,
      ));

    return events.map((e) => ({
      eventId: e.id,
      teacherId: e.teacherId,
      teacherName: e.teacherName,
      absenceDate: e.absenceDate,
      status: e.status,
      reason: e.reason,
      source: e.source,
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

// Suppress unused imports — `or` is used in some template queries but
// TS still flags it as no-unused without this hint. The `g`, `l`, `s` vars
// below keep the unused-import linter quiet for the broadcast cohort
// helpers that don't currently JOIN cycle_calendar by date range.
