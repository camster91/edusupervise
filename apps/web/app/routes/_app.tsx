// apps/web/app/routes/_app.tsx — authenticated layout
//
// Sidebar + topbar shell. Loader requires a session and reads the current
// school for branding.

import { Link, NavLink, Outlet, useLoaderData } from 'react-router';
import type { Route } from './+types/_app';
import { getSession } from '../server/auth.server';
import { eq } from 'drizzle-orm';
import { schools } from '@edusupervise/db';
import { getDb } from '../server/db.server';
import { redirect } from 'react-router';

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) throw redirect('/login');
  const db = getDb();
  const [school] = await db
    .select({
      id: schools.id,
      name: schools.name,
      accentColor: schools.accentColor,
      plan: schools.plan,
    })
    .from(schools)
    .where(eq(schools.id, session.schoolId))
    .limit(1);
  return { session, school };
}

export default function AppShell() {
  const { session, school } = useLoaderData<typeof loader>();
  const accent = school?.accentColor ?? '#3b82f6';
  return (
    <div className="min-h-screen bg-slate-50 flex" style={{ ['--accent' as string]: accent }}>
      <aside className="w-60 bg-white border-r border-slate-200 hidden md:flex md:flex-col">
        <div className="px-5 py-5 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold" style={{ backgroundColor: accent }}>
              E
            </div>
            <div>
              <div className="font-semibold text-slate-900 text-sm leading-tight">EduSupervise</div>
              <div className="text-xs text-slate-500 leading-tight">{school?.name ?? 'School'}</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <SidebarLink to="/app" icon="▦" label="Dashboard" end />
          <SidebarLink to="/app/duties" icon="◷" label="Duties" />
          <SidebarLink to="/app/calendar" icon="▤" label="Calendar" />
          <SidebarLink to="/app/assignments" icon="↔" label="Assignments" />
          <SidebarLink to="/app/reminders" icon="✉" label="Reminders" />
          {session.role === 'school_admin' && (
            <>
              <SidebarLink to="/app/teachers" icon="☻" label="Teachers" />
              <SidebarLink to="/app/settings" icon="⚙" label="Settings" />
            </>
          )}
        </nav>
        <div className="p-3 border-t border-slate-200">
          <div className="flex items-center gap-2 px-2 py-1">
            <div className="w-7 h-7 rounded-full bg-slate-200 grid place-items-center text-xs font-medium text-slate-700">
              {initials(session.name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-900 truncate">{session.name}</div>
              <div className="text-xs text-slate-500 truncate">{session.role}</div>
            </div>
            <Link to="/logout" className="text-xs text-slate-500 hover:text-slate-700" title="Sign out">
              ⏻
            </Link>
          </div>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-900">{school?.name ?? 'EduSupervise'}</h1>
          <div className="text-xs text-slate-500 uppercase tracking-wide">{school?.plan ?? 'trial'} plan</div>
        </header>
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function SidebarLink({ to, icon, label, end }: { to: string; icon: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-100'
        }`
      }
    >
      <span className="text-base w-4 text-center" aria-hidden>{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}