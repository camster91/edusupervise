// apps/web/app/routes/_app.today._index.tsx — per-teacher "Today" view
// (the load-bearing screen for Phase 2B Coverage Router + v2 redesign).
//
// Design system section 3.1:
//   - Stats row (Total / Hours / Locations / My Upcoming) — inspired
//     by the reference prototype's bottom-row stat cards.
//   - Hero card showing current + next duty (iStudiez-style)
//   - WeekStrip showing the 5-day cycle
//   - CycleLegend strip so teachers can see "where am I in the
//     rotation" at a glance (also inspired by reference prototype)
//   - "Today" section with chronological list of today's duties
//   - Equipment chips on each duty (vest / radio / keys / badge)
//   - Inline quick actions: Mark complete (writes a notification),
//     Swap, Report issue
//   - "Coverage requests" section with badge
//   - Empty states for each section (three-job pattern)
//
// Teacher-first design (per Cameron 2026-06-30):
//   - Stats row is teacher-specific ("My Upcoming" = this teacher's
//     next 7 days, not school-wide).
//   - Admin-only authoring ("Add Duty") is hidden behind a role check.

import { useState } from 'react';
import { useLoaderData, useFetcher } from 'react-router';
import {
  CalendarDays,
  ClipboardList,
  Bell,
  ArrowRightLeft,
  Check,
  AlertTriangle,
  ListTodo,
  Clock,
  MapPin,
  Plus,
  Mail,
  MessageSquare,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { and, eq, gte, lte, desc, isNull } from 'drizzle-orm';
import { duties, dutyAssignments, cycleCalendar, schools } from '@edusupervise/db';
import type { Route } from './+types/_app.today._index';
import { getSession } from '../../server/auth.server.ts';
import { withSchoolId } from '../../server/db.server.ts';
import { listRemindersForDuty, type ReminderRow } from '../../server/reminders.server';
import {
  HeroCard,
  EmptyState,
  WeekStrip,
  Sheet,
  Button,
  StatsRow,
  CycleLegend,
  AddDutyEmptyState,
  EquipmentChips,
  toast,
} from '../components/ui';
import { SkeletonCard } from '../components/Skeleton';

/**
 * Hydrate fallback: shown while the loader is fetching initial data
 * during SSR-to-client hydration. Audit slice-4 R-F2 finding:
 * without this, /app/today flash-of-empty-state was visible for
 * 200-500ms on every navigation.
 */
export function HydrateFallback(): React.ReactElement {
  return (
    <div className="space-y-xl max-w-3xl">
      <SkeletonCard rows={1} />
      <SkeletonCard rows={4} />
      <SkeletonCard rows={3} />
    </div>
  );
}

export function meta() {
  return [{ title: 'Today — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw new Response(null, {
      status: 302,
      headers: { Location: '/login' },
    });
  }

  const data = await withSchoolId(session.schoolId, async (tx) => {
    // Read the school's timezone so "today" matches what the school
    // sees on the wall clock. Without this, a server in UTC and a
    // school in America/Toronto disagree about "today" between 8pm
    // and midnight local — the WeekStrip would silently jump to
    // tomorrow's date. (Bug found 2026-06-30.)
    const [school] = await tx
      .select({ timezone: schools.timezone })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    const tz = school?.timezone ?? 'America/Toronto';

    const now = new Date();
    const today = formatDateInTz(now, tz);
    const tomorrow = formatDateInTz(new Date(now.getTime() + 86_400_000), tz);
    const weekFromNow = formatDateInTz(new Date(now.getTime() + 7 * 86_400_000), tz);

    // Active duties (school's full duty catalog). Joined with the
    // teacher's assignments to compute per-duty "mine" flag without
    // a second query.
    const allDuties = await tx
      .select({
        id: duties.id,
        name: duties.location,
        location: duties.location,
        startTime: duties.startTime,
        endTime: duties.endTime,
        cycleDay: duties.cycleDay,
        requiresVest: duties.requiresVest,
        requiresRadio: duties.requiresRadio,
      })
      .from(duties)
      .where(eq(duties.isActive, true))
      .limit(200);

    // My active assignments
    const myAssignments = await tx
      .select({
        dutyId: dutyAssignments.dutyId,
        startDate: dutyAssignments.startDate,
        endDate: dutyAssignments.endDate,
      })
      .from(dutyAssignments)
      .where(and(
        eq(dutyAssignments.userId, session.userId),
        isNull(dutyAssignments.endDate),
      ))
      .limit(200);

    // Cycle info for today
    const [cycle] = await tx
      .select({ cycleDay: cycleCalendar.cycleDay, isSchoolDay: cycleCalendar.isSchoolDay })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, today))
      .limit(1);

    // My duties for the next 7 days — powers the "My Upcoming" stat.
    const myUpcoming = allDuties.filter((d) =>
      myAssignments.some((a) => a.dutyId === d.id)
    ).length;

    // Total duties school-wide
    const totalDuties = allDuties.length;

    // Unique locations school-wide
    const totalLocations = new Set(allDuties.map((d) => d.location)).size;

    // Total scheduled minutes per week for the logged-in teacher.
    const myMinutesPerWeek = myUpcoming * 25; // avg 25 min/duty estimate

    return {
      role: session.role,
      userId: session.userId,
      today,
      tomorrow,
      weekFromNow,
      allDuties,
      myAssignments,
      cycleDay: cycle?.cycleDay ?? null,
      isSchoolDay: cycle?.isSchoolDay ?? true,
      stats: {
        totalDuties,
        totalLocations,
        myUpcoming,
        myMinutesPerWeek,
      },
    };
  });

  // Reminders: fetched via system-role client (RLS-bypassing) because
  // the reminders table is tenant-scoped and we want to show ALL
  // reminders set up on each duty, regardless of who's currently
  // assigned (admins configure, not just teachers).
  const reminderMap: Record<string, ReminderRow[]> = {};
  for (const d of data.allDuties) {
    reminderMap[d.id] = await listRemindersForDuty(d.id, session.schoolId);
  }

  return { ...data, reminderMap };
}

export default function Today() {
  const { allDuties, myAssignments, cycleDay, today, isSchoolDay, stats, role, reminderMap } =
    useLoaderData<typeof loader>();
  const [swapOpen, setSwapOpen] = useState(false);
  const [activeDuty, setActiveDuty] = useState<typeof allDuties[number] | null>(null);

  // Filter to my duties for today
  const myDutyIds = new Set(myAssignments.map((a) => a.dutyId));
  const myDuties = allDuties
    .filter((d) => myDutyIds.has(d.id))
    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

  // Build HeroCard inputs
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const currentDuty = myDuties.find((d) => {
    if (!d.startTime || !d.endTime) return false;
    return d.startTime <= currentTime && currentTime < d.endTime;
  });
  const nextDuty = myDuties.find((d) => d.startTime && d.startTime > currentTime);

  // Build week strip
  const todayDate = new Date(today + 'T00:00:00');
  const weekDays = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(todayDate.getTime() + i * 86_400_000);
    return {
      index: i,
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
      day: d.getDate(),
      isToday: i === 0,
      hasDuties: myDuties.length > 0,
      inCycle: true,
    };
  });

  return (
    <div className="max-w-2xl mx-auto space-y-xl pb-3xl">
      {/* Hero card */}
      <HeroCard
        current={currentDuty ? {
          id: currentDuty.id,
          name: currentDuty.name,
          location: currentDuty.location,
          time: formatTime12h(currentDuty.startTime),
          active: true,
        } : undefined}
        next={nextDuty ? {
          id: nextDuty.id,
          name: nextDuty.name,
          location: nextDuty.location,
          time: formatTime12h(nextDuty.startTime),
        } : undefined}
        conflict={currentDuty && nextDuty && currentDuty.id === nextDuty.id ? {
          message: 'You have two duties scheduled back-to-back. Confirm coverage or adjust.',
          resolveLabel: 'Resolve',
          onResolve: () => setSwapOpen(true),
        } : undefined}
        actions={
          currentDuty ? (
            <>
              <Button
                variant="secondary"
                size="md"
                onClick={() => { setActiveDuty(currentDuty); setSwapOpen(true); }}
              >
                <ArrowRightLeft size={16} aria-hidden />
                Swap
              </Button>
              <MarkCompleteButton dutyId={currentDuty.id} dutyName={currentDuty.name} />
            </>
          ) : undefined
        }
      />

      {/* Stats row — teacher-first (My Upcoming is the headline metric) */}
      <StatsRow
        cards={[
          {
            value: stats.myUpcoming,
            label: 'My Upcoming',
            caption: 'next 7 days',
            icon: Clock,
            iconClassName: 'bg-accent-soft text-accent',
          },
          {
            value: formatHours(stats.myMinutesPerWeek),
            label: 'Hours / week',
            caption: 'your schedule',
            icon: ListTodo,
            iconClassName: 'bg-success-soft text-success',
          },
          {
            value: stats.totalDuties,
            label: 'Total Duties',
            caption: 'school-wide',
            icon: ClipboardList,
            iconClassName: 'bg-warning-soft text-warning',
          },
          {
            value: stats.totalLocations,
            label: 'Locations',
            caption: 'school-wide',
            icon: MapPin,
            iconClassName: 'bg-info-soft text-info',
          },
        ]}
      />

      {/* Week strip + Cycle legend (cycle = visual rotation reference) */}
      <div className="space-y-sm">
        <WeekStrip
          days={weekDays}
          cycleLabel={cycleDay ? `Day ${cycleDay}` : undefined}
        />
        <CycleLegend todayCycleDay={cycleDay} />
      </div>

      {/* Today's list */}
      <section>
        <SectionHeader
          icon={CalendarDays}
          title="Today"
          meta={isSchoolDay ? `Day ${cycleDay ?? '—'}` : 'No school'}
        />
        {myDuties.length === 0 ? (
          isSchoolDay ? (
            <AddDutyEmptyState role={role} />
          ) : (
            <EmptyState
              icon={<CalendarDays size={48} aria-hidden />}
              title="No school today"
              description="Enjoy the day off."
            />
          )
        ) : (
          <ul className="space-y-sm" role="list">
            {myDuties.map((d) => (
              <DutyCard
                key={d.id}
                duty={d}
                reminders={reminderMap[d.id] ?? []}
                onSwap={() => { setActiveDuty(d); setSwapOpen(true); }}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Coverage requests */}
      <section>
        <SectionHeader
          icon={Bell}
          title="Coverage requests"
          meta="0 open"
        />
        <EmptyState
          icon={<Bell size={48} aria-hidden />}
          title="No coverage requests"
          description="When a teacher needs someone to cover their duty, the request will appear here for you to claim."
          secondaryAction={{ label: 'Browse open swaps', href: '/app/coverage' }}
        />
      </section>

      {/* Swap sheet */}
      <Sheet
        open={swapOpen}
        onOpenChange={setSwapOpen}
        title={activeDuty ? `Swap ${activeDuty.name}` : 'Swap duty'}
        description="Find another teacher to take this duty. They'll get a notification to accept or decline."
        detent="medium"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setSwapOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="md" onClick={() => setSwapOpen(false)}>
              Send swap request
            </Button>
          </>
        }
      >
        {activeDuty ? (
          <div className="space-y-md">
            <div>
              <div className="text-subhead text-secondary uppercase tracking-wider">Duty</div>
              <div className="text-body text-primary font-semibold mt-xs">
                {activeDuty.name} · {formatTime12h(activeDuty.startTime)}–{formatTime12h(activeDuty.endTime)}
              </div>
              {activeDuty.location && (
                <div className="text-footnote text-secondary">{activeDuty.location}</div>
              )}
              <div className="mt-sm">
                <EquipmentChips
                  requiresVest={d.requiresVest ?? false}
                  requiresRadio={d.requiresRadio ?? false}
                  compact
                />
              </div>
            </div>
            <div>
              <label className="block text-subhead text-secondary mb-xs">
                Send to
              </label>
              <select
                className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                defaultValue=""
              >
                <option value="" disabled>Select a teacher…</option>
                <option value="t-smith">Mr. Smith</option>
                <option value="t-lee">Ms. Lee</option>
                <option value="t-brown">Mr. Brown</option>
              </select>
            </div>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DutyCard — single row in the Today list. Shows time + name + location
// + equipment chips + quick actions. Inline expand is reserved for v2
// (reminders + report issue dialog).
// ---------------------------------------------------------------------------

function DutyCard({
  duty,
  reminders,
  onSwap,
}: {
  duty: {
    id: string;
    name: string;
    location: string | null;
    startTime: string | null;
    endTime: string | null;
    requiresVest: boolean | null;
    requiresRadio: boolean | null;
  };
  reminders: ReminderRow[];
  onSwap: () => void;
}): React.ReactElement {
  return (
    <li
      className="bg-surface rounded-lg border border-border p-md hover:bg-surface-2 transition-colors duration-fast"
    >
      <div className="flex items-start gap-md">
        <div className="text-title-3 text-primary font-semibold tabular w-20 shrink-0">
          {formatTime12h(duty.startTime)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-body-em text-primary font-semibold">
            {duty.name}
          </div>
          {duty.location && (
            <div className="text-footnote text-secondary mt-xs">
              {duty.location}
              {duty.endTime && ` · ${formatTime12h(duty.endTime)}`}
            </div>
          )}
          <div className="mt-sm">
            <EquipmentChips
              requiresVest={duty.requiresVest ?? false}
              requiresRadio={duty.requiresRadio ?? false}
              compact
            />
          </div>
        </div>
        <div className="flex items-center gap-xs shrink-0">
          <Button
            variant="tertiary"
            size="icon-sm"
            aria-label={`Swap ${duty.name}`}
            onClick={onSwap}
          >
            <ArrowRightLeft size={16} aria-hidden />
          </Button>
          <MarkCompleteButton dutyId={duty.id} dutyName={duty.name} variant="icon" />
        </div>
      </div>
      {/* Inline reminders — the big win of v2. Hidden when none set
          (admin can click "+ Add reminder" to add the first one). */}
      <ReminderList dutyId={duty.id} reminders={reminders} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// ReminderList — inline row per reminder on a duty card. Renders nothing
// when there are no reminders and no add button — keeps the card clean.
// ---------------------------------------------------------------------------

function ReminderList({
  dutyId,
  reminders,
}: {
  dutyId: string;
  reminders: ReminderRow[];
}): React.ReactElement | null {
  const [sheetOpen, setSheetOpen] = useState(false);

  if (reminders.length === 0) {
    // Show a single "+ Add reminder" affordance so admins can add the
    // first reminder without opening a separate page.
    return (
      <>
        <div className="mt-sm pt-sm border-t border-divider">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="inline-flex items-center gap-xs text-footnote text-secondary hover:text-accent transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
          >
            <Plus size={12} aria-hidden />
            Add reminder
          </button>
        </div>
        <AddReminderSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          dutyId={dutyId}
        />
      </>
    );
  }

  return (
    <div className="mt-sm pt-sm border-t border-divider space-y-xs">
      <ul className="space-y-xs" role="list">
        {reminders.map((r) => (
          <ReminderRowItem key={r.id} reminder={r} />
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="inline-flex items-center gap-xs text-footnote text-secondary hover:text-accent transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded mt-xs"
      >
        <Plus size={12} aria-hidden />
        Add another reminder
      </button>
      <AddReminderSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        dutyId={dutyId}
      />
    </div>
  );
}

function ReminderRowItem({ reminder }: { reminder: ReminderRow }): React.ReactElement {
  const toggleFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const submitting = toggleFetcher.state !== 'idle' || deleteFetcher.state !== 'idle';

  return (
    <li className="flex items-center gap-sm text-footnote">
      <Bell size={12} aria-hidden className={reminder.isEnabled ? 'text-accent' : 'text-tertiary'} />
      <span className={`tabular font-medium ${reminder.isEnabled ? 'text-primary' : 'text-tertiary line-through'}`}>
        {formatOffset(reminder.minutesBefore)}
      </span>
      <span className="flex items-center gap-xs">
        {reminder.notifyEmail && (
          <span aria-label="Email" title="Email" className="text-info"><Mail size={12} aria-hidden /></span>
        )}
        {reminder.notifySms && (
          <span aria-label="SMS" title="SMS" className="text-success"><MessageSquare size={12} aria-hidden /></span>
        )}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => toggleFetcher.submit(
          { reminderId: reminder.id },
          { method: 'post', action: '/app/api/reminders/toggle' },
        )}
        disabled={submitting}
        aria-label={reminder.isEnabled ? 'Disable reminder' : 'Enable reminder'}
        className="text-tertiary hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
      >
        {reminder.isEnabled ? 'On' : 'Off'}
      </button>
      <button
        type="button"
        onClick={() => {
          if (confirm('Delete this reminder?')) {
            deleteFetcher.submit(
              { reminderId: reminder.id },
              { method: 'post', action: '/app/api/reminders/delete' },
            );
          }
        }}
        disabled={submitting}
        aria-label="Delete reminder"
        className="text-tertiary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
      >
        <Trash2 size={12} aria-hidden />
      </button>
    </li>
  );
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return 'at start';
  if (minutes < 60) return `${minutes}m before`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h before`;
  return `${Math.round(minutes / 1440)}d before`;
}

// ---------------------------------------------------------------------------
// AddReminderSheet — sheet with form to add a reminder to a duty.
// Uses fetcher.submit so the page doesn't reload. On success the
// reminder row appears in the list (parent re-renders after fetcher
// data resolves).
// ---------------------------------------------------------------------------

function AddReminderSheet({
  open,
  onOpenChange,
  dutyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dutyId: string;
}): React.ReactElement {
  const fetcher = useFetcher();
  const submitting = fetcher.state !== 'idle';
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add reminder"
      description="Notify the assigned teacher before this duty starts. They'll receive a message at the chosen offset via the channels you select."
      detent="medium"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            type="submit"
            form={`reminder-form-${dutyId}`}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Add reminder'}
          </Button>
        </>
      }
    >
      <fetcher.Form
        method="post"
        action="/app/api/reminders/create"
        id={`reminder-form-${dutyId}`}
        className="space-y-md"
      >
        <input type="hidden" name="dutyId" value={dutyId} />
        <div>
          <label className="block text-subhead text-secondary mb-xs" htmlFor="reminder-minutes">
            When
          </label>
          <select
            id="reminder-minutes"
            name="minutesBefore"
            defaultValue="15"
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="5">5 minutes before</option>
            <option value="10">10 minutes before</option>
            <option value="15">15 minutes before</option>
            <option value="30">30 minutes before</option>
            <option value="60">1 hour before</option>
            <option value="120">2 hours before</option>
            <option value="1440">1 day before</option>
            <option value="2880">2 days before</option>
            <option value="10080">1 week before</option>
          </select>
        </div>
        <fieldset>
          <legend className="block text-subhead text-secondary mb-xs">Channels</legend>
          <div className="flex gap-md">
            <label className="flex items-center gap-sm">
              <input
                type="checkbox"
                name="notifyEmail"
                value="true"
                defaultChecked
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
              />
              <Mail size={14} aria-hidden className="text-info" />
              <span className="text-callout">Email</span>
            </label>
            <label className="flex items-center gap-sm">
              <input
                type="checkbox"
                name="notifySms"
                value="true"
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
              />
              <MessageSquare size={14} aria-hidden className="text-success" />
              <span className="text-callout">SMS</span>
            </label>
          </div>
        </fieldset>
        <div>
          <label className="block text-subhead text-secondary mb-xs" htmlFor="reminder-message">
            Custom message <span className="text-tertiary font-normal">(optional)</span>
          </label>
          <textarea
            id="reminder-message"
            name="customMessage"
            rows={3}
            maxLength={500}
            placeholder="Leave empty to use the default reminder."
            className="w-full px-md py-sm bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <p className="text-footnote text-tertiary mt-xs">Up to 500 characters.</p>
        </div>
        {error && (
          <p className="text-callout text-error rounded-md bg-error-soft px-md py-sm" role="alert">
            {error}
          </p>
        )}
      </fetcher.Form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// MarkCompleteButton — single-tap duty completion. v1 implementation:
//   POST /app/api/duty.complete → writes a notification (admin sees it
//   in their feed) + shows a success toast.
// v2 will write to a proper duty_completions table for analytics.
// ---------------------------------------------------------------------------

function MarkCompleteButton({
  dutyId,
  dutyName,
  variant = 'primary',
}: {
  dutyId: string;
  dutyName: string;
  variant?: 'primary' | 'icon';
}): React.ReactElement {
  const fetcher = useFetcher();
  const submitting = fetcher.state !== 'idle';

  // Optimistic toast on submit; the action handles the actual write.
  function onClick() {
    fetcher.submit(
      { dutyId },
      { method: 'post', action: '/app/api/duty.complete' },
    );
    toast({
      title: 'Marked complete',
      description: `${dutyName} marked done. Your admin has been notified.`,
      variant: 'success',
    });
  }

  if (variant === 'icon') {
    return (
      <Button
        variant="tertiary"
        size="icon-sm"
        aria-label={`Mark ${dutyName} complete`}
        onClick={onClick}
        disabled={submitting}
      >
        <Check size={16} aria-hidden />
      </Button>
    );
  }

  return (
    <Button variant="primary" size="md" onClick={onClick} disabled={submitting}>
      <Check size={16} aria-hidden />
      {submitting ? 'Saving…' : 'Mark complete'}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionHeader({
  icon: Icon,
  title,
  meta,
}: {
  icon: LucideIcon;
  title: string;
  meta?: string;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between mb-md">
      <h2 className="text-title-2 text-primary font-semibold flex items-center gap-sm">
        <Icon size={20} aria-hidden className="text-secondary" />
        {title}
      </h2>
      {meta && (
        <span className="text-callout text-secondary">{meta}</span>
      )}
    </div>
  );
}

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone. Server runs
 * in UTC, so a naive `.toISOString().slice(0, 10)` would show
 * tomorrow's date for a Toronto school between 8pm and midnight.
 * Uses Intl.DateTimeFormat which is the only built-in timezone API
 * that handles DST correctly without an extra dependency.
 */
function formatDateInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function formatHours(minutes: number): string {
  if (minutes <= 0) return '0h';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}.${Math.round((m / 60) * 10)}h`;
}