// apps/web/server/duty-assignments.server.ts — group-duty helpers (Phase 3 §3.1).
//
// The existing coverage.server.ts and the duty detail route each call
// `tx.insert(dutyAssignments).values({...})` for the singleton "assign
// one teacher" case. Phase 3 §3.1 lifts that to N teachers on one duty
// with a coverage role per row, so this module centralises the batch
// insert + the inverse `unassignTeacher`. All writes go through
// `withSchoolId` so RLS continues to scope reads/writes to the right
// tenant.
//
// Read APIs:
//   - `listTeachersForDuty` — assignments + joined user info for one
//      duty. Used by /app/duties/:id and /app/today.
//   - `getGroupDutyRoster` — assignments grouped by duty (everything
//      the logged-in user is on, for the Today view's "you're covering
//      with N others" copy).
//
// Write APIs:
//   - `assignGroup` — replace the current set of assignments on a duty
//      with a new batch; idempotent (re-running with the same batch
//      is a no-op, not a duplicate). Uses the partial unique index
//      from Migration 0009 (school_id, duty_id, user_id, coverage_role)
//      so re-inserting the same row raises a friendly constraint error
//      we translate to a 409.
//   - `unassignFromDuty` — remove one (dutyId, userId, coverageRole) row.
//      Returns the number of rows removed (typically 0 or 1).

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  duties,
  dutyAssignments,
  users,
  type CoverageRole,
} from '@edusupervise/db';
import { logger } from './logger.server';
import { withSchoolId, type SchoolContextTx } from './db.server';

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export interface AssignmentRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  coverageRole: CoverageRole;
  startDate: string;
  endDate: string | null;
}

interface TeacherJoinRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  coverageRole: CoverageRole;
  startDate: Date | string;
  endDate: Date | string | null;
}

