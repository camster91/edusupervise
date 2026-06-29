// apps/web/server/plan-enforcement.server.ts — plan-limit enforcement.
//
// Every mutation that would push a school's resource count past the
// `plan_limits` ceiling must call `enforcePlanLimits(schoolId, action,
// tx)` BEFORE the insert. The helper returns a thrown `Response` shaped
// per spec section 6 — `403` with body
//
//     {
//       "error": "plan_limit_exceeded",
//       "limit": "teachers",
//       "current": 5,
//       "max": 3,
//       "upgrade_url": "/app/settings/billing"
//     }
//
// Caller flow:
//
//   await withSchool(request, async (tx, session) => {
//     await enforcePlanLimits(tx, session.schoolId, { type: 'user.create' });
//     await tx.insert(users).values(...);
//   });
//
// Why a thrown Response (not a returned object):
//   - RR7 actions can `throw` any Response; the framework will forward
//     it through the action loader pipeline. Returning a normal 200
//     would force every caller to remember to type-check the result.
//   - The shape is unambiguous: 403 + JSON body, matching the
//     convention Stripe, GitHub, and modern SaaS APIs use.
//
// Implementation notes:
//   - We accept an optional `tx` so the count query and the upcoming
//     insert run in the same transaction (defense-in-depth against a
//     concurrent insert sneaking past the limit). When no tx is
//     provided we open a fresh `withSchoolContext`.
//   - Limits are keyed by the CURRENT `plan` — including a pending
//     downgrade. If `plan_downgrade_pending_to = 'free'` is set, we
//     enforce against the lower of (current, pending) so users can't
//     outrun the 7-day grace. (Spec section 6: "Mutations on Free are
//     still blocked when over Free limits (return 403)".)
//   - The `sms_included` flag is NOT a limit — it gates the SMS dispatch
//     path in the worker, not a mutation route. We expose it via
//     `smsAllowed(schoolId)` for callers that need to skip the SMS path.
//
// The plan_limits table is on the system-role side (BYPASSRLS) so we can
// read it without setting app.school_id. The actual counts run inside
// withSchoolContext (RLS) so each school only counts its own rows.

import { eq, sql } from 'drizzle-orm';
import {
  duties,
  dutyAssignments,
  planLimits,
  reminders,
  schools,
  users,
  withSchoolContext,
  type Db,
  type SchoolContextTx,
} from '@edusupervise/db';

import { logger } from './logger.server';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

/**
 * Discriminator for the resource being created. The map below tells the
 * enforcer which table to count + which column in `plan_limits`
 * represents the cap.
 *
 * Keep this exhaustive. Adding a new mutation type = adding a case here
 * AND wiring the limit into `plan_limits` (see db/init/03-seed.sql).
 */
export type EnforcementAction =
  | { type: 'user.create'; role: 'school_admin' | 'teacher' | 'substitute' }
  | { type: 'duty.create' }
  | { type: 'reminder.create'; assignmentId: string }
  | { type: 'assignment.create' }
  | { type: 'sms.send' };

type LimitKey = 'maxTeachers' | 'maxDuties' | 'maxRemindersPerAssignment';

interface ActionLimitSpec {
  limitKey: LimitKey;
  /** Pretty label for the API body — e.g. "teachers". */
  label: string;
  /** Table to count from. */
  table: 'users' | 'duties' | 'reminders' | 'duty_assignments';
  /** Optional WHERE-filter applied to the count (e.g. role-conditional for teachers). */
  filter?: (tx: SchoolContextTx) => ReturnType<typeof sql>;
}

const ACTION_TABLE: Record<EnforcementAction['type'], ActionLimitSpec> = {
  'user.create': {
    limitKey: 'maxTeachers',
    label: 'teachers',
    table: 'users',
    // Teachers + substitutes count toward the cap. Admins do too in
    // practice, but the spec uses "max_teachers" as the column name.
    // We count all active users.
    filter: () => sql`is_active = true`,
  },
  'duty.create': {
    limitKey: 'maxDuties',
    label: 'duties',
    table: 'duties',
    // Count active duties — soft-deleted (`is_active = false`) don't
    // contribute to the limit.
    filter: () => sql`is_active = true`,
  },
  'reminder.create': {
    limitKey: 'maxRemindersPerAssignment',
    label: 'reminders_per_assignment',
    table: 'reminders',
    // Reminder count is per assignment, not global — we COUNT(*) WHERE
    // assignment_id = $1.
    filter: () => sql`assignment_id = $1`, // overridden in countCurrent
  },
  'assignment.create': {
    // Spec doesn't define an assignment-specific cap; we use
    // max_duties as the proxy. Each assignment references one duty, so
    // a school over max_duties is also over their assignment allowance.
    limitKey: 'maxDuties',
    label: 'assignments',
    table: 'duty_assignments',
    filter: () => sql`true`,
  },
  'sms.send': {
    // SMS is gated by `sms_included`, not a numeric cap. Handled in
    // `checkSmsAllowed`.
    limitKey: 'maxTeachers',
    label: 'sms',
    table: 'users',
    filter: () => sql`true`,
  },
};

// ---------------------------------------------------------------------------
// Core: enforcePlanLimits
// ---------------------------------------------------------------------------

export interface EnforcePlanLimitsOptions {
  /**
   * Optional pre-opened transaction (SchoolContextTx). When supplied,
   * the count query runs inside it so a racing insert cannot push the
   * count past `max` between the check and the caller's INSERT.
   */
  tx?: SchoolContextTx;
}

export interface PlanLimitErrorBody {
  error: 'plan_limit_exceeded';
  limit: string;
  current: number;
  max: number;
  upgrade_url: string;
}

/**
 * The shape of the 403 response used when a mutation would exceed a
 * plan limit. We don't extend `Response` (which would conflict with
 * the read-only properties of the platform type); callers that want
 * the parsed body can pass the response through `await resp.json()`.
 */
export type PlanLimitErrorResponse = Response;

/**
 * Throws (or returns) a `403` Response when the action would exceed the
 * school's plan limit. Caller decides whether to throw + return, or
 * inspect + return — see the two helpers below.
 *
 * Returns:
 *   - `{ ok: true }` when the action may proceed.
 *   - `{ ok: false, response }` when blocked (the response is a
 *     pre-built 403 with the typed body).
 */
export async function checkPlanLimits(
  schoolId: string,
  action: EnforcementAction,
  options: EnforcePlanLimitsOptions = {},
): Promise<
  | { ok: true; current: number; max: number; plan: string }
  | { ok: false; response: Response; current: number; max: number; plan: string }
> {
  const spec = ACTION_TABLE[action.type];
  const limitKey = spec.limitKey;

  if (options.tx) {
    return runWithin(options.tx, schoolId, action, spec, limitKey);
  }
  // Open a fresh transaction.
  const { getDb } = await import('./db.server');
  const db = getDb();
  return withSchoolContext(db, schoolId, async (tx) =>
    runWithin(tx, schoolId, action, spec, limitKey),
  );
}

async function runWithin(
  tx: SchoolContextTx,
  schoolId: string,
  action: EnforcementAction,
  spec: ActionLimitSpec,
  limitKey: LimitKey,
): Promise<
  | { ok: true; current: number; max: number; plan: string }
  | { ok: false; response: Response; current: number; max: number; plan: string }
> {
  // 1. Read the school's CURRENT plan + any pending downgrade
  const schoolRows = await tx
    .select({
      plan: schools.plan,
      planDowngradePendingTo: schools.planDowngradePendingTo,
    })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  const school = schoolRows[0];
  if (!school) {
    throw new Error(
      `enforcePlanLimits: school ${schoolId} not visible in current context`,
    );
  }

  // 2. Determine the effective plan. If a downgrade is pending and the
  //    user is over the FREE limits, enforce against the lower max so
  //    they can't outrun the grace window.
  const pendingPlan = school.planDowngradePendingTo;
  const effectivePlan = pendingPlan ?? school.plan;

  // 3. Read the limit row for the effective plan.
  const planRows = await tx
    .select({
      maxTeachers: planLimits.maxTeachers,
      maxDuties: planLimits.maxDuties,
      maxRemindersPerAssignment: planLimits.maxRemindersPerAssignment,
      smsIncluded: planLimits.smsIncluded,
    })
    .from(planLimits)
    .where(eq(planLimits.plan, effectivePlan))
    .limit(1);
  const planRow = planRows[0];
  if (!planRow) {
    throw new Error(
      `enforcePlanLimits: plan '${effectivePlan}' not found in plan_limits`,
    );
  }
  // Drizzle maps plan_limits columns to camelCase. The LimitKey type is
  // already in camelCase (maxTeachers / maxDuties / maxRemindersPerAssignment)
  // so the lookup is direct.
  const max = planRow[limitKey];
  if (max === null || max === undefined) {
    throw new Error(
      `enforcePlanLimits: plan_limits row for '${effectivePlan}' missing column ${limitKey}`,
    );
  }

  // 4. SMS-gate path: no count, just check the boolean.
  if (action.type === 'sms.send') {
    if (planRow.smsIncluded) {
      return { ok: true, current: 0, max: 0, plan: effectivePlan };
    }
    return {
      ok: false,
      current: 0,
      max: 0,
      plan: effectivePlan,
      response: buildLimitResponse({
        limit: 'sms',
        current: 0,
        max: 0,
        plan: effectivePlan,
      }),
    };
  }

  // 5. Count rows in the relevant table.
  const current = await countCurrent(tx, action, spec);

  // 6. Decide.
  if (current + 1 > max) {
    return {
      ok: false,
      current,
      max,
      plan: effectivePlan,
      response: buildLimitResponse({
        limit: spec.label,
        current,
        max,
        plan: effectivePlan,
      }),
    };
  }
  return { ok: true, current, max, plan: effectivePlan };
}

