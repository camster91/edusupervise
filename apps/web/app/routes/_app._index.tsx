// apps/web/app/routes/_app._index.tsx — Dashboard
import { useLoaderData, Link } from 'react-router';
import type { Route } from './+types/_app._index';
import { getSession } from '../../server/auth.server.ts';
import { withSchoolContext } from '../../server/db.server.ts';
import { duties, dutyAssignments, users, cycleCalendar } from '@edusupervise/db';
import { and, eq, gte, lte, desc, isNull } from 'drizzle-orm';

export function meta() {
  return [{ title: 'Dashboard — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) throw new Response('Unauthorized', { status: 401 });

  const data = await withSchoolContext(session.schoolId, async (tx) => {
    // Look up the school for cycle info
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const weekAhead = new Date(now.getTime() + 14 * 86_400_000);

    const upcomingDuties = await tx
      .select({
        id: duties.id,
        cycleDay: duties.cycleDay,
        startTime: duties.startTime,
        endTime: duties.endTime,
        location: duties.location,
        duration: duties.duration,
        requiresVest: duties.requiresVest,
        requiresRadio: duties.requiresRadio,
      })
      .from(duties)
      .where(and(eq(duties.isActive, true)))
      .limit(50);

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
      .limit(50);

    const today = now.toISOString().slice(0, 10);
    const [cycle] = await tx
      .select({ cycleDay: cycleCalendar.cycleDay, isSchoolDay: cycleCalendar.isSchoolDay })
      .from(cycleCalendar)
      .where(eq(cycleCalendar.date, today))
      .limit(1);

    return { upcomingDuties, myAssignments, cycleDay: cycle?.cycleDay ?? null, today };
  });

  return data;
}

export default function Dashboard() {
  const { upcomingDuties, myAssignments, cycleDay, today } = useLoaderData<typeof loader>();
  const assignedDutyIds = new Set(myAssignments.map((a) => a.dutyId));
  const myUpcoming = upcomingDuties.filter((d) => assignedDutyIds.has(d.id));
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Today's overview</h2>
        <p className="text-sm text-slate-500">{formatLongDate(today)}{cycleDay ? ` · Day ${cycleDay}` : ' · No school'}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Total duties" value={upcomingDuties.length} icon="◷" />
        <StatCard label="Hours total" value={(upcomingDuties.reduce((s, d) => s + (d.duration ?? 0), 0) / 60).toFixed(1)} icon="⌛" />
        <StatCard label="Locations" value={new Set(upcomingDuties.map((d) => d.location)).size} icon="◉" />
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-lg font-semibold text-slate-900">Your duties</h3>
          <Link to="/app/duties" className="text-sm text-blue-600 hover:underline">View all →</Link>
        </div>
        {myUpcoming.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-slate-500">
            You don't have any duties assigned yet.{' '}
            {myAssignments.length === 0 && <Link to="/app/assignments" className="text-blue-600 hover:underline">Browse assignments</Link>}
          </div>
        ) : (
          <ul className="space-y-2">
            {myUpcoming.map((d) => (
              <li key={d.id} className="bg-white border border-slate-200 rounded-xl p-4 flex items-center gap-4">
                <div className="text-xs font-mono text-slate-500 w-16">{d.startTime}</div>
                <div className="flex-1">
                  <div className="font-medium text-slate-900">{d.location}</div>
                  <div className="text-xs text-slate-500">Day {d.cycleDay} · {d.duration ?? '—'} min{d.requiresVest ? ' · vest' : ''}{d.requiresRadio ? ' · radio' : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string | number; icon: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-slate-500">{label}</div>
          <div className="text-3xl font-bold text-slate-900 mt-1">{value}</div>
        </div>
        <div className="text-2xl text-slate-300" aria-hidden>{icon}</div>
      </div>
    </div>
  );
}

function formatLongDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}