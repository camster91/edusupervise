// apps/web/app/routes/_app.calendar._index.tsx — Calendar (Phase 2A refactor)
//
// Design system section 3.3 (week view): calendar grid with duties as
// color-coded blocks. The full month grid is a follow-up; for now we
// show the W1-W6 cycle strip + a placeholder for the grid.

import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.calendar._index';
import { getSession, requireSession } from '../../server/auth.server';
import { withSchool } from '../../server/db.server';
import { duties, cycleCalendar } from '@edusupervise/db';
import { and, eq, gte, lte } from 'drizzle-orm';
import { WeekStrip, EmptyState } from '../components/ui';
import { CalendarDays } from 'lucide-react';

export function meta() {
  return [{ title: 'Calendar — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  const today = new Date().toISOString().slice(0, 10);

  // Pull active duties + the next 6 days of cycle data
  const { activeDuties, upcomingCycle } = await withSchool(session.schoolId, async (tx) => {
    const activeDuties = await tx
      .select({ id: duties.id, cycleDay: duties.cycleDay })
      .from(duties)
      .where(eq(duties.isActive, true))
      .limit(200);
    const weekFromNow = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const upcomingCycle = await tx
      .select({ date: cycleCalendar.date, cycleDay: cycleCalendar.cycleDay })
      .from(cycleCalendar)
      .where(and(
        gte(cycleCalendar.date, today),
        lte(cycleCalendar.date, weekFromNow),
      ))
      .limit(10);
    return { activeDuties, upcomingCycle };
  });

  return { today, activeDuties, upcomingCycle };
}

export default function CalendarPage() {
  const { today, upcomingCycle } = useLoaderData<typeof loader>();
  const todayDate = new Date(today + 'T00:00:00');
  const weekDays = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(todayDate.getTime() + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    const cycle = upcomingCycle.find((c) => c.date === iso);
    return {
      index: i,
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
      day: d.getDate(),
      isToday: i === 0,
      hasDuties: !!cycle && cycle.cycleDay !== null,
      inCycle: !!cycle,
    };
  });

  return (
    <div className="max-w-4xl mx-auto space-y-xl">
      <div>
        <h1 className="text-title-1 text-primary font-bold">Calendar</h1>
        <p className="text-callout text-secondary mt-xs">
          {new Date(today + 'T00:00:00').toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </p>
      </div>

      <WeekStrip days={weekDays} cycleLabel="Cycle week" />

      <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
        <EmptyState
          icon={<CalendarDays size={48} aria-hidden />}
          title="Month grid coming soon"
          description="The full month grid view is in the next sprint. For now, see the per-cycle-day duty list under Roster."
          action={{ label: 'Go to Roster', href: '/app/duties' }}
        />
      </div>
    </div>
  );
}
