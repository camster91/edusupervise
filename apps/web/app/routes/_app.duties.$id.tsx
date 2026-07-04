// apps/web/app/routes/_app.duties.$id.tsx — Duty detail with group-assign
//
// Phase 3 §3.1 — the assigned-teachers section now supports N teachers
// per duty (Jason's "Cyriac, Loganathan, Sheikh" case). Each
// assignment row has a coverage_role (primary / backup / rotation).
//
// Action intents:
//   - 'assignGroup' : replace this duty's assignment set with a new
//     batch. Payload: a JSON-encoded `entries` array plus the
//     start_date. Used by the multi-select form.
//   - 'unassign'    : remove a single (user_id, coverage_role) row.
//   - 'delete'      : deactivate the duty (unchanged).

import { useLoaderData, Link, Form, redirect, useFetcher, useRouteLoaderData } from 'react-router';
import type { Route } from './+types/_app.duties.$id';
import { getSession, requireSession, requireRole } from '../../server/auth.server.ts';
import {
  ensureCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import { withSchoolId } from '../../server/db.server.ts';
import { duties, dutyAssignments, users, type CoverageRole } from '@edusupervise/db';
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import { useState } from 'react';
import { Trash2, Plus, ChevronDown, Shield } from 'lucide-react';
import { recordAudit, AUDIT } from '../../server/audit.server';
import { Button } from '../components/ui';

export function meta() {
  return [{ title: 'Duty — EduSupervise' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  const { token: csrfToken, setCookie } = ensureCsrfCookie(request);
  const data = await withSchoolId(session.schoolId, async (tx) => {
    const [duty] = await tx
      .select()
      .from(duties)
      .where(eq(duties.id, params.id))
      .limit(1);
    if (!duty) return null;

    // Current assignments (Phase 3 §3.1): includes coverage_role.
    const assignments = await tx
      .select({
        id: dutyAssignments.id,
        userId: dutyAssignments.userId,
        userName: users.name,
        userEmail: users.email,
        coverageRole: dutyAssignments.coverageRole,
        startDate: dutyAssignments.startDate,
        endDate: dutyAssignments.endDate,
        assignedByUserId: dutyAssignments.assignedByUserId,
      })
      .from(dutyAssignments)
      .innerJoin(users, eq(users.id, dutyAssignments.userId))
      .where(eq(dutyAssignments.dutyId, params.id));

    // Teachers available to assign — pulled for the multi-select.
    const schoolUsers = await tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(
        and(
          eq(users.schoolId, session.schoolId),
          eq(users.isActive, true),
          inArray(users.role, ['teacher', 'educational_assistant', 'substitute']),
        ),
      )
      .orderBy(users.name);

    return { duty, assignments, teachers: schoolUsers, csrfToken };
  });

  if (!data) {
    throw new Response('Not found', { status: 404 });
  }

  // The data is already built with csrfToken inside; the outer fetch
  // would re-set it. We just return the populated object.
  if (setCookie) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'Set-Cookie': setCookie,
      },
    });
  }
  return data;
}

export async function action({ request, params }: Route.ActionArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  const intent = String(form.get('intent') ?? '');

  if (intent === 'assignGroup') {
    const entriesRaw = String(form.get('entries') ?? '[]');
    const startDate = String(form.get('startDate') ?? '').slice(0, 10);
    let entries: Array<{ userId: string; role: CoverageRole }> = [];
    try {
      entries = JSON.parse(entriesRaw);
    } catch {
      return Response.json({ error: 'invalid_entries_json' }, { status: 400 });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return Response.json({ error: 'entries_required' }, { status: 400 });
    }
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return Response.json({ error: 'invalid_start_date' }, { status: 400 });
    }
    // Coerce role strings — guard against typos.
    const allowedRoles: CoverageRole[] = ['primary', 'backup', 'rotation'];
    for (const e of entries) {
      if (typeof e.userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(e.userId)) {
        return Response.json({ error: 'invalid_user_id' }, { status: 400 });
      }
      if (!allowedRoles.includes(e.role as CoverageRole)) {
        return Response.json({ error: 'invalid_role' }, { status: 400 });
      }
    }

    const { assignGroup } = await import('../../server/duty-assignments.server');
    await withSchoolId(session.schoolId, async (tx) =>
      assignGroup({
        schoolId: session.schoolId,
        dutyId: params.id,
        entries: entries.map((e) => ({ userId: e.userId, role: e.role as CoverageRole })),
        assignedByUserId: session.userId,
        startDate,
      }),
    );
    await recordAudit({
      schoolId: session.schoolId,
      userId: session.userId,
      action: AUDIT.DUTY_GROUP_ASSIGN,
      targetType: 'duty',
      targetId: params.id,
      metadata: { count: entries.length, startDate },
    });
    return redirect(`/app/duties/${params.id}`);
  }

  if (intent === 'unassign') {
    const userId = String(form.get('userId') ?? '');
    const roleRaw = String(form.get('role') ?? 'primary');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return Response.json({ error: 'invalid_user_id' }, { status: 400 });
    }
    if (!['primary', 'backup', 'rotation'].includes(roleRaw)) {
      return Response.json({ error: 'invalid_role' }, { status: 400 });
    }
    const { unassignFromDuty } = await import('../../server/duty-assignments.server');
    await withSchoolId(session.schoolId, async (tx) =>
      unassignFromDuty({
        schoolId: session.schoolId,
        dutyId: params.id,
        userId,
        coverageRole: roleRaw as CoverageRole,
      }),
    );
    return redirect(`/app/duties/${params.id}`);
  }

  if (intent === 'delete') {
    await withSchoolId(session.schoolId, async (tx) =>
      tx.update(duties).set({ isActive: false }).where(eq(duties.id, params.id)),
    );
    return redirect('/app/duties');
  }

  return Response.json({ error: 'unknown_intent' }, { status: 400 });
}

