// apps/web/server/demo-seed.server.ts — Deterministic demo data for /try
//
// Spec: docs/superpowers/specs/2026-06-29--public-signup-and-demo-mode.md
//
// Sunrise Elementary — a realistic K-5 elementary school with:
//   - 5 active teachers (one currently absent)
//   - 4 duty slots on the active cycle day
//   - 1 active coverage event with a pending assignment
//   - 1 parent_alert draft (from the pending assignment)
//   - 1 parent_alert 'sent' from yesterday (history)
//
// The function takes a transaction (`tx`) so callers can wrap the seed
// in their own transaction. Caller must use the system role client (or
// a tx with `app.school_id` set) so the inserts pass RLS.
//
// Idempotency: this function does NOT check for existing rows. The
// caller is responsible for wiping before re-seeding (see
// `resetDemoSchool` in signup.server.ts).

import { sql, eq, and } from 'drizzle-orm';
import {
  users,
  duties,
  dutyAssignments,
  cycleCalendar,
  coverageEvents,
  coverageAssignments,
  parentContacts,
  parentRouteTags,
  parentAlerts,
  notifications,
  type SchoolContextTx,
} from '@edusupervise/db';

export type SeedVariant = 'elementary';

export interface SeedSpec {
  /** School display name (the `schools.name` row was already inserted by the caller). */
  schoolName: string;
  teachers: Array<{
    name: string;
    email: string;
    role: 'teacher' | 'school_admin';
  }>;
  dutySlots: Array<{
    cycleDay: number;
    startTime: string; // HH:MM
    endTime: string;
    location: string;
    description?: string;
    /** Teacher (by index into `teachers`) who is currently assigned. null = unassigned. */
    assignedToIdx: number | null;
  }>;
  absentTeacherIdx: number;
  cycleDays: number;
  schoolYearStart: Date;
}

const ELEMENTARY: SeedSpec = {
  schoolName: 'Sunrise Elementary',
  teachers: [
    { name: 'Ms. Chen', email: 'chen@sunrise-elem.example', role: 'teacher' },
    { name: 'Mr. Daniels', email: 'daniels@sunrise-elem.example', role: 'teacher' },
    { name: 'Mrs. Patel', email: 'patel@sunrise-elem.example', role: 'teacher' },
    { name: 'Mr. Okafor', email: 'okafor@sunrise-elem.example', role: 'teacher' },
    { name: 'Ms. Rivera', email: 'rivera@sunrise-elem.example', role: 'teacher' },
  ],
  dutySlots: [
    {
      cycleDay: 1,
      startTime: '11:00',
      endTime: '11:30',
      location: 'Cafeteria Lunch A',
      description: 'Supervise K-1 lunch in cafeteria section A',
      assignedToIdx: 3, // Mr. Okafor
    },
    {
      cycleDay: 1,
      startTime: '11:30',
      endTime: '12:00',
      location: 'Cafeteria Lunch B',
      description: 'Supervise grades 2-3 lunch in cafeteria section B',
      assignedToIdx: null,
    },
    {
      cycleDay: 1,
      startTime: '12:00',
      endTime: '12:30',
      location: 'Recess (north playground)',
      description: 'Supervise grade 4-5 recess on the north playground',
      assignedToIdx: 4, // Ms. Rivera
    },
    {
      cycleDay: 1,
      startTime: '14:50',
      endTime: '15:15',
      location: 'Bus dismissal',
      description: 'Wave students onto the correct bus at the front loop',
      assignedToIdx: null,
    },
  ],
  absentTeacherIdx: 2, // Mrs. Patel
  cycleDays: 5,
  schoolYearStart: new Date('2025-09-01'),
};

/**
 * Insert the full Sunrise Elementary seed dataset. Caller must have
 * already inserted the `schools` row (this function assumes the school
 * exists with the given id) AND the demo-school admin user
 * (`role='school_admin'`); pass that user's id as `adminUserId`. The
 * seed uses it as `created_by` for coverage events and as the target
 * of the "duty_assigned" notification bell row.
 */