async function countCurrent(
  tx: SchoolContextTx,
  action: EnforcementAction,
  spec: ActionLimitSpec,
): Promise<number> {
  // Build the COUNT(*) query directly via `sql` rather than Drizzle's
  // DSL — keeps the per-type filter logic in one place and avoids
  // having to type five different `.from(...)` chains for five table
  // types.
  const filter = spec.filter?.(tx);
  let filterSql = filter ?? sql`true`;
  let param: unknown = null;
  if (action.type === 'reminder.create') {
    param = action.assignmentId;
    filterSql = sql`assignment_id = ${param}`;
  }
  let tableName: string;
  switch (spec.table) {
    case 'users':
      tableName = 'users';
      break;
    case 'duties':
      tableName = 'duties';
      break;
    case 'reminders':
      tableName = 'reminders';
      break;
    case 'duty_assignments':
      tableName = 'duty_assignments';
      break;
  }
  const result = await tx.execute(
    sql`SELECT COUNT(*)::int AS c FROM ${sql.raw(tableName)} WHERE school_id = current_school_id() AND ${filterSql}`,
  );
  const rows = (Array.isArray(result)
    ? result
    : (result as unknown as { rows?: unknown[] }).rows ?? []) as Array<{
    c: number;
  }>;
  return rows[0]?.c ?? 0;
}

// ---------------------------------------------------------------------------
// `enforcePlanLimits` — the throw-on-block variant most callers want
// ---------------------------------------------------------------------------

/**
 * Drop-in guard for RR7 actions and route loaders. Throws (via `return`
 * inside the route, or via `throw` outside one) a typed Response when
 * the limit would be exceeded; resolves when the action may proceed.
 *
 * Usage inside a route action:
 *
 *   export async function action({ request }: Route.ActionArgs) {
 *     const csrf = validateCsrf(request);
 *     if (!csrf.ok) return csrf.response;
 *     return withUser(request, async (tx, session) => {
 *       const limit = await enforcePlanLimits(tx, session.schoolId, {
 *         type: 'user.create',
 *       });
 *       if (!limit.ok) return limit.response;
 *       // ... do the insert ...
 *     });
 *   }
 */
export async function enforcePlanLimits(
  tx: SchoolContextTx,
  schoolId: string,
  action: EnforcementAction,
): Promise<
  | { ok: true; current: number; max: number; plan: string }
  | { ok: false; response: Response; current: number; max: number; plan: string }
> {
  return checkPlanLimits(schoolId, action, { tx });
}

// ---------------------------------------------------------------------------
// Helpers used by routes that don't go through withSchoolContext
// ---------------------------------------------------------------------------

/**
 * Open a fresh transaction + enforce. Convenience for routes that
 * haven't yet wrapped the call in `withSchool`.
 */
export async function enforcePlanLimitsFresh(
  schoolId: string,
  action: EnforcementAction,
): Promise<
  | { ok: true; current: number; max: number; plan: string }
  | { ok: false; response: Response; current: number; max: number; plan: string }
> {
  return checkPlanLimits(schoolId, action);
}

// ---------------------------------------------------------------------------
// SMS included check (for the worker / dispatch path)
// ---------------------------------------------------------------------------

/**
 * Whether the school's effective plan includes SMS. Returns `false`
 * for the free tier + during a downgrade to free. Read via the system
 * role since we look up the school without an app.school_id context.
 */
export async function smsAllowedForSchool(schoolId: string): Promise<boolean> {
  const { getSystemClient } = await import('@edusupervise/db');
  const url =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) return false;
  const { db, close } = getSystemClient(url);
  try {
    const rows = await db
      .select({
        plan: schools.plan,
        planDowngradePendingTo: schools.planDowngradePendingTo,
      })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1);
    const school = rows[0];
    if (!school) return false;
    const effective = school.planDowngradePendingTo ?? school.plan;
    const planRows = await db
      .select({ smsIncluded: planLimits.smsIncluded })
      .from(planLimits)
      .where(eq(planLimits.plan, effective))
      .limit(1);
    return planRows[0]?.smsIncluded ?? false;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Response builder
// ---------------------------------------------------------------------------

function buildLimitResponse(input: {
  limit: string;
  current: number;
  max: number;
  plan: string;
}): Response {
  const body = JSON.stringify({
    error: 'plan_limit_exceeded',
    limit: input.limit,
    current: input.current,
    max: input.max,
    upgrade_url: '/app/settings/billing',
  });
  logger.info(
    { limit: input.limit, current: input.current, max: input.max, plan: input.plan },
    'plan_limit_exceeded',
  );
  return new Response(body, {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

// Re-export dutyAssignments so the file's table literal types are valid
// even when not used by the count query directly.
void dutyAssignments;