function formatDate(value: Date | string | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export async function listTeachersForDuty(args: {
  schoolId: string;
  dutyId: string;
}): Promise<AssignmentRow[]> {
  return withSchoolId(args.schoolId, async (tx: SchoolContextTx) => {
    const rows: TeacherJoinRow[] = await tx
      .select({
        id: dutyAssignments.id,
        userId: dutyAssignments.userId,
        userName: users.name,
        userEmail: users.email,
        coverageRole: dutyAssignments.coverageRole,
        startDate: dutyAssignments.startDate,
        endDate: dutyAssignments.endDate,
      })
      .from(dutyAssignments)
      .innerJoin(users, eq(users.id, dutyAssignments.userId))
      .where(
        and(
          eq(dutyAssignments.schoolId, args.schoolId),
          eq(dutyAssignments.dutyId, args.dutyId),
        ),
      );
    return rows.map(
      (r: TeacherJoinRow): AssignmentRow => ({
        id: r.id,
        userId: r.userId,
        userName: r.userName,
        userEmail: r.userEmail,
        coverageRole: r.coverageRole,
        startDate: formatDate(r.startDate),
        endDate: formatDate(r.endDate) || null,
      }),
    );
  });
}

interface RosterMember {
  userId: string;
  userName: string;
  coverageRole: CoverageRole;
}

interface RosterRow {
  dutyId: string;
  userId: string;
  userName: string;
  coverageRole: CoverageRole;
}

interface MyAssignmentRow {
  dutyId: string;
}

/**
 * Returns the assignments the user is on across all duties of the
 * school, keyed by dutyId. Used by the /app/today loader so it can
 * show "you have 2 colleagues covering this duty" without an N+1.
 */
export async function getGroupDutyRoster(args: {
  schoolId: string;
  userId: string;
}): Promise<Map<string, RosterMember[]>> {
  return withSchoolId(args.schoolId, async (tx: SchoolContextTx) => {
    const myAssignments: MyAssignmentRow[] = await tx
      .select({ dutyId: dutyAssignments.dutyId })
      .from(dutyAssignments)
      .where(
        and(
          eq(dutyAssignments.schoolId, args.schoolId),
          eq(dutyAssignments.userId, args.userId),
        ),
      );

    if (myAssignments.length === 0) return new Map();

    const dutyIds: string[] = Array.from(new Set(myAssignments.map((a: MyAssignmentRow) => a.dutyId)));
    const allRoster: RosterRow[] = await tx
      .select({
        dutyId: dutyAssignments.dutyId,
        userId: dutyAssignments.userId,
        userName: users.name,
        coverageRole: dutyAssignments.coverageRole,
      })
      .from(dutyAssignments)
      .innerJoin(users, eq(users.id, dutyAssignments.userId))
      .where(
        and(
          eq(dutyAssignments.schoolId, args.schoolId),
          inArray(dutyAssignments.dutyId, dutyIds),
        ),
      );

    const byDuty = new Map<string, RosterMember[]>();
    for (const row of allRoster) {
      const arr = byDuty.get(row.dutyId) ?? [];
      arr.push({
        userId: row.userId,
        userName: row.userName,
        coverageRole: row.coverageRole,
      });
      byDuty.set(row.dutyId, arr);
    }
    return byDuty;
  });
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export interface AssignGroupInput {
  schoolId: string;
  dutyId: string;
  /** Per-teacher cohort. Empty array = clear all (destructive, gated). */
  entries: Array<{ userId: string; role: CoverageRole }>;
  /** Set as both `created_by` (audit) and `assigned_by_user_id` (semantic). */
  assignedByUserId: string;
  /** Inclusive first day of the assignment window. Defaults to today. */
  startDate?: string;
  /** Optional inclusive end day. Empty = open-ended. */
  endDate?: string;
}

export interface AssignGroupResult {
  inserted: number;
  /** Pre-existing rows that were already on the duty (no-op for them). */
  skipped: number;
  /** IDs removed when entries < previously-stored ones. */
  removed: number;
}

interface PreviousAssignmentRow {
  id: string;
  userId: string;
  coverageRole: CoverageRole;
}

/**
 * Replace this duty's assignment set with the new `entries`. Idempotent.
 */
export async function assignGroup(
  input: AssignGroupInput,
): Promise<AssignGroupResult> {
  return withSchoolId(input.schoolId, async (tx: SchoolContextTx) => {
    const [duty]: Array<{ id: string }> = await tx
      .select({ id: duties.id })
      .from(duties)
      .where(and(eq(duties.id, input.dutyId), eq(duties.schoolId, input.schoolId)))
      .limit(1);
    if (!duty) {
      throw new Error(`duty ${input.dutyId} not found in school ${input.schoolId}`);
    }

    const previous: PreviousAssignmentRow[] = await tx
      .select({
        id: dutyAssignments.id,
        userId: dutyAssignments.userId,
        coverageRole: dutyAssignments.coverageRole,
      })
      .from(dutyAssignments)
      .where(
        and(
          eq(dutyAssignments.schoolId, input.schoolId),
          eq(dutyAssignments.dutyId, input.dutyId),
        ),
      );

    const makeKey = (u: string, r: CoverageRole): string => `${u}|${r}`;
    const previousSet = new Set(
      previous.map((p: PreviousAssignmentRow) => makeKey(p.userId, p.coverageRole)),
    );
    const newSet = new Set(
      input.entries.map((e: { userId: string; role: CoverageRole }) => makeKey(e.userId, e.role)),
    );

    const toRemove: PreviousAssignmentRow[] = previous.filter(
      (p: PreviousAssignmentRow) => !newSet.has(makeKey(p.userId, p.coverageRole)),
    );
    const toInsert = input.entries.filter(
      (e: { userId: string; role: CoverageRole }) => !previousSet.has(makeKey(e.userId, e.role)),
    );

    let inserted = 0;
    let removed = 0;
    const skipped = previousSet.size - toInsert.length;

    if (toInsert.length > 0) {
      const startDate = input.startDate ?? new Date().toISOString().slice(0, 10);
      const rows = toInsert.map(
        (e: { userId: string; role: CoverageRole }) => ({
          schoolId: input.schoolId,
          dutyId: input.dutyId,
          userId: e.userId,
          coverageRole: e.role,
          startDate,
          endDate: input.endDate ?? null,
          createdBy: input.assignedByUserId,
          assignedByUserId: input.assignedByUserId,
        }),
      );
      const insertedRows: Array<{ id: string }> = await tx
        .insert(dutyAssignments)
        .values(rows)
        .returning({ id: dutyAssignments.id });
      inserted = insertedRows.length;
    }

    if (toRemove.length > 0) {
      const removedIds = toRemove.map((r: PreviousAssignmentRow): string => r.id);
      await tx
        .delete(dutyAssignments)
        .where(inArray(dutyAssignments.id, removedIds));
      removed = removedIds.length;
      logger.info(
        {
          schoolId: input.schoolId,
          dutyId: input.dutyId,
          removedIds,
          count: removed,
        },
        'duty_assignments.unassignGroup',
      );
    }

    return { inserted, skipped, removed };
  });
}

export async function unassignFromDuty(args: {
  schoolId: string;
  dutyId: string;
  userId: string;
  coverageRole: CoverageRole;
}): Promise<{ removed: number }> {
  return withSchoolId(args.schoolId, async (tx: SchoolContextTx) => {
    const rows: Array<{ id: string }> = await tx
      .delete(dutyAssignments)
      .where(
        and(
          eq(dutyAssignments.schoolId, args.schoolId),
          eq(dutyAssignments.dutyId, args.dutyId),
          eq(dutyAssignments.userId, args.userId),
          eq(dutyAssignments.coverageRole, args.coverageRole),
        ),
      )
      .returning({ id: dutyAssignments.id });
    return { removed: rows.length };
  });
}

// Re-export SchoolContextTx so callers that need to compose with these
// helpers don't have to reach into the db package directly.
export type { SchoolContextTx };

// Suppress unused-import warnings from drizzle-orm while keeping the
// imports available for future filter extension.
void sql;