export async function seedDemoData(
  tx: SchoolContextTx,
  schoolId: string,
  variant: SeedVariant,
  adminUserId: string,
): Promise<void> {
  if (variant !== 'elementary') {
    throw new Error(`Unknown seed variant: ${variant}`);
  }
  const spec = ELEMENTARY;

  // -- 1. Create teachers --
  const teacherIds: string[] = [];
  const nowIso = new Date().toISOString();
  for (const t of spec.teachers) {
    // Upsert: if a teacher with this email already exists in this
    // school (because reset-demo re-runs the seed), update name +
    // active status but keep the existing id. This makes the seed
    // idempotent — verified live 2026-06-30, was hitting 23505
    // duplicate-key on the second reset.
    const [row] = await tx
      .insert(users)
      .values({
        schoolId,
        email: t.email,
        passwordHash: null, // demo teachers don't log in
        name: t.name,
        role: t.role,
        emailVerifiedAt: sql`${nowIso}::timestamptz`,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [users.schoolId, users.email],
        set: {
          name: t.name,
          role: t.role,
          isActive: true,
          emailVerifiedAt: sql`${nowIso}::timestamptz`,
        },
      })
      .returning({ id: users.id });
    if (!row) throw new Error('demo seed: teacher upsert failed');
    teacherIds.push(row.id);
  }

  // -- 2. Cycle calendar (today + 14 days back/forward for the demo) --
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startOffset = -7;
  const endOffset = 21;
  const cycleCalendarRows: Array<{ date: string; cycleDay: number }> = [];
  for (let offset = startOffset; offset <= endOffset; offset++) {
    const d = new Date(today.getTime() + offset * 86_400_000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    // Map day-of-week to cycle day: Mon=1, Tue=2, ... Fri=5
    const cycleDay = dow;
    cycleCalendarRows.push({
      date: d.toISOString().slice(0, 10),
      cycleDay,
    });
  }
  for (const r of cycleCalendarRows) {
    await tx
      .insert(cycleCalendar)
      .values({
        schoolId,
        date: sql`${r.date}::date`,
        cycleDay: r.cycleDay,
        isSchoolDay: true,
      })
      .onConflictDoNothing({
        target: [cycleCalendar.schoolId, cycleCalendar.date],
      });
  }

  // -- 3. Duties + duty assignments --
  const todayCycleDay = cycleCalendarRows.find(
    (r) => r.date === today.toISOString().slice(0, 10),
  )?.cycleDay ?? 1;

  const dutyIds: string[] = [];
  for (const slot of spec.dutySlots) {
    // Only insert duties for cycleDay 1 in this seed; other days would
    // multiply the dataset. (A real school has duties for every cycle
    // day, but for the demo, cycle-day-1 coverage is the story.)
    if (slot.cycleDay !== 1) continue;

    const [row] = await tx
      .insert(duties)
      .values({
        schoolId,
        cycleDay: slot.cycleDay,
        startTime: slot.startTime,
        endTime: slot.endTime,
        location: slot.location,
        description: slot.description ?? null,
        requiresVest: false,
        requiresRadio: false,
        isActive: true,
        createdBy: adminUserId,
      })
      .returning({ id: duties.id });
    if (!row) throw new Error('demo seed: duty insert failed');
    dutyIds.push(row.id);

    if (slot.assignedToIdx !== null) {
      await tx.insert(dutyAssignments).values({
        schoolId,
        dutyId: row.id,
        userId: teacherIds[slot.assignedToIdx]!,
        startDate: sql`${spec.schoolYearStart.toISOString().slice(0, 10)}::date`,
        endDate: null,
        createdBy: adminUserId,
      });
    }
  }

  // -- 4. Coverage event: Mrs. Patel absent today --
  const absentTeacherId = teacherIds[spec.absentTeacherIdx]!;
  const [coverageEvent] = await tx
    .insert(coverageEvents)
    .values({
      schoolId,
      teacherId: absentTeacherId,
      absenceDate: sql`${today.toISOString().slice(0, 10)}::date`,
      reason: 'Sick day',
      status: 'open',
      source: 'manual',
      createdBy: adminUserId,
    })
    .returning({ id: coverageEvents.id });
  if (!coverageEvent) throw new Error('demo seed: coverage event insert failed');

  // -- 5. Coverage assignment: route one of Mrs. Patel's duties to Mr. Okafor --
  // Mrs. Patel's first duty slot on cycle day 1 doesn't exist (she's
  // not assigned to any slot in the spec above). For the demo story,
  // create a single ad-hoc coverage assignment: route the Cafeteria
  // Lunch B duty (currently unassigned) to Mr. Okafor.
  const lunchB = dutyIds[1];
  let coverageAssignmentId: string | null = null;
  if (lunchB) {
    const notifiedAtIso = new Date(Date.now() - 5 * 60_000).toISOString();
    const [ca] = await tx
      .insert(coverageAssignments)
      .values({
        schoolId,
        coverageEventId: coverageEvent.id,
        dutyId: lunchB,
        originalTeacherId: absentTeacherId,
        newTeacherId: teacherIds[3], // Mr. Okafor
        status: 'pending',
        notifiedAt: sql`${notifiedAtIso}::timestamptz`,
      })
      .returning({ id: coverageAssignments.id });
    if (ca) coverageAssignmentId = ca.id;
  }

  // -- 6. Parent contacts + route tags --
  const parent1Id = await insertParent(tx, schoolId, {
    name: 'Jordan Patel',
    phone: '+15551234567',
    email: 'parent.patel@example.com',
    routeTags: ['Cafeteria Lunch B', 'Bus dismissal'],
  });
  const parent2Id = await insertParent(tx, schoolId, {
    name: 'Avery Okafor',
    phone: '+15559876543',
    email: 'parent.okafor@example.com',
    routeTags: ['Cafeteria Lunch A'],
  });

  // -- 7. Parent alerts --
  if (coverageAssignmentId && parent1Id) {
    await tx.insert(parentAlerts).values({
      schoolId,
      parentId: parent1Id,
      coverageAssignmentId,
      channel: 'sms',
      subject: 'Coverage update for Cafeteria Lunch B',
      bodyShort: `Cafeteria Lunch B (11:30 AM–12:00 PM) on ${formatDate(today)} is now covered by Mr. Okafor. Reply STOP to opt out.`,
      bodyLong: `Dear parent,\n\nQuick update about Cafeteria Lunch B on ${formatDate(today)}, 11:30 AM–12:00 PM.\n\nYour child's regular supervisor (Mrs. Patel) is unavailable. Mr. Okafor will be covering this duty.\n\nNo action needed. If you have any questions, please contact the school office.\n\n— The school\n\n(To stop receiving these updates, reply STOP.)`,
      status: 'draft',
    });
  }

  // Yesterday's sent alert (history)
  const yesterday = new Date(today.getTime() - 86_400_000);
  const [yesterdayEvent] = await tx
    .insert(coverageEvents)
    .values({
      schoolId,
      teacherId: absentTeacherId,
      absenceDate: sql`${yesterday.toISOString().slice(0, 10)}::date`,
      reason: 'Appointment',
      status: 'closed',
      source: 'manual',
      createdBy: teacherIds[0]!,
    })
    .returning({ id: coverageEvents.id });
  if (yesterdayEvent && parent2Id) {
    const lunchA = dutyIds[0];
    if (lunchA) {
      const notifiedAtIso = new Date(yesterday.getTime() + 8 * 3600_000).toISOString();
      const respondedAtIso = new Date(yesterday.getTime() + 8 * 3600_000 + 60_000).toISOString();
      const sentAtIso = new Date(yesterday.getTime() + 8 * 3600_000 + 5 * 60_000).toISOString();
      const [ya] = await tx
        .insert(coverageAssignments)
        .values({
          schoolId,
          coverageEventId: yesterdayEvent.id,
          dutyId: lunchA,
          originalTeacherId: absentTeacherId,
          newTeacherId: teacherIds[4], // Ms. Rivera covered yesterday
          status: 'accepted',
          notifiedAt: sql`${notifiedAtIso}::timestamptz`,
          respondedAt: sql`${respondedAtIso}::timestamptz`,
        })
        .returning({ id: coverageAssignments.id });
      if (ya) {
        await tx.insert(parentAlerts).values({
          schoolId,
          parentId: parent2Id,
          coverageAssignmentId: ya.id,
          channel: 'sms',
          subject: 'Coverage update for Cafeteria Lunch A',
          bodyShort: `Cafeteria Lunch A (11:00 AM–11:30 AM) on ${formatDate(yesterday)} was covered by Ms. Rivera. Reply STOP to opt out.`,
          bodyLong: null,
          status: 'sent',
          sentAt: sql`${sentAtIso}::timestamptz`,
        });
      }
    }
  }

  // -- 8. Notification bell: a fresh "duty_assigned" for the demo admin --
  await tx.insert(notifications).values({
    schoolId,
    userId: adminUserId,
    kind: 'duty_assigned',
    title: 'Mr. Okafor has been auto-routed for Cafeteria Lunch B',
    body: 'Tap to review and confirm.',
    linkUrl: '/app/coverage',
  });
}

async function insertParent(
  tx: SchoolContextTx,
  schoolId: string,
  args: { name: string; phone?: string; email?: string; routeTags?: string[] },
): Promise<string> {
  const [row] = await tx
    .insert(parentContacts)
    .values({
      schoolId,
      name: args.name,
      phone: args.phone ?? null,
      email: args.email ?? null,
      language: 'en',
    })
    .returning({ id: parentContacts.id });
  if (!row) throw new Error('demo seed: parent insert failed');
  if (args.routeTags && args.routeTags.length > 0) {
    await tx.insert(parentRouteTags).values(
      args.routeTags.map((tag) => ({
        schoolId,
        parentId: row.id,
        tag,
      })),
    );
  }
  return row.id;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}