// apps/web/app/routes/api.billing.audit-export[.csv].tsx
//
// GET /api/billing/audit-export.csv — download the authenticated
// school's audit log as a CSV. Used during the downgrade-grace window
// (per spec section 6) so the admin can take a backup before their
// retention window shrinks.
//
// Filename escaping: the `[.csv]` portion of the filename becomes a
// literal `.csv` in the URL; RR7's route config compiler preserves
// the dot inside `[...]`.
//
// Authenticated + admin-only. Returns:
//   - 200 text/csv with the audit log rows
//   - 404 if the school has no audit log entries (still emits a
//     header-only CSV so the client doesn't choke)
//   - 401/403 for unauth/non-admin
//
// CSV columns: id, school_id, user_id, action, target_type, target_id,
// metadata (jsonb stringified), ip_address, user_agent, created_at.

import type { Route } from './+types/api.billing.audit-export_.csv';
import { eq } from 'drizzle-orm';
import { auditLog } from '@edusupervise/db';

import { getSession, requireRole } from '../../server/auth.server';
import { getDb } from '../../server/db.server';
import { logger } from '../../server/logger.server';

export async function action() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  requireRole(session, ['school_admin']);

  const db = getDb();
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.schoolId, session.schoolId))
    .orderBy(auditLog.createdAt);

  const csv = toCsv(rows);

  logger.info(
    { schoolId: session.schoolId, count: rows.length },
    'billing: audit-log CSV exported',
  );

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      // RFC 5987 — filename*. Modern browsers pick this up; old IE/Edge
      // fall back to the plain filename.
      'content-disposition':
        `attachment; filename="audit-${session.schoolId.slice(0, 8)}.csv"; ` +
        `filename*=utf-8''audit-${session.schoolId.slice(0, 8)}.csv`,
      'cache-control': 'no-store',
    },
  });
}

/**
 * Convert audit_log rows to CSV with proper escaping. Pure function
 * for unit-testability.
 */
export function toCsv(
  rows: ReadonlyArray<{
    id: bigint | number;
    schoolId: string;
    userId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date | null;
  }>,
): string {
  const headers = [
    'id',
    'school_id',
    'user_id',
    'action',
    'target_type',
    'target_id',
    'metadata',
    'ip_address',
    'user_agent',
    'created_at',
  ];
  const lines: string[] = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        String(r.id),
        r.schoolId,
        r.userId ?? '',
        r.action,
        r.targetType ?? '',
        r.targetId ?? '',
        // metadata is jsonb; we stringify so the cell is plain text
        r.metadata === null || r.metadata === undefined
          ? ''
          : csvEscape(JSON.stringify(r.metadata)),
        r.ipAddress ?? '',
        r.userAgent ?? '',
        r.createdAt instanceof Date ? r.createdAt.toISOString() : '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

function csvEscape(value: string): string {
  // Quote any cell containing comma, quote, or newline; double-up
  // embedded quotes.
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
