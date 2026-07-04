// apps/web/app/routes/_app.coverage._index.tsx — Coverage Router (Phase 2B)
//
// The load-bearing adjacent opportunity from the research synthesis.
// When a teacher is out, this view shows the open coverage events +
// their assignments, and lets admins create new absences.
//
// Phase 3 §3.4 — admins can now toggle "Broadcast to all teachers" so
// the absence fans out to every eligible teacher (first-accept-wins)
// instead of routing to a single replacement. Toggle goes to
// /api/coverage/broadcast instead of /api/coverage/absences.

import { useState } from 'react';
import {
  useLoaderData,
  useFetcher,
  Form,
  redirect,
  useRouteLoaderData,
} from 'react-router';
import {
  Bell,
  Plus,
  Check,
  X,
  Clock,
  AlertCircle,
  Megaphone,
  type LucideIcon,
} from 'lucide-react';
import { and, eq } from 'drizzle-orm';
import type { Route } from './+types/_app.coverage._index';
import { getSession, requireSession } from '../../server/auth.server';
import { withSchoolId, getDb } from '../../server/db.server';
import { listCoverage, type CoverageSource } from '../../server/coverage.server';
import { users, schools } from '@edusupervise/db';
import { Button, EmptyState, Sheet, HeroCard, Banner } from '../components/ui';
import { Link } from 'react-router';
import { UpgradePrompt, type UpgradeReason } from '../components/UpgradePrompt';

export function meta() {
  return [{ title: 'Coverage — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));

  const data = await withSchoolId(session.schoolId, async (tx) => {
    const events = await listCoverage({ schoolId: session.schoolId });
    const [school] = await tx
      .select({ plan: schools.plan })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    let teachers: Array<{ id: string; name: string }> = [];
    if (session.role === 'school_admin') {
      teachers = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.schoolId, session.schoolId), eq(users.role, 'teacher')))
        .orderBy(users.name);
    }
    return { events, teachers, plan: school?.plan ?? 'free' };
  });

  return data;
}

export default function CoveragePage() {
  const { events, teachers, plan } = useLoaderData<typeof loader>();
  const appData = useRouteLoaderData('routes/_app') as
    | { csrfToken?: string; user?: { role: 'school_admin' | 'teacher' | 'educational_assistant' | 'substitute' } }
    | undefined;
  const csrfToken = appData?.csrfToken ?? '';
  const role = appData?.user?.role;
  const [createOpen, setCreateOpen] = useState(false);
  const fetcher = useFetcher();
  const [upgradeReason, setUpgradeReason] = useState<UpgradeReason | null>(null);

  // Aggregate counts for the header
  const totalAssignments = events.reduce((s, e) => s + e.assignments.length, 0);
  const pending = events.reduce(
    (s, e) => s + e.assignments.filter((a) => a.status === 'pending').length,
    0,
  );
  const uncovered = events.reduce(
    (s, e) => s + e.assignments.filter((a) => a.status === 'uncovered').length,
    0,
  );

  // Surface 403 plan-gate responses from any fetcher (broadcast, etc.)
  if (
    fetcher.state === 'idle' &&
    fetcher.data &&
    typeof fetcher.data === 'object' &&
    'error' in (fetcher.data as { error?: unknown }) &&
    (fetcher.data as { error: string }).error === 'plan_feature_locked'
  ) {
    if (!upgradeReason) {
      setUpgradeReason(fetcher.data as unknown as UpgradeReason);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-xl pb-3xl">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-title-1 text-primary font-bold flex items-center gap-sm">
            <Bell size={28} aria-hidden className="text-secondary" />
            Coverage
          </h1>
          <p className="text-callout text-secondary mt-xs">
            {events.length === 0
              ? 'No coverage events right now.'
              : `${totalAssignments} ${totalAssignments === 1 ? 'duty' : 'duties'} across ${events.length} ${events.length === 1 ? 'event' : 'events'}.`}
          </p>
        </div>
        {role === 'school_admin' && (
          <div className="flex items-center gap-sm">
            <Link
              to="/app/coverage/alerts"
              className="inline-flex items-center justify-center h-btn-md px-lg rounded-md font-medium text-accent hover:bg-accent-soft transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              <Bell size={16} aria-hidden />
              Parent alerts
            </Link>
            <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
              <Plus size={18} aria-hidden />
              New absence
            </Button>
          </div>
        )}
      </div>

      {uncovered > 0 && (
        <Banner
          variant="warning"
          message={`${uncovered} ${uncovered === 1 ? 'duty is' : 'duties are'} still uncovered. Page your school's duty coordinator or escalate to a manual swap.`}
        />
      )}

      {events.length === 0 ? (
        <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
          <EmptyState
            icon={<Bell size={48} aria-hidden />}
            title="No coverage events"
            description={
              role === 'school_admin'
                ? "When a teacher is out, the Coverage Router will list the affected duties here and notify replacement teachers automatically."
                : "When a colleague is out and you're offered a coverage request, it will appear here for you to accept or decline."
            }
            action={role === 'school_admin' ? { label: 'Record an absence', onClick: () => setCreateOpen(true) } : undefined}
          />
        </div>
      ) : (
        <ul className="space-y-lg" role="list">
          {events.map((e) => (
            <li
              key={e.eventId}
              className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden"
            >
              <EventHeader
                teacherName={e.teacherName}
                absenceDate={e.absenceDate}
                reason={e.reason}
                status={e.status}
                source={e.source}
              />
              {e.assignments.length === 0 ? (
                <p className="text-callout text-secondary px-xl py-md">
                  No duties were assigned to this teacher on this day.
                </p>
              ) : (
                <ul className="divide-y divide-divider" role="list">
                  {e.assignments.map((a) => (
                    <li key={a.id}>
                      <AssignmentRow assignment={a} csrfToken={csrfToken} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <CreateAbsenceSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        teachers={teachers}
        csrfToken={csrfToken}
        onCreated={() => setCreateOpen(false)}
        plan={plan}
        onUpgradeGate={(r) => setUpgradeReason(r)}
      />

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

function EventHeader({
  teacherName,
  absenceDate,
  reason,
  status,
  source,
}: {
  teacherName: string;
  absenceDate: string;
  reason: string | null;
  status: string;
  source: string;
}): React.ReactElement {
  const date = new Date(absenceDate + 'T00:00:00');
  return (
    <header className="px-xl py-md border-b border-divider flex items-center justify-between bg-surface-2">
      <div>
        <h2 className="text-title-3 text-primary font-semibold">
          {teacherName}
        </h2>
        <p className="text-callout text-secondary mt-xs flex items-center gap-xs">
          <Clock size={14} aria-hidden />
          {date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          {reason && <span className="text-tertiary">· {reason}</span>}
        </p>
      </div>
      <div className="flex items-center gap-sm">
        {source === 'broadcast' && (
          <span className="inline-flex items-center gap-xs px-sm py-0.5 rounded-full text-caption-2 font-semibold uppercase tracking-wide bg-info-soft text-info">
            <Megaphone size={12} aria-hidden />
            Broadcast
          </span>
        )}
        <StatusBadge status={status} />
      </div>
    </header>
  );
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const config: Record<string, { label: string; cls: string }> = {
    open:    { label: 'Open',     cls: 'bg-warning-soft text-warning' },
    routed:  { label: 'Routed',   cls: 'bg-accent-soft text-accent' },
    closed:  { label: 'Closed',   cls: 'bg-surface-3 text-secondary' },
    pending: { label: 'Pending',  cls: 'bg-warning-soft text-warning' },
    accepted:{ label: 'Accepted', cls: 'bg-success-soft text-success' },
    declined:{ label: 'Declined', cls: 'bg-error-soft text-error' },
    uncovered:{ label: 'Uncovered', cls: 'bg-error-soft text-error' },
  };
  const c: { label: string; cls: string } = config[status] ?? config.open ?? { label: 'Unknown', cls: 'bg-surface-3 text-secondary' };
  return (
    <span
      className={`inline-flex items-center px-sm py-xs rounded-full text-caption-2 font-semibold uppercase tracking-wide ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

function AssignmentRow({
  assignment,
  csrfToken,
}: {
  assignment: {
    id: string;
    dutyName: string;
    startTime: string;
    endTime: string;
    location: string | null;
    newTeacherId: string | null;
    newTeacherName: string | null;
    status: string;
  };
  csrfToken: string;
}): React.ReactElement {
  const fetcher = useFetcher();
  const isPending = assignment.status === 'pending';
  const isMine = assignment.newTeacherId != null; // could refine with current user

  return (
    <div className="px-xl py-md flex items-center gap-md">
      <div className="text-callout text-secondary font-medium tabular w-28 shrink-0">
        {formatTime12h(assignment.startTime)} – {formatTime12h(assignment.endTime)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-body text-primary font-semibold">
          {assignment.dutyName}
        </div>
        <div className="text-footnote text-secondary mt-xs">
          {assignment.newTeacherName
            ? <>Asked: <strong className="text-primary">{assignment.newTeacherName}</strong></>
            : <span className="text-error">No replacement yet</span>}
        </div>
      </div>
      <StatusBadge status={assignment.status} />
      {isPending && isMine && (
        <div className="flex items-center gap-xs shrink-0">
          <Button
            variant="primary"
            size="icon-sm"
            aria-label="Accept coverage"
            onClick={() => {
              fetcher.submit(
                { assignmentId: assignment.id, csrf: csrfToken },
                { method: 'POST', action: '/api/coverage/accept', encType: 'application/json' },
              );
            }}
          >
            <Check size={16} aria-hidden />
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Decline coverage"
            onClick={() => {
              fetcher.submit(
                { assignmentId: assignment.id, csrf: csrfToken },
                { method: 'POST', action: '/api/coverage/decline', encType: 'application/json' },
              );
            }}
          >
            <X size={16} aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

function CreateAbsenceSheet({
  open,
  onOpenChange,
  teachers,
  csrfToken,
  onCreated,
  plan,
  onUpgradeGate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teachers: Array<{ id: string; name: string }>;
  csrfToken: string;
  onCreated: () => void;
  plan: string;
  onUpgradeGate: (reason: UpgradeReason) => void;
}): React.ReactElement {
  const fetcher = useFetcher();
  const [selectedTeacher, setSelectedTeacher] = useState('');
  const [absenceDate, setAbsenceDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  // Phase 3 §3.4 — broadcast toggle. Default OFF. When ON, the submit
  // hits /api/coverage/broadcast (fan-out) instead of
  // /api/coverage/absences (single-target route).
  const [broadcast, setBroadcast] = useState(false);

  const canBroadcast = plan === 'school';

  // Close the sheet when the action succeeds.
  if (fetcher.state === 'idle' && fetcher.data && (fetcher.data as { id?: string }).id) {
    onCreated();
  }

  // Surface 403 plan-gate from a broadcast submit.
  if (
    fetcher.state === 'idle' &&
    fetcher.data &&
    typeof fetcher.data === 'object' &&
    'error' in (fetcher.data as { error?: unknown }) &&
    (fetcher.data as { error: string }).error === 'plan_feature_locked'
  ) {
    onUpgradeGate(fetcher.data as unknown as UpgradeReason);
  }

  const submitting = fetcher.state !== 'idle';
  const canSubmit = Boolean(selectedTeacher && absenceDate) && !submitting;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Record an absence"
      description="The Coverage Router will find replacement teachers for this teacher's duties on the date below."
      detent="medium"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!canSubmit}
            onClick={() => {
              const payload = broadcast
                ? {
                    teacherId: selectedTeacher,
                    absenceDate,
                    reason: reason || undefined,
                    csrf: csrfToken,
                  }
                : {
                    teacherId: selectedTeacher,
                    absenceDate,
                    reason: reason || null,
                    source: 'manual' as CoverageSource,
                    autoRoute: true,
                    csrf: csrfToken,
                  };
              fetcher.submit(JSON.stringify(payload), {
                method: 'POST',
                action: broadcast ? '/api/coverage/broadcast' : '/api/coverage/absences',
                encType: 'application/json',
              });
            }}
          >
            {submitting
              ? broadcast ? 'Broadcasting…' : 'Routing…'
              : broadcast ? 'Broadcast to all' : 'Route coverage'}
          </Button>
        </>
      }
    >
      <div className="space-y-md">
        <label className="block">
          <span className="text-subhead text-secondary font-semibold mb-xs block">
            Teacher
          </span>
          <select
            value={selectedTeacher}
            onChange={(e) => setSelectedTeacher(e.target.value)}
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
          >
            <option value="" disabled>Select a teacher…</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-subhead text-secondary font-semibold mb-xs block">
            Date
          </span>
          <input
            type="date"
            value={absenceDate}
            onChange={(e) => setAbsenceDate(e.target.value)}
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast tabular"
          />
        </label>
        <label className="block">
          <span className="text-subhead text-secondary font-semibold mb-xs block">
            Reason <span className="text-tertiary font-normal">(optional)</span>
          </span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. sick, personal day"
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
          />
        </label>
        <div className="rounded-md border border-divider bg-surface-2 px-md py-sm">
          <label className="flex items-start gap-sm cursor-pointer">
            <input
              type="checkbox"
              checked={broadcast}
              onChange={(e) => setBroadcast(e.target.checked)}
              disabled={!canBroadcast}
              className="w-4 h-4 mt-1 rounded border-border text-accent focus:ring-accent disabled:opacity-50"
            />
            <span className="flex-1">
              <span className="inline-flex items-center gap-1 text-subhead font-semibold">
                <Megaphone size={14} aria-hidden />
                Broadcast to all eligible teachers
              </span>
              <span className="block text-footnote text-secondary mt-xs">
                {canBroadcast
                  ? 'Send the coverage request to every teacher who can take the slot. First to accept wins.'
                  : 'Available on the School plan. Upgrade to enable school-wide broadcasts.'}
              </span>
            </span>
          </label>
        </div>
        {fetcher.data && (fetcher.data as { error?: string }).error && (fetcher.data as { error: string }).error !== 'plan_feature_locked' && (
          <Banner
            variant="error"
            message={(fetcher.data as { error: string }).error}
          />
        )}
      </div>
    </Sheet>
  );
}

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = (h ?? 0) >= 12 ? 'PM' : 'AM';
  const h12 = (h ?? 0) % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Logger is used to keep `tsc` happy with unused-imports and to attach
// structured fields when the broadcast flow logs.
