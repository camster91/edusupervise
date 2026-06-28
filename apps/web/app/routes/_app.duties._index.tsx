// apps/web/app/routes/_app.duties._index.tsx — Duty list
import { useLoaderData, Link } from 'react-router';
import type { Route } from './+types/_app.duties._index';
import { getSession, requireSession } from '../server/auth.server';
import { withSchoolContext } from '../server/db.server';
import { duties } from '@edusupervise/db';
import { and, eq, desc } from 'drizzle-orm';

export function meta() {
  return [{ title: 'Duties — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  const rows = await withSchoolContext(session.schoolId, (tx) =>
    tx
      .select({
        id: duties.id,
        cycleDay: duties.cycleDay,
        startTime: duties.startTime,
        endTime: duties.endTime,
        location: duties.location,
        duration: duties.duration,
        isActive: duties.isActive,
        requiresVest: duties.requiresVest,
        requiresRadio: duties.requiresRadio,
      })
      .from(duties)
      .where(eq(duties.isActive, true))
      .orderBy(duties.cycleDay, duties.startTime),
  );
  return { rows, role: session.role };
}

export default function DutiesList() {
  const { rows, role } = useLoaderData<typeof loader>();
  const byDay = rows.reduce<Record<number, typeof rows>>((acc, d) => {
    (acc[d.cycleDay] ??= []).push(d);
    return acc;
  }, {});
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Duties</h2>
        {role === 'school_admin' && (
          <Link to="/app/duties/new" className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg">
            + New duty
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-500">
          No duties yet. {role === 'school_admin' && <Link to="/app/duties/new" className="text-blue-600 hover:underline">Create the first one</Link>}.
        </div>
      ) : (
        Object.entries(byDay).map(([day, list]) => (
          <section key={day} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="bg-slate-50 px-5 py-3 border-b border-slate-200 text-sm font-medium text-slate-700">
              Day {day} · {list.length} {list.length === 1 ? 'duty' : 'duties'}
            </div>
            <ul className="divide-y divide-slate-200">
              {list.map((d) => (
                <li key={d.id}>
                  <Link to={`/app/duties/${d.id}`} className="block px-5 py-4 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="text-xs font-mono text-slate-500 w-24">{d.startTime} – {d.endTime}</div>
                      <div className="flex-1">
                        <div className="font-medium text-slate-900">{d.location}</div>
                        <div className="text-xs text-slate-500">
                          {d.duration ?? '—'} min
                          {d.requiresVest ? ' · vest' : ''}
                          {d.requiresRadio ? ' · radio' : ''}
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}