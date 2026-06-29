// apps/web/app/routes/_app.today._index.tsx — per-teacher "Today" view
// (the load-bearing screen for Phase 2B Coverage Router).
//
// Design system section 3.1:
//   - Hero card showing current + next duty (iStudiez-style)
//   - WeekStrip showing W1-W6 cycle
//   - "Today" section with chronological list of today's duties
//   - "Coverage requests" section with badge
//   - Tap a duty → opens a sheet for swap/cover
//   - Empty states for each section (three-job pattern)

import { useState } from 'react';
import { useLoaderData, Link } from 'react-router';
import {
  CalendarDays,
  ClipboardList,
  Bell,
  Plus,
  ArrowRightLeft,
  Check,
  type LucideIcon,
} from 'lucide-react';
import { and, eq, gte, lte, desc, isNull } from 'drizzle-orm';
import { duties, dutyAssignments, cycleCalendar } from '@edusupervise/db';
import type { Route } from './+types/_app.today._index';
import { getSession } from '../../server/auth.server.ts';
import { withSchoolId } from '../../server/db.server.ts';
import { HeroCard, EmptyState, WeekStrip, Sheet, Button } from '../components/ui';

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
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);

    // Active duties (school's full duty catalog)
    const allDuties = await tx
      .select({
        id: duties.id,
        name: duties.location, // duties.location is the display name in this schema
        location: duties.location,
        startTime: duties.startTime,
        endTime: duties.endTime,
        cycleDay: duties.cycleDay,
        requiresVest: duties.requiresVest,
        requiresRadio: duties.requiresRadio,
      })
      .from(duties)
      .where(eq(duties.isActive, true))
      .limit(100);

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
      .limit(100);

    // Cycle info for today
    const [cycle] = await tx
      .select({ cycleDay: cycleCalendar.cycleDay, isSchoolDay: cycleCalendar.isSchoolDay })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, today))
      .limit(1);

    return {
      today,
      tomorrow,
      allDuties,
      myAssignments,
      cycleDay: cycle?.cycleDay ?? null,
      isSchoolDay: cycle?.isSchoolDay ?? true,
    };
  });

  return data;
}

export default function Today() {
  const { allDuties, myAssignments, cycleDay, today, tomorrow, isSchoolDay } = useLoaderData<typeof loader>();
  const [swapOpen, setSwapOpen] = useState(false);
  const [activeDuty, setActiveDuty] = useState<typeof allDuties[number] | null>(null);

  // Filter to my duties
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
              <Button variant="primary" size="md">
                <Check size={16} aria-hidden />
                Mark complete
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Week strip */}
      <WeekStrip
        days={weekDays}
        cycleLabel={cycleDay ? `Day ${cycleDay}` : undefined}
      />

      {/* Today's list */}
      <section>
        <SectionHeader
          icon={CalendarDays}
          title="Today"
          meta={isSchoolDay ? `Day ${cycleDay ?? '—'}` : 'No school'}
        />
        {myDuties.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={48} aria-hidden />}
            title="No duties today"
            description={isSchoolDay
              ? "You don't have any duties assigned for today. If that's unexpected, check with your school's duty coordinator."
              : "No school today. Enjoy the day off."
            }
            action={{ label: 'Browse swap board', href: '/app/coverage' }}
          />
        ) : (
          <ul className="space-y-sm" role="list">
            {myDuties.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-md bg-surface rounded-lg border border-border p-md hover:bg-surface-2 transition-colors duration-fast"
              >
                <div className="text-title-3 text-primary font-semibold tabular w-20 shrink-0">
                  {formatTime12h(d.startTime)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-body-em text-primary font-semibold">
                    {d.name}
                  </div>
                  {d.location && (
                    <div className="text-footnote text-secondary">
                      {d.location}{d.duration ? ` · ${d.duration} min` : ''}
                    </div>
                  )}
                </div>
                <Button
                  variant="tertiary"
                  size="icon-sm"
                  aria-label={`Swap ${d.name}`}
                  onClick={() => { setActiveDuty(d); setSwapOpen(true); }}
                >
                  <ArrowRightLeft size={16} aria-hidden />
                </Button>
              </li>
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
          icon={<Plus size={48} aria-hidden />}
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
