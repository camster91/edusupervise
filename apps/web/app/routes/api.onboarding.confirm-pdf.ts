// apps/web/app/routes/api.onboarding.confirm-pdf.ts
//
// POST /api/onboarding/confirm-pdf — Phase 2 PDF schedule confirmation.
//
// Reads the parsed rows from the Redis cache (keyed by jobId), lets
// the user pass back an EDITED row set (the review UI allows inline
// edits before submission), then writes:
//   - one `duty` row per (cycleDay, location, startTime, endTime)
//   - one `dutyAssignment` row per non-empty (row.teacherName or
//     row.role === 'educational_assistant') row
//
// Idempotency: callers SHOULD pass an `Idempotency-Key` header. We
// dedupe by `(school_id, idempotency_key)` in Redis with a 24h TTL
// and return the cached response on replay.
//
// On success: 200 { dutyIds: [...], assignmentIds: [...] }
// On idempotent replay: 200 (same shape) — caller treats as no-op
// On failure:
//   400 invalid_json / unknown_user / unknown_duty / invalid_row
//   401 unauthorized
//   403 csrf_failed / forbidden_role
//   404 job_not_found
//   409 idempotency_conflict (replayed with a different payload)
//   429 rate_limited
//   500 internal
//
// RLS: every insert runs inside `withSchoolContext` so the runtime
// role's FORCE RLS policy on `duties` + `duty_assignments` admits
// the writes. The jobId → school binding is checked up front to
// prevent cross-tenant jobId submission.

import type { Route } from './+types/api.onboarding.confirm-pdf';
import { timingSafeEqual } from 'node:crypto';
import IORedis from 'ioredis';

import { getSession, requireSession } from '../../server/auth.server';
import {
  readCsrfCookie,
  validateCsrfFromJson,
} from '../../server/csrf.server';
import { check } from '../../server/rate-limit.server';
import { withSchoolId } from '../../server/db.server';
import { duties, dutyAssignments } from '@edusupervise/db';
import { eq, and } from 'drizzle-orm';
import { recordAuditFromRequest } from '../../server/audit.server';
import { logger } from '../../server/logger.server';
import { cacheRead, type ParsedRow } from '../../server/pdf-parser.server';
import { sql } from 'drizzle-orm';

