// apps/web/app/routes/_app.tsx — authenticated layout shell.
//
// What this route owns:
//   - Auth gate: redirect to /login if no session.
//   - Loads the school + user context used by every child route.
//   - Renders Sidebar (desktop nav) + Topbar (school name, user menu,
//     notification bell, logout) + the main content area for the
//     matched child route (`<Outlet />`).
//   - Re-applies the school's `--accent` CSS variable on every render
//     so theme survives navigation.
//
// Notes for the implementation:
//   - We do NOT import Sidebar/Topbar/MobileNav here directly — those
//     components live in `components/shell/*` and the route file
//     imports them. Keeps this file focused on data + composition.
//   - The loader runs on every navigation; it's lightweight because
//     `getSession()` reuses the cached session from the auth.server
//     module.

import { Outlet, useLoaderData } from 'react-router';
import { eq } from 'drizzle-orm';
import { schools, notifications } from '@edusupervise/db';
import type { Route } from './+types/_app';
import { getSession } from '../../server/auth.server';
import { getDb } from '../../server/db.server';
import { Sidebar, Topbar } from '../components/shell';
import { ThemeStyle } from '../components/ThemeStyle';

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    // Use a relative `redirect()` so dev (http://localhost:3011) and
    // production (https://edusupervise.ashbi.ca) both resolve.
    throw new Response(null, {
      status: 302,
      headers: { Location: '/login?next=' + encodeURIComponent(new URL(request.url).pathname) },
    });
  }
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

  // Unread notification count — guarded against missing table data
  // (RLS returns zero for cross-tenant lookups, which is what we want).
  let unreadCount = 0;
  try {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, session.userId))
      .limit(1_000);
    // Cheap client-side filter; the indexed `idx_notifications_user_unread`
    // partial index takes care of the SQL side, we just count what
    // came back.
    unreadCount = rows.length;
  } catch {
    // First boot or missing RLS context — return 0 instead of 500-ing
    // the whole shell.
    unreadCount = 0;
  }

  return {
    school,
    user: {
      id: session.userId,
      name: session.name,
      email: session.email,
      role: session.role,
    },
    unreadCount,
  };
}

export default function AppShell(): React.ReactElement {
  const { school, user, unreadCount } = useLoaderData<typeof loader>();
  return (
    <ThemeStyle accent={school?.accentColor ?? '#3b82f6'}>
      <div className="min-h-screen bg-slate-50 flex">
        <Sidebar role={user.role} />
        <main className="flex-1 min-w-0 flex flex-col">
          <Topbar school={school} user={user} unreadCount={unreadCount} />
          <div className="flex-1 p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </ThemeStyle>
  );
}
