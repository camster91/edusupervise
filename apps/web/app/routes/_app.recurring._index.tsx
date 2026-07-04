// apps/web/app/routes/_app.recurring._index.tsx — Recurring duties CRUD
// (Phase 3 §3.2). Admin-only page.
//
// Why a separate page from /app/duties:
//   - /app/duties is cycle-day keyed (Day 1..5 rotation).
//   - Recurring duties fire every weekday at the same time, regardless
//     of cycle day. They have no `cycleDay`. Sharing the index would
//     either bloat the cycle-day UI or hide the recurring ones behind
//     a filter — both bad. Distinct route, distinct admin page.
//
// Auth gating: only school_admin can create / edit / deactivate.
// Plan gating: only schools on plan >= 'school' can create recurring
// duties. The action handler calls `requireSchoolPlan(tx, schoolId,
// 'recurring.duties')` and throws a 403 with the typed JSON body; the
// UpgradePrompt modal reads that body and explains why.

import * as React from 'react';
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  redirect,
  data as routeData,
  useRouteLoaderData,
} from 'react-router';
import { Plus, Trash2, Power, AlertCircle, Lock } from 'lucide-react';
import { and, eq } from 'drizzle-orm';
import type { Route } from './+types/_app.recurring._index';
import { getSession, requireSession, requireRole } from '../../server/auth.server';
import { ensureCsrfCookie, validateCsrfWithFormToken } from '../../server/csrf.server';
import { withSchoolId } from '../../server/db.server';
import {
  recurringDuties,
  users,
  schools,
} from '@edusupervise/db';
import { requireSchoolPlan } from '../../server/plan-enforcement.server';
import { recordAudit, AUDIT } from '../../server/audit.server';
import {
  Button,
  EmptyState,
  Sheet,
  Banner,
} from '../components/ui';
import { RecurringDutyCard } from '../components/RecurringDutyCard';
import { UpgradePrompt, type UpgradeReason } from '../components/UpgradePrompt';

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function meta() {
  return [{ title: 'Recurring duties — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const { token: csrfToken, setCookie } = ensureCsrfCookie(request);

  const data = await withSchoolId(session.schoolId, async (tx) => {
    const [school] = await tx
      .select({ plan: schools.plan })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);

    const duties = await tx
      .select({
        id: recurringDuties.id,
        name: recurringDuties.name,
        location: recurringDuties.location,
        startTime: recurringDuties.startTime,
        endTime: recurringDuties.endTime,
        daysOfWeek: recurringDuties.daysOfWeek,
        assignedUserId: recurringDuties.assignedUserId,
        assignedUserName: users.name,
        requiresVest: recurringDuties.requiresVest,
        requiresRadio: recurringDuties.requiresRadio,
        isActive: recurringDuties.isActive,
      })
      .from(recurringDuties)
      .leftJoin(users, eq(users.id, recurringDuties.assignedUserId))
      .where(eq(recurringDuties.schoolId, session.schoolId))
      .orderBy(recurringDuties.startTime);

    const teachers = await tx
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(and(eq(users.schoolId, session.schoolId), eq(users.isActive, true)))
      .orderBy(users.name);

    return { plan: school?.plan ?? 'free', duties, teachers };
  });

  const payload = { ...data, csrfToken };
  return setCookie
    ? routeData(payload, { headers: { 'Set-Cookie': setCookie } })
    : payload;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

type Intent = 'create' | 'update' | 'deactivate' | 'reactivate' | 'delete';

export async function action({ request }: Route.ActionArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  const intent = String(form.get('intent') ?? '') as Intent;
  if (!['create', 'update', 'deactivate', 'reactivate', 'delete'].includes(intent)) {
    return Response.json({ error: 'invalid_intent' }, { status: 400 });
  }

  if (intent === 'create' || intent === 'update') {
    const gate = await withSchoolId(session.schoolId, async (tx) =>
      requireSchoolPlan(tx, session.schoolId, 'recurring.duties'),
    );
    if (!gate.ok) return gate.response;
  }

  if (intent === 'create') {
    const name = String(form.get('name') ?? '').trim();
    const location = String(form.get('location') ?? '').trim() || null;
    const startTime = String(form.get('startTime') ?? '').trim();
    const endTime = String(form.get('endTime') ?? '').trim();
    const daysOfWeek = Number(form.get('daysOfWeek') ?? '0');
    const assignedUserId = String(form.get('assignedUserId') ?? '').trim() || null;
    const requiresVest = form.get('requiresVest') === 'on';
    const requiresRadio = form.get('requiresRadio') === 'on';

    if (!name || !startTime || !endTime || daysOfWeek === 0) {
      return Response.json({ error: 'missing_fields' }, { status: 400 });
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
      return Response.json({ error: 'invalid_time_format' }, { status: 400 });
    }
    if (endTime <= startTime) {
      return Response.json({ error: 'end_must_be_after_start' }, { status: 400 });
    }
    if (daysOfWeek < 1 || daysOfWeek > 127) {
      return Response.json({ error: 'invalid_days_of_week' }, { status: 400 });
    }

    return withSchoolId(session.schoolId, async (tx) => {
      const [row] = await tx
        .insert(recurringDuties)
        .values({
          schoolId: session.schoolId,
          name,
          location,
          startTime,
          endTime,
          daysOfWeek,
          assignedUserId,
          requiresVest,
          requiresRadio,
          isActive: true,
          createdBy: session.userId,
        })
        .returning({ id: recurringDuties.id });

      await recordAudit({
        schoolId: session.schoolId,
        userId: session.userId,
        action: AUDIT.RECURRING_CREATE,
        targetType: 'recurring_duty',
        targetId: row!.id,
        metadata: { name, daysOfWeek, startTime, endTime },
      });

      return redirect('/app/recurring');
    });
  }

  if (intent === 'update') {
    const id = String(form.get('id') ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return Response.json({ error: 'invalid_id' }, { status: 400 });
    }
    const name = String(form.get('name') ?? '').trim();
    const location = String(form.get('location') ?? '').trim() || null;
    const startTime = String(form.get('startTime') ?? '').trim();
    const endTime = String(form.get('endTime') ?? '').trim();
    const daysOfWeek = Number(form.get('daysOfWeek') ?? '0');
    const assignedUserId = String(form.get('assignedUserId') ?? '').trim() || null;
    const requiresVest = form.get('requiresVest') === 'on';
    const requiresRadio = form.get('requiresRadio') === 'on';

    if (!name || !startTime || !endTime || daysOfWeek === 0) {
      return Response.json({ error: 'missing_fields' }, { status: 400 });
    }

    return withSchoolId(session.schoolId, async (tx) => {
      const result = await tx
        .update(recurringDuties)
        .set({
          name,
          location,
          startTime,
          endTime,
          daysOfWeek,
          assignedUserId,
          requiresVest,
          requiresRadio,
          updatedAt: new Date(),
        })
        .where(and(eq(recurringDuties.id, id), eq(recurringDuties.schoolId, session.schoolId)))
        .returning({ id: recurringDuties.id });
      if (result.length === 0) {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      await recordAudit({
        schoolId: session.schoolId,
        userId: session.userId,
        action: AUDIT.RECURRING_UPDATE,
        targetType: 'recurring_duty',
        targetId: id,
      });
      return redirect('/app/recurring');
    });
  }

  if (intent === 'deactivate' || intent === 'reactivate' || intent === 'delete') {
    const id = String(form.get('id') ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return Response.json({ error: 'invalid_id' }, { status: 400 });
    }

    return withSchoolId(session.schoolId, async (tx) => {
      if (intent === 'delete') {
        await tx
          .delete(recurringDuties)
          .where(and(eq(recurringDuties.id, id), eq(recurringDuties.schoolId, session.schoolId)));
        await recordAudit({
          schoolId: session.schoolId,
          userId: session.userId,
          action: AUDIT.RECURRING_DELETE,
          targetType: 'recurring_duty',
          targetId: id,
        });
      } else {
        const isActive = intent === 'reactivate';
        await tx
          .update(recurringDuties)
          .set({ isActive, updatedAt: new Date() })
          .where(and(eq(recurringDuties.id, id), eq(recurringDuties.schoolId, session.schoolId)));
        await recordAudit({
          schoolId: session.schoolId,
          userId: session.userId,
          action: isActive ? AUDIT.RECURRING_REACTIVATE : AUDIT.RECURRING_DEACTIVATE,
          targetType: 'recurring_duty',
          targetId: id,
        });
      }
      return redirect('/app/recurring');
    });
  }

  return Response.json({ error: 'unhandled_intent' }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RecurringDutiesPage() {
  const loaderResult = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== 'idle';
  const duties = loaderResult.duties;
  const teachers = loaderResult.teachers;
  const plan = loaderResult.plan;
  const csrfToken = loaderResult.csrfToken;

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [upgradeReason, setUpgradeReason] = React.useState<UpgradeReason | null>(null);

  // Surface 403 plan-gate responses from the action.
  React.useEffect(() => {
    if (
      actionData &&
      typeof actionData === 'object' &&
      'error' in actionData &&
      (actionData as { error: string }).error === 'plan_feature_locked'
    ) {
      setUpgradeReason(actionData as unknown as UpgradeReason);
    }
  }, [actionData]);

  const editing = editingId ? duties.find((d) => d.id === editingId) ?? null : null;

  // Phase 3 §3.3 — recurring.duties is gated behind `school` tier.
  // Free / trial / pro schools see the read-only list but cannot mutate.
  const isSchoolPlan = plan === 'school';

  return (
    <div className="max-w-3xl mx-auto space-y-xl pb-3xl">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-title-1 text-primary font-bold flex items-center gap-sm">
            <Power size={28} aria-hidden className="text-secondary" />
            Recurring duties
          </h1>
          <p className="text-callout text-secondary mt-xs">
            Time-bound duties that fire on the same weekday(s) every week. Use for
            Early Entry, Kiss &amp; Ride, Late Pickup, and similar standing duties.
          </p>
        </div>
        {isSchoolPlan ? (
          <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
            <Plus size={18} aria-hidden />
            New recurring duty
          </Button>
        ) : null}
      </div>

      {!isSchoolPlan && (
        <Banner
          variant="info"
          message={
            <>
              <Lock size={14} aria-hidden className="inline -mt-0.5 mr-1" />
              Recurring duties are a School-plan feature.{' '}
              <a href="/app/settings/billing" className="font-semibold underline">
                Upgrade to School
              </a>{' '}
              to add them.
            </>
          }
        />
      )}

      {duties.length === 0 ? (
        <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
          <EmptyState
            icon={<Power size={48} aria-hidden />}
            title="No recurring duties yet"
            description="Add Early Entry, Late Pickup, and similar standing duties so teachers know what they're on every weekday morning."
            action={
              isSchoolPlan
                ? { label: 'New recurring duty', onClick: () => setCreateOpen(true) }
                : undefined
            }
          />
        </div>
      ) : (
        <ul className="space-y-md" role="list">
          {duties.map((d) => (
            <li
              key={d.id}
              className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden"
            >
              <div className="px-lg py-md">
                <RecurringDutyCard
                  duty={{
                    id: d.id,
                    name: d.name,
                    location: d.location,
                    startTime: d.startTime,
                    endTime: d.endTime,
                    daysOfWeek: d.daysOfWeek,
                    assignedUserId: d.assignedUserId,
                    assignedUserName: d.assignedUserName,
                    requiresVest: d.requiresVest,
                    requiresRadio: d.requiresRadio,
                  }}
                />
                {isSchoolPlan && (
                  <div className="mt-md flex items-center gap-sm flex-wrap">
                    <Button variant="secondary" size="sm" onClick={() => setEditingId(d.id)}>
                      Edit
                    </Button>
                    {d.isActive ? (
                      <Form method="post" className="inline">
                        <input type="hidden" name="csrf" value={csrfToken} />
                        <input type="hidden" name="intent" value="deactivate" />
                        <input type="hidden" name="id" value={d.id} />
                        <Button variant="secondary" size="sm" type="submit" disabled={submitting}>
                          <Power size={14} aria-hidden />
                          Deactivate
                        </Button>
                      </Form>
                    ) : (
                      <Form method="post" className="inline">
                        <input type="hidden" name="csrf" value={csrfToken} />
                        <input type="hidden" name="intent" value="reactivate" />
                        <input type="hidden" name="id" value={d.id} />
                        <Button variant="secondary" size="sm" type="submit" disabled={submitting}>
                          Reactivate
                        </Button>
                      </Form>
                    )}
                    <Form
                      method="post"
                      className="inline ml-auto"
                      onSubmit={(e) => {
                        if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) {
                          e.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="csrf" value={csrfToken} />
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={d.id} />
                      <Button variant="tertiary" size="sm" type="submit" disabled={submitting}>
                        <Trash2 size={14} aria-hidden />
                        Delete
                      </Button>
                    </Form>
                  </div>
                )}
                {!d.isActive && (
                  <div className="mt-sm text-footnote text-tertiary">
                    <span className="inline-flex items-center gap-1">
                      <AlertCircle size={12} aria-hidden />
                      Inactive — won't fire on weekdays.
                    </span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <RecurringDutyForm
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        teachers={teachers}
        csrfToken={csrfToken}
      />

      {editing && (
        <RecurringDutyForm
          mode="edit"
          open={true}
          onOpenChange={(o) => {
            if (!o) setEditingId(null);
          }}
          teachers={teachers}
          initial={editing}
          csrfToken={csrfToken}
        />
      )}

      <UpgradePrompt
        open={upgradeReason != null}
        onOpenChange={(o) => {
          if (!o) setUpgradeReason(null);
        }}
        reason={upgradeReason}
        upgradePlan="school"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (form)
// ---------------------------------------------------------------------------

interface RecurringDutyFormInitial {
  id: string;
  name: string;
  location: string | null;
  startTime: string;
  endTime: string;
  daysOfWeek: number;
  assignedUserId: string | null;
  requiresVest: boolean;
  requiresRadio: boolean;
  isActive: boolean;
}

interface RecurringDutyFormProps {
  mode: 'create' | 'edit';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teachers: Array<{ id: string; name: string; role: string }>;
  initial?: RecurringDutyFormInitial;
  csrfToken: string;
}

function RecurringDutyForm({
  mode,
  open,
  onOpenChange,
  teachers,
  initial,
  csrfToken,
}: RecurringDutyFormProps): React.ReactElement {
  const [name, setName] = React.useState(initial?.name ?? '');
  const [location, setLocation] = React.useState(initial?.location ?? '');
  const [startTime, setStartTime] = React.useState(initial?.startTime ?? '08:45');
  const [endTime, setEndTime] = React.useState(initial?.endTime ?? '09:00');
  const [bitmask, setBitmask] = React.useState<number>(initial?.daysOfWeek ?? 31);
  const [assigned, setAssigned] = React.useState(initial?.assignedUserId ?? '');
  const [vest, setVest] = React.useState(initial?.requiresVest ?? false);
  const [radio, setRadio] = React.useState(initial?.requiresRadio ?? false);

  const dayChips: Array<{ key: string; bit: number; label: string }> = [
    { key: 'Mon', bit: 1, label: 'Mon' },
    { key: 'Tue', bit: 2, label: 'Tue' },
    { key: 'Wed', bit: 4, label: 'Wed' },
    { key: 'Thu', bit: 8, label: 'Thu' },
    { key: 'Fri', bit: 16, label: 'Fri' },
    { key: 'Sat', bit: 32, label: 'Sat' },
    { key: 'Sun', bit: 64, label: 'Sun' },
  ];

  function toggleDay(bit: number) {
    setBitmask((b) => (b & bit) ? b & ~bit : b | bit);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'create' ? 'New recurring duty' : `Edit ${initial?.name ?? ''}`}
      description="Time-bound duty that fires on the days below. Teachers see it on /app/today on each firing day."
      detent="large"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            type="submit"
            form={`recurring-form-${mode}`}
          >
            {mode === 'create' ? 'Create duty' : 'Save changes'}
          </Button>
        </>
      }
    >
      <Form
        method="post"
        id={`recurring-form-${mode}`}
        className="space-y-md"
      >
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value={mode === 'create' ? 'create' : 'update'} />
        {initial && <input type="hidden" name="id" value={initial.id} />}
        <div>
          <label className="block text-subhead text-secondary mb-xs" htmlFor="rec-name">
            Name
          </label>
          <input
            id="rec-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            placeholder="e.g. Early Entry"
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-subhead text-secondary mb-xs" htmlFor="rec-location">
            Location <span className="text-tertiary font-normal">(optional)</span>
          </label>
          <input
            id="rec-location"
            name="location"
            value={location ?? ''}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={200}
            placeholder="e.g. Kiss N Ride (south end)"
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="grid grid-cols-2 gap-md">
          <label className="block">
            <span className="block text-subhead text-secondary mb-xs">Start</span>
            <input
              type="time"
              name="startTime"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
              step={300}
              className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary tabular focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
          <label className="block">
            <span className="block text-subhead text-secondary mb-xs">End</span>
            <input
              type="time"
              name="endTime"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              required
              step={300}
              className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary tabular focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        </div>
        <fieldset>
          <legend className="block text-subhead text-secondary mb-xs">Days of the week</legend>
          <div className="flex flex-wrap gap-xs">
            {dayChips.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => toggleDay(d.bit)}
                className={
                  (bitmask & d.bit)
                    ? 'px-md py-xs rounded-full bg-accent text-white text-callout font-semibold'
                    : 'px-md py-xs rounded-full bg-surface-3 text-secondary text-callout font-medium hover:bg-surface-2'
                }
              >
                {d.label}
              </button>
            ))}
          </div>
          <input type="hidden" name="daysOfWeek" value={bitmask} />
          <p className="text-footnote text-tertiary mt-xs">
            Pick the days this duty fires. Bitmask = Mon=1, Tue=2, …, Fri=16.
          </p>
        </fieldset>
        <label className="block">
          <span className="block text-subhead text-secondary mb-xs">Assigned teacher</span>
          <select
            name="assignedUserId"
            value={assigned ?? ''}
            onChange={(e) => setAssigned(e.target.value)}
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">— Unassigned —</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.role})
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="block text-subhead text-secondary mb-xs">Equipment</legend>
          <div className="flex gap-md">
            <label className="flex items-center gap-sm">
              <input
                type="checkbox"
                name="requiresVest"
                checked={vest}
                onChange={(e) => setVest(e.target.checked)}
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
              />
              <span className="text-callout">Vest</span>
            </label>
            <label className="flex items-center gap-sm">
              <input
                type="checkbox"
                name="requiresRadio"
                checked={radio}
                onChange={(e) => setRadio(e.target.checked)}
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
              />
              <span className="text-callout">Radio</span>
            </label>
          </div>
        </fieldset>
      </Form>
    </Sheet>
  );
}

// Unused-import silencer so the linter doesn't flag routeData when
// the loader signature changes. (Kept for future when we need it.)
void useRouteLoaderData;
void routeData;