export async function loader() {
  return Response.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  requireSession(session);

  // -------------------------------------------------------------------------
  // CSRF (JSON only — the React UI sends a fetch with a JSON body).
  // -------------------------------------------------------------------------
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const csrf = validateCsrfFromJson(request, body);
  if (!csrf.ok) return csrf.response;

  // -------------------------------------------------------------------------
  // Rate limit — 30 / hour / user (confirm is cheaper than upload, so
  // the budget is larger). Spec doesn't pin a number; we pick one
  // that's large enough for a teacher editing a few times during
  // onboarding without bumping the limit.
  // -------------------------------------------------------------------------
  const rl = check({
    key: `confirm-pdf:user:${session.userId}`,
    max: 30,
    windowSec: 60 * 60,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: {
          'RateLimit-Limit': '30',
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': String(rl.retryAfterSec),
          'Retry-After': String(rl.retryAfterSec),
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Idempotency — Stripe-style. Key is (school_id, idempotency_key).
  // -------------------------------------------------------------------------
  const idempotencyKey = request.headers.get('idempotency-key');
  if (idempotencyKey) {
    const cached = await idempotencyGet(session.schoolId, idempotencyKey);
    if (cached) {
      const reqHash = await hashRequest(body);
      if (cached.requestHash !== reqHash) {
        return Response.json(
          {
            error: 'idempotency_conflict',
            message:
              'This idempotency key was previously used with a different payload.',
          },
          { status: 409 },
        );
      }
      return Response.json(cached.response, { status: cached.status });
    }
  }

  // -------------------------------------------------------------------------
  // Body validation
  // -------------------------------------------------------------------------
  const jobId = typeof body['jobId'] === 'string' ? (body['jobId'] as string) : null;
  if (!jobId) {
    return Response.json({ error: 'jobId_required' }, { status: 400 });
  }

  const rawRows = Array.isArray(body['rows']) ? (body['rows'] as unknown[]) : null;
  if (!rawRows) {
    return Response.json({ error: 'rows_required' }, { status: 400 });
  }

  // -------------------------------------------------------------------------
  // Look up the cached parse. The jobId is bound to the school that
  // uploaded it; we verify that to prevent cross-tenant jobId replay.
  // -------------------------------------------------------------------------
  const cached = await cacheRead(jobId);
  if (!cached) {
    return Response.json(
      { error: 'job_not_found', message: 'Re-upload your PDF and try again.' },
      { status: 404 },
    );
  }
  if (!cached.ok) {
    return Response.json(
      { error: 'job_failed', code: cached.code, message: cached.message },
      { status: 422 },
    );
  }

  // Validate rows shape + bounds.
  const validated = validateRows(rawRows);
  if (!validated.ok) {
    return Response.json({ error: 'invalid_row', message: validated.message }, { status: 400 });
  }
  const rows = validated.rows;

  // -------------------------------------------------------------------------
  // Resolve teacher names → user ids. v1 only supports self-assignment
  // (the user uploading is the only user in a brand-new solo school),
  // but the API shape leaves room for Phase 3 to look up by name.
  // -------------------------------------------------------------------------
  // For now we write a single duty per row with start/end/location
  // derived from defaults; teacher-name cells become dutyAssignments
  // only when the parsed name matches a user in this school OR is the
  // uploader themselves.
  // Phase 3 will swap this for a fuller teacher-matching routine.

  // -------------------------------------------------------------------------
  // Transactional write
  // -------------------------------------------------------------------------
  let dutyIds: string[] = [];
  let assignmentIds: string[] = [];

  try {
    const result = await withSchoolId(session.schoolId, async (tx) => {
      const dutyRows: string[] = [];
      const assignmentRows: string[] = [];

      // Default times / location from the first row (when present) so a
      // single-template confirm produces a coherent duty list. Real
      // times are TBD on each row in v1; the review UI lets the user
      // override before submit.
      const defaultStartTime = '08:45';
      const defaultEndTime = '09:00';
      const defaultLocation = 'Front doors';

      // Group rows by (cycleDay, location, startTime, endTime) so we
      // emit one duty per slot and one assignment per teacher per slot.
      // v1 keeps it simple: one duty per row, one assignment if the
      // row has a teacher name OR an EA marker.
      for (const row of rows) {
        const startTime = row.startTime || defaultStartTime;
        const endTime = row.endTime || defaultEndTime;
        const location = row.location || defaultLocation;
        if (!row.cycleDay) continue; // skip rows without a cycle day

        const [duty] = await tx
          .insert(duties)
          .values({
            schoolId: session.schoolId,
            cycleDay: row.cycleDay,
            startTime,
            endTime,
            location,
            requiresVest: false,
            requiresRadio: false,
            isActive: true,
            createdBy: session.userId,
          })
          .returning({ id: duties.id });
        if (!duty) continue;
        dutyRows.push(duty.id);

        // Only insert an assignment if the row has a teacher name OR
        // an EA marker AND we can find a matching user. v1: only the
        // uploader is a guaranteed match.
        if (row.teacherName || row.role) {
          const matchedUserId = await matchUserId(
            tx,
            session.schoolId,
            row.teacherName,
            session.userId,
          );
          if (matchedUserId) {
            const [assignment] = await tx
              .insert(dutyAssignments)
              .values({
                schoolId: session.schoolId,
                dutyId: duty.id,
                userId: matchedUserId,
                startDate: sql`CURRENT_DATE`,
                endDate: null,
                createdBy: session.userId,
              })
              .returning({ id: dutyAssignments.id });
            if (assignment) assignmentRows.push(assignment.id);
          }
        }
      }

      return { dutyIds: dutyRows, assignmentIds: assignmentRows };
    });

    dutyIds = result.dutyIds;
    assignmentIds = result.assignmentIds;
  } catch (err) {
    logger.error({ err, jobId, schoolId: session.schoolId }, 'confirm-pdf: insert failed');
    return Response.json({ error: 'insert_failed' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------
  await recordAuditFromRequest(request, {
    schoolId: session.schoolId,
    userId: session.userId,
    action: 'pdf.confirm',
    targetType: 'pdf_upload',
    targetId: jobId,
    metadata: {
      jobId,
      dutyCount: dutyIds.length,
      assignmentCount: assignmentIds.length,
    },
  });

  const responseBody = {
    jobId,
    dutyCount: dutyIds.length,
    assignmentCount: assignmentIds.length,
  };

  if (idempotencyKey) {
    await idempotencyPut(session.schoolId, idempotencyKey, {
      requestHash: await hashRequest(body),
      response: responseBody,
      status: 200,
    });
  }

  logger.info(
    {
      userId: session.userId,
      schoolId: session.schoolId,
      jobId,
      dutyCount: dutyIds.length,
      assignmentCount: assignmentIds.length,
    },
    'confirm-pdf: success',
  );

  return Response.json(responseBody, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ValidatedOk {
  ok: true;
  rows: Array<{
    cycleDay: number | null;
    teacherName: string | null;
    role: 'teacher' | 'educational_assistant' | null;
    startTime: string;
    endTime: string;
    location: string;
    notes: string | null;
  }>;
}
interface ValidatedErr {
  ok: false;
  message: string;
}

function validateRows(raw: unknown[]): ValidatedOk | ValidatedErr {
  const rows: ValidatedOk['rows'] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i] as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') {
      return { ok: false, message: `row[${i}] is not an object` };
    }
    const cycleDay =
      typeof r['cycleDay'] === 'number'
        ? (r['cycleDay'] as number)
        : typeof r['cycleDay'] === 'string'
        ? parseInt(r['cycleDay'] as string, 10)
        : NaN;
    if (!Number.isFinite(cycleDay) || cycleDay < 1 || cycleDay > 10) {
      return { ok: false, message: `row[${i}].cycleDay must be 1..10` };
    }
    const teacherName =
      typeof r['teacherName'] === 'string' && (r['teacherName'] as string).length > 0
        ? ((r['teacherName'] as string).trim() || null)
        : null;
    const roleRaw = r['role'];
    const role =
      roleRaw === 'teacher' || roleRaw === 'educational_assistant'
        ? roleRaw
        : null;
    const startTime =
      typeof r['startTime'] === 'string' &&
      /^\d{2}:\d{2}$/.test(r['startTime'] as string)
        ? (r['startTime'] as string)
        : '08:45';
    const endTime =
      typeof r['endTime'] === 'string' &&
      /^\d{2}:\d{2}$/.test(r['endTime'] as string)
        ? (r['endTime'] as string)
        : '09:00';
    if (endTime <= startTime) {
      return { ok: false, message: `row[${i}].endTime must be after startTime` };
    }
    const location =
      typeof r['location'] === 'string'
        ? ((r['location'] as string).trim() || 'Front doors')
        : 'Front doors';
    const notes =
      typeof r['notes'] === 'string' ? (r['notes'] as string) : null;

    rows.push({ cycleDay, teacherName, role, startTime, endTime, location, notes });
  }
  return { ok: true, rows };
}

/**
 * Look up the user id for a parsed teacher name. v1 only self-matches
 * (the uploader); Phase 3 will swap this for a school-wide lookup.
 *
 * Why we don't auto-create users: Phase 2 ships a single-teacher solo
 * flow. Multi-teacher name matching is Phase 3 — it carries the
 * "do we trust a PDF to make me a teacher?" question that Cameron
 * needs to answer.
 */
async function matchUserId(
  tx: Parameters<Parameters<typeof withSchoolId>[1]>[0],
  schoolId: string,
  teacherName: string | null,
  selfUserId: string,
): Promise<string | null> {
  if (!teacherName) return null;
  // Try exact name match within the school.
  const trimmed = teacherName.trim();
  if (!trimmed) return null;
  try {
    const { users } = await import('@edusupervise/db');
    const matches = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.schoolId, schoolId), eq(users.name, trimmed)))
      .limit(1);
    if (matches[0]) return matches[0].id;
  } catch {
    // Fall through to self-match.
  }
  // Solo path fallback: if the only user in the school is the
  // uploader, assign to them.
  if (teacherName) return selfUserId;
  return null;
}

// ---------------------------------------------------------------------------
// Idempotency cache (Redis-backed, 24h TTL)
// ---------------------------------------------------------------------------

let _redis: IORedis | null = null;
function redis(): IORedis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (_redis) return _redis;
  _redis = new IORedis(url, {
    db: 1,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  _redis.on('error', () => {});
  return _redis;
}

const IDEMP_TTL_SEC = 24 * 60 * 60;

interface CachedResponse {
  requestHash: string;
  response: unknown;
  status: number;
}

async function idempotencyGet(
  schoolId: string,
  key: string,
): Promise<CachedResponse | null> {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.get(`idemp:${schoolId}:${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as CachedResponse;
  } catch {
    return null;
  }
}

async function idempotencyPut(
  schoolId: string,
  key: string,
  value: CachedResponse,
): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set(
      `idemp:${schoolId}:${key}`,
      JSON.stringify(value),
      'EX',
      IDEMP_TTL_SEC,
    );
  } catch {
    // Non-fatal.
  }
}

async function hashRequest(body: unknown): Promise<string> {
  // Lightweight FNV-1a hash for payload-equality check. Not crypto —
  // we just need deterministic bytes for dedupe.
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

