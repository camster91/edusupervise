// apps/web/app/routes/_app.duties._index.tsx — Duty list (Phase 2A refactor)
//
// Design system: surface cards, semantic tokens, HIG button variants.

import { useLoaderData, Link } from 'react-router';
import { Plus } from 'lucide-react';
import type { Route } from './+types/_app.duties._index';
import { getSession, requireSession } from '../../server/auth.server.ts';
import { withSchoolId } from '../../server/db.server.ts';
import { duties } from '@edusupervise/db';
import { eq } from 'drizzle-orm';
import { Button, EmptyState } from '../components/ui';

export function meta() {
  return [{ title: 'Roster — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  const rows = await withSchoolId(session.schoolId, (tx) =>
    tx
      .select({
        id: duties.id,
        cycleDay: duties.cycleDay,
        startTime: duties.startTime,
        endTime: duties.endTime,
        location: duties.location,
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
    <div className="max-w-3xl mx-auto space-y-xl">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-title-1 text-primary font-bold">Roster</h1>
          <p className="text-callout text-secondary mt-xs">
            {rows.length} {rows.length === 1 ? 'duty' : 'duties'} across {Object.keys(byDay).length} cycle {Object.keys(byDay).length === 1 ? 'day' : 'days'}
          </p>
        </div>
        {role === 'school_admin' && (
          <Button
            variant="primary"
            size="md"
            onClick={() => { window.location.href = '/app/duties/new'; }}
          >
            <Plus size={18} aria-hidden />
            New duty
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="bg-surface rounded-xl border border-border">
          <EmptyState
            icon={<Plus size={48} aria-hidden />}
            title="No duties yet"
            description="Add the first duty slot — cafeteria, recess, bus, dismissal, or any supervision assignment."
            action={role === 'school_admin'
              ? { label: 'Create the first duty', href: '/app/duties/new' }
              : { label: 'Browse swap board', href: '/app/coverage' }
            }
          />
        </div>
      ) : (
        Object.entries(byDay).map(([day, list]) => (
          <section
            key={day}
            className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden"
          >
            <header className="bg-surface-2 px-xl py-md border-b border-divider">
              <h2 className="text-callout text-secondary font-semibold">
                Day {day}
                <span className="text-tertiary font-normal ml-sm">
                  · {list.length} {list.length === 1 ? 'duty' : 'duties'}
                </span>
              </h2>
            </header>
            <ul role="list" className="divide-y divide-divider">
              {list.map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/app/duties/${d.id}`}
                    className="flex items-center gap-md px-xl py-md hover:bg-surface-2 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                  >
                    <div className="text-callout text-secondary font-medium tabular w-28 shrink-0">
                      {d.startTime} – {d.endTime}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-body text-primary font-semibold">
                        {d.location}
                      </div>
                      <div className="text-footnote text-secondary mt-xs">
                        {d.duration ?? '—'} min
                        {d.requiresVest ? ' · vest' : ''}
                        {d.requiresRadio ? ' · radio' : ''}
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