export default function DutyDetail() {
  const { duty, assignments, teachers, csrfToken } = useLoaderData<typeof loader>();
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">Day {duty.cycleDay} duty</div>
          <h2 className="text-2xl font-bold text-slate-900 mt-1">{duty.location}</h2>
          <div className="text-sm text-slate-600 mt-1">
            {duty.startTime} – {duty.endTime} · {minutesBetween(duty.startTime, duty.endTime)} min
            {duty.requiresVest ? ' · vest' : ''}{duty.requiresRadio ? ' · radio' : ''}
          </div>
        </div>
        <Link to="/app/duties" className="text-sm text-slate-500 hover:text-slate-700">
          ← All duties
        </Link>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl">
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900">
            Assigned teachers{' '}
            <span className="text-xs text-slate-500 ml-1">{assignments.length}</span>
          </h3>
        </header>
        {assignments.length === 0 ? (
          <div className="px-5 py-6 text-sm text-slate-500">No teachers assigned yet.</div>
        ) : (
          <ul className="divide-y divide-slate-200">
            {assignments.map((a) => (
              <li key={a.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-slate-900">{a.userName}</div>
                  <div className="text-xs text-slate-500 flex items-center gap-sm">
                    <span>{a.userEmail}</span>
                    <RoleBadge role={a.coverageRole} />
                    <span>
                      {a.startDate instanceof Date
                        ? a.startDate.toISOString().slice(0, 10)
                        : String(a.startDate).slice(0, 10)}
                      {a.endDate ? ` → ${String(a.endDate).slice(0, 10)}` : ' (open-ended)'}
                    </span>
                  </div>
                </div>
                <Form method="post" className="inline">
                  <input type="hidden" name="csrf" value={csrfToken ?? ''} />
                  <input type="hidden" name="intent" value="unassign" />
                  <input type="hidden" name="userId" value={a.userId} />
                  <input type="hidden" name="role" value={a.coverageRole} />
                  <button
                    type="submit"
                    aria-label={`Remove ${a.userName}`}
                    className="text-tertiary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded p-1"
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        )}

        {/* Group-assign form (Phase 3 §3.1). */}
        <GroupAssignForm
          dutyId={duty.id}
          teachers={teachers}
          csrfToken={csrfToken ?? ''}
          existing={assignments.map((a) => ({ userId: a.userId, role: a.coverageRole }))}
        />
      </section>

      {/*
        Deactivate-duty section unchanged from Phase 1. Admin-only.
      */}
      <Form method="post" className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
        <input type="hidden" name="csrf" value={csrfToken ?? ''} />
        <div>
          <div className="font-medium text-slate-900">Deactivate duty</div>
          <div className="text-xs text-slate-500">Duty will be hidden from active lists.</div>
        </div>
        <button type="submit" name="intent" value="delete" className="text-sm text-red-600 hover:text-red-700">
          Deactivate
        </button>
      </Form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupAssignForm — multi-select with role per row.
// ---------------------------------------------------------------------------

interface TeacherOption {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface ExistingAssignment {
  userId: string;
  role: string;
}

function GroupAssignForm({
  dutyId,
  teachers,
  csrfToken,
  existing,
}: {
  dutyId: string;
  teachers: TeacherOption[];
  csrfToken: string;
  existing: ExistingAssignment[];
}): React.ReactElement {
  // Local state: array of {userId, role}. Default = no rows.
  // We start blank — admin picks who to add, not what's already on.
  const [rows, setRows] = useState<Array<{ userId: string; role: 'primary' | 'backup' | 'rotation' }>>([]);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const fetcher = useFetcher();

  const availableTeachers = teachers.filter((t) => {
    const taken = new Set(existing.map((e) => e.userId));
    return !taken.has(t.id);
  });

  function addRow() {
    setRows((r) => [...r, { userId: availableTeachers[0]?.id ?? '', role: 'primary' }]);
  }

  function updateRow(i: number, patch: Partial<{ userId: string; role: 'primary' | 'backup' | 'rotation' }>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (rows.length === 0) return;
    const payload = {
      intent: 'assignGroup',
      entries: JSON.stringify(rows),
      startDate,
      csrf: csrfToken,
    };
    fetcher.submit(payload, { method: 'post', action: `/app/duties/${dutyId}` });
  }

  const submitting = fetcher.state !== 'idle';

  return (
    <form
      onSubmit={onSubmit}
      className="border-t border-slate-200 px-5 py-4 space-y-sm"
    >
      <input type="hidden" name="csrf" value={csrfToken} />
      <div className="text-sm font-semibold text-slate-900 flex items-center justify-between">
        <span className="inline-flex items-center gap-1">
          <Plus size={14} aria-hidden />
          Assign teachers
        </span>
        <span className="text-xs text-slate-500">{rows.length} queued</span>
      </div>

      {rows.length > 0 && (
        <ul className="space-y-2" role="list">
          {rows.map((row, i) => (
            <li key={i} className="flex items-center gap-2">
              <select
                aria-label="Teacher"
                value={row.userId}
                onChange={(e) => updateRow(i, { userId: e.target.value })}
                className="flex-1 h-input px-sm bg-white border border-slate-300 rounded text-sm"
              >
                <option value="">Select a teacher…</option>
                {/* Allow picking the user already in this row, plus any not-yet-taken */}
                {[...teachers.filter((t) => t.id === row.userId || !existing.some((e) => e.userId === t.id) && !rows.some((r, idx) => idx !== i && r.userId === t.id))].map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.role}
                  </option>
                ))}
              </select>
              <select
                aria-label="Role"
                value={row.role}
                onChange={(e) => updateRow(i, { role: e.target.value as 'primary' | 'backup' | 'rotation' })}
                className="h-input px-sm bg-white border border-slate-300 rounded text-sm"
              >
                <option value="primary">Primary</option>
                <option value="backup">Backup</option>
                <option value="rotation">Rotation</option>
              </select>
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label={`Remove row ${i + 1}`}
                className="text-tertiary hover:text-error p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-sm flex-wrap">
        <Button variant="secondary" size="sm" type="button" onClick={addRow}>
          <Plus size={14} aria-hidden />
          Add row
        </Button>
        <label className="text-xs text-slate-700 inline-flex items-center gap-1">
          Start date
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
            className="px-sm py-1 bg-white border border-slate-300 rounded text-sm"
          />
        </label>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={rows.length === 0 || submitting || rows.some((r) => !r.userId)}
        >
          {submitting ? 'Saving…' : `Assign ${rows.length || ''} teacher${rows.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </form>
  );
}

function RoleBadge({ role }: { role: string }): React.ReactElement {
  const cfg: Record<string, { label: string; cls: string }> = {
    primary:  { label: 'Primary',   cls: 'bg-blue-100 text-blue-700' },
    backup:   { label: 'Backup',    cls: 'bg-amber-100 text-amber-700' },
    rotation: { label: 'Rotation',  cls: 'bg-violet-100 text-violet-700' },
  };
  const c = cfg[role] ?? { label: role, cls: 'bg-slate-100 text-slate-700' };
  return (
    <span className={`inline-flex items-center px-xs py-0.5 rounded-full text-caption-2 font-semibold ${c.cls}`}>
      <Shield size={10} aria-hidden className="mr-1" />
      {c.label}
    </span>
  );
}

function minutesBetween(start: string, end: string): number {
  const parts = (s: string): [number, number] => {
    const [h, m] = s.split(':').map(Number);
    return [h ?? 0, m ?? 0];
  };
  const [sh, sm] = parts(start);
  const [eh, em] = parts(end);
  return (eh * 60 + em) - (sh * 60 + sm);
}

// Suppress unused-imports warning for `isNotNull` — kept here as a
// hint for future filtering (e.g. "show teachers that have a verified
// phone number").
void isNotNull;
void ChevronDown;
