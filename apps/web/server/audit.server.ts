// apps/web/server/audit.server.ts — privileged-mutation audit log helper.
//
// Writes a row to `audit_log` (BYPASSRLS system role — audit rows
// need to be attributed to the user across tenants, so they live
// outside the tenant RLS scope). The cron flips old rows to
// `archive` after `plan_limits.audit_retention_days`.
//
// What gets logged:
//   - user signup (any mode)
//   - school settings changes (rename, plan change)
//   - demo reset (destructive — important forensics)
//   - coverage accept/decline (operational audit trail)
//
// NOT logged (no audit row written):
//   - read operations (loaders, queries)
//   - high-frequency mutations like notification inserts (would
//     dwarf the audit table)
//
// audit slice-3 yellow: "audit_log not wired from privileged
// mutations" — fixed 2026-06-30.

import { randomUUID } from 'node:crypto';
import { auditLog, getSystemClient, type Db } from '@edusupervise/db';

export interface AuditEntry {
  schoolId: string;
  /** user_id for the actor (may be null for system-initiated actions). */
  userId: string | null;
  action: string;
  /** 'school' | 'user' | 'duty' | 'coverage_event' | 'coverage_assignment' | etc. */
  targetType?: string;
  targetId?: string;
  /** Free-form payload — keep keys snake_case to match the SQL. */
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Best-effort audit log writer. Errors are SWALLOWED (logged at
 * warn) so a failed audit insert doesn't break the user's actual
 * mutation — but this is auditable in production via the daily
 * audit-retention job that flags orphan rows.
 *
 * Use this from privileged mutation handlers (signup, settings,
 * demo reset, coverage accept/decline).
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) return;
  const { db, close } = getSystemClient(systemUrl);
  try {
    await db.insert(auditLog).values({
      schoolId: entry.schoolId,
      userId: entry.userId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    });
  } catch (err) {
    // Audit failure is non-fatal — log + swallow. The operation the
    // user just performed still succeeded; we just lost the trail.
    // In production wire this to Sentry so dropped audits are visible.
    console.warn(
      { err, action: entry.action, schoolId: entry.schoolId },
      'audit: failed to write audit row (non-fatal)',
    );
  } finally {
    await close();
  }
}

/**
 * Extract IP + User-Agent from a Request. Returns undefined for
 * fields that aren't present so the helper doesn't write NULLs for
 * every audit row.
 */
export function requestMetadata(request: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const ipAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = request.headers.get('user-agent') ?? null;
  return { ipAddress, userAgent };
}

/**
 * Convenience wrapper: `recordAudit` with `requestMetadata` pre-filled.
 */
export async function recordAuditFromRequest(
  request: Request,
  entry: Omit<AuditEntry, 'ipAddress' | 'userAgent'>,
): Promise<void> {
  const { ipAddress, userAgent } = requestMetadata(request);
  return recordAudit({ ...entry, ipAddress, userAgent });
}

// Helper to ensure consistent action names across the codebase. Free
// strings are fine but typing the common ones keeps typos out of
// `audit_log.action`.
export const AUDIT = {
  USER_SIGNUP_JOIN: 'user.signup.join',
  USER_SIGNUP_SOLO: 'user.signup.solo',
  USER_SIGNUP_DEMO: 'user.signup.demo',
  SCHOOL_RENAME: 'school.rename',
  SCHOOL_PLAN_CHANGE: 'school.plan_change',
  DEMO_RESET: 'school.demo_reset',
  COVERAGE_ACCEPT: 'coverage.accept',
  COVERAGE_DECLINE: 'coverage.decline',
  COVERAGE_RECORD_ABSENCE: 'coverage.record_absence',
} as const;