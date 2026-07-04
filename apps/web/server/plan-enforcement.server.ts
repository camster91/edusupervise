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
// Phase 3 §3.3 — admin billing wall:
//   - Existing numeric limits (teachers / duties / reminders / SMS)
//     still work via `enforcePlanLimits`.
//   - New GATED-FEATURE checks (`canBroadcast`, `canCreateRecurring`)
//     supplement the numeric limits by reading `schools.plan` directly.
//     A free-tier school cannot broadcast or create recurring duties
//     even if it has only 1 teacher assigned.
//   - `requireSchoolPlan(...)` is the throw-on-block helper for routes.
//   - `getUpgradeGateReason` builds the typed 403 body — the route hands
//     the JSON body to <UpgradePrompt /> so the modal can show the
//     exact reason (broadcast vs recurring vs max-teachers).
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
//     concurrent insert sneaking past the limit).
//   - Limits are keyed by the CURRENT `plan` — including a pending
//     downgrade. If `plan_downgrade_pending_to = 'free'` is set, we
//     enforce against the lower of (current, pending).
//   - The `sms_included` flag is NOT a limit; it gates the SMS dispatch
//     path in the worker, not a mutation route.

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
  type SchoolPlan,
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
 *
 * Phase 3 §3.3 — gated features (not numeric caps) use a separate
 * `GatedFeature` type below. Two surfaces, one module.
 */
export type EnforcementAction =
  | { type: 'user.create'; role: 'school_admin' | 'teacher' | 'substitute' }
  | { type: 'duty.create' }
  | { type: 'reminder.create'; assignmentId: string }
  | { type: 'assignment.create' }
  | { type: 'sms.send' };

/** Phase 3 §3.3 — gated features that depend on plan tier, not count. */
export type GatedFeature = 'coverage.broadcast' | 'recurring.duties' | 'parent.alerts' | 'pdf.ingestion' | 'bulk.csv' | 'custom_branding';

type LimitKey = 'maxTeachers' | 'maxDuties' | 'maxRemindersPerAssignment';

interface ActionLimitSpec {
  limitKey: LimitKey;
  label: string;
  table: 'users' | 'duties' | 'reminders' | 'duty_assignments';
  filter?: (tx: SchoolContextTx) => ReturnType<typeof sql>;
}

const ACTION_TABLE: Record<EnforcementAction['type'], ActionLimitSpec> = {
  'user.create': {
    limitKey: 'maxTeachers',
    label: 'teachers',
    table: 'users',
    filter: () => sql`is_active = true`,
  },
  'duty.create': {
    limitKey: 'maxDuties',
    label: 'duties',
    table: 'duties',
    filter: () => sql`is_active = true`,
  },
  'reminder.create': {
    limitKey: 'maxRemindersPerAssignment',
    label: 'reminders_per_assignment',
    table: 'reminders',
    filter: () => sql`assignment_id = $1`,
  },
  'assignment.create': {
    limitKey: 'maxDuties',
    label: 'assignments',
    table: 'duty_assignments',
    filter: () => sql`true`,
  },
  'sms.send': {
    limitKey: 'maxTeachers',
    label: 'sms',
    table: 'users',
    filter: () => sql`true`,
  },
};

/**
 * Phase 3 §3.3 — feature tier map. Each entry lists the plan tiers
 * that ALLOW the feature. Anything not listed is denied.
 *
 * The free tier ($0, solo) is excluded from every gated feature by
 * design — solo teachers don't need school-wide broadcast / recurring
 * duty CRUD.
 */
const FEATURE_TIER_ALLOWLIST: Record<GatedFeature, ReadonlyArray<SchoolPlan>> = {
  'coverage.broadcast': ['school'],
  'recurring.duties': ['school'],
  'parent.alerts': ['pro', 'school'],
  'pdf.ingestion': ['pro', 'school'],
  'bulk.csv': ['school'],
  'custom_branding': ['school'],
};

const FEATURE_LABEL: Record<GatedFeature, string> = {
  'coverage.broadcast': 'Broadcast coverage requests',
  'recurring.duties': 'Recurring time-bound duties',
  'parent.alerts': 'Parent alerts',
  'pdf.ingestion': 'School-wide PDF ingestion',
  'bulk.csv': 'Bulk CSV import',
  'custom_branding': 'Custom school branding',
};

// ---------------------------------------------------------------------------
// Core: enforcePlanLimits
// ---------------------------------------------------------------------------

export interface EnforcePlanLimitsOptions {
  tx?: SchoolContextTx;
}

export interface PlanLimitErrorBody {
  error: 'plan_limit_exceeded';
  limit: string;
  current: number;
  max: number;
  upgrade_url: string;
}

export type PlanLimitErrorResponse = Response;

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

  const pendingPlan = school.planDowngradePendingTo;
  const effectivePlan = pendingPlan ?? school.plan;

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
  const max = planRow[limitKey];
  if (max === null || max === undefined) {
    throw new Error(
      `enforcePlanLimits: plan_limits row for '${effectivePlan}' missing column ${limitKey}`,
    );
  }

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

  const current = await countCurrent(tx, action, spec);

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
  const filter = spec.filter?.(tx);
  let filterSql = filter ?? sql`true`;
  if (action.type === 'reminder.create') {
    filterSql = sql`assignment_id = ${action.assignmentId}`;
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
// Phase 3 §3.3 — Gated feature checks (broadcast, recurring, etc.)
//
// Two surface APIs:
//   - requireSchoolPlan(tx, schoolId, feature) — throws a 403 Response
//     when the plan doesn't include the feature. Routes `throw` it.
//   - canUseFeature(tx, schoolId, feature) — bool, for soft UI hints
//     (e.g. "Upgrade to broadcast").
//   - explainUpgradeGate(schoolId, feature) — typed reason object for
//     UpgradePrompt.tsx (so the modal can show why the upgrade matters).
// ---------------------------------------------------------------------------

export interface UpgradeGateReason {
  /** The feature the user was trying to use. */
  feature: GatedFeature;
  /** Human-readable feature label. */
  featureLabel: string;
  /** The plan the user's school is on. */
  currentPlan: SchoolPlan;
  /** The minimum plan tier that unlocks the feature. */
  minimumPlan: SchoolPlan;
  /** Call-to-action copy for the modal. */
  cta: string;
}

/** Soft check — does NOT throw. Used by UI components for hints. */
export async function canUseFeature(
  tx: SchoolContextTx,
  schoolId: string,
  feature: GatedFeature,
): Promise<boolean> {
  const { plan } = await readSchoolPlan(tx, schoolId);
  return FEATURE_TIER_ALLOWLIST[feature].includes(plan);
}

/** Throwing variant for routes. */
export async function requireSchoolPlan(
  tx: SchoolContextTx,
  schoolId: string,
  feature: GatedFeature,
): Promise<{ ok: true; plan: SchoolPlan } | { ok: false; response: Response; reason: UpgradeGateReason }> {
  const { plan } = await readSchoolPlan(tx, schoolId);
  if (FEATURE_TIER_ALLOWLIST[feature].includes(plan)) {
    return { ok: true, plan };
  }
  const allowlist = FEATURE_TIER_ALLOWLIST[feature];
  const minimumPlan = (allowlist[0] ?? 'school') as SchoolPlan;
  const reason: UpgradeGateReason = {
    feature,
    featureLabel: FEATURE_LABEL[feature],
    currentPlan: plan,
    minimumPlan,
    cta: `Upgrade to ${capitalize(minimumPlan)} to unlock ${FEATURE_LABEL[feature]}.`,
  };
  return { ok: false, reason, response: buildFeatureGateResponse(reason) };
}

/** Read-only upgrade explanation — used by UI to render UpgradePrompt. */
export async function explainUpgradeGate(
  tx: SchoolContextTx,
  schoolId: string,
  feature: GatedFeature,
): Promise<UpgradeGateReason> {
  const { plan } = await readSchoolPlan(tx, schoolId);
  const allowlist = FEATURE_TIER_ALLOWLIST[feature];
  const minimumPlan = (allowlist[0] ?? 'school') as SchoolPlan;
  return {
    feature,
    featureLabel: FEATURE_LABEL[feature],
    currentPlan: plan,
    minimumPlan,
    cta: `Upgrade to ${capitalize(minimumPlan)} to unlock ${FEATURE_LABEL[feature]}.`,
  };
}

async function readSchoolPlan(
  tx: SchoolContextTx,
  schoolId: string,
): Promise<{ plan: SchoolPlan; pending: SchoolPlan | null }> {
  const [row] = await tx
    .select({
      plan: schools.plan,
      planDowngradePendingTo: schools.planDowngradePendingTo,
    })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  if (!row) throw new Error(`school ${schoolId} not visible in current context`);
  return {
    plan: row.plan as SchoolPlan,
    pending: (row.planDowngradePendingTo as SchoolPlan | null) ?? null,
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function buildFeatureGateResponse(reason: UpgradeGateReason): Response {
  const body = JSON.stringify({
    error: 'plan_feature_locked',
    feature: reason.feature,
    featureLabel: reason.featureLabel,
    currentPlan: reason.currentPlan,
    minimumPlan: reason.minimumPlan,
    upgrade_url: '/app/settings/billing',
    cta: reason.cta,
  });
  logger.info(
    {
      feature: reason.feature,
      currentPlan: reason.currentPlan,
      minimumPlan: reason.minimumPlan,
    },
    'plan_feature_locked',
  );
  return new Response(body, {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// SMS included check (for the worker / dispatch path)
// ---------------------------------------------------------------------------

export async function smsAllowedForSchool(schoolId: string): Promise<boolean> {
  const { getSystemClient } = await import('@edusupervise/db');
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
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

void dutyAssignments;
