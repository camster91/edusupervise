// apps/web/server/audit.server.ts — privileged-mutation audit log helper.
//
// Writes a row to `audit_log` (BYPASSRLS system role — audit rows
// need to be attributed to the user across tenants, so they live
// outside the tenant RLS scope). The cron flips old rows to
// `archive` after `plan_limits.audit_retention_days`.

import { randomUUID } from 'node:crypto';
import { auditLog, getSystemClient, type Db } from '@edusupervise/db';
import { clientIp as readClientIp } from './client-ip.server';
import { logger } from './logger.server';

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
    logger.warn(
      { err, action: entry.action, schoolId: entry.schoolId },
      'audit: failed to write audit row (non-fatal)',
    );
  } finally {
    await close();
  }
}

export function requestMetadata(request: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  // SECURITY (audit S-S2): read client IP via the safe helper that
  // only honours XFF when TRUST_PROXY=1. Otherwise an unauthenticated
  // caller can spoof XFF to evade per-IP rate-limits and pollute the
  // audit_log.ipAddress column.
  const ip = readClientIp(request);
  const ipAddress = ip === 'unknown' ? null : ip;
  const userAgent = request.headers.get('user-agent') ?? null;
  return { ipAddress, userAgent };
}

export async function recordAuditFromRequest(
  request: Request,
  entry: Omit<AuditEntry, 'ipAddress' | 'userAgent'>,
): Promise<void> {
  const meta = requestMetadata(request);
  return recordAudit({ ...entry, ...meta });
}

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
  COVERAGE_BROADCAST: 'coverage.broadcast',
  // Phase 3 §3.1 — group duty assignments.
  DUTY_GROUP_ASSIGN: 'duty.group_assign',
  // Phase 3 §3.2 — recurring duty CRUD.
  RECURRING_CREATE: 'recurring.create',
  RECURRING_UPDATE: 'recurring.update',
  RECURRING_DEACTIVATE: 'recurring.deactivate',
  RECURRING_REACTIVATE: 'recurring.reactivate',
  RECURRING_DELETE: 'recurring.delete',
} as const;
