// apps/web/app/routes/_app.tsx — authenticated layout shell (Apple HIG).
//
// Design system section 3.2:
//   - iPad / desktop: Sidebar (left rail) + main column with Topbar
//   - iPhone: no sidebar; main column with Topbar + TabBar (bottom)
//   - School theme is applied via the per-school `--color-accent`
//     override on a ThemeStyle wrapper.

import { Outlet, useLoaderData } from 'react-router';
import { eq, and } from 'drizzle-orm';
import { schools, notifications } from '@edusupervise/db';
import type { Route } from './+types/_app';
import { getSession } from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { Sidebar, Topbar, TabBar } from '../components/shell';
import { ThemeStyle } from '../components/ThemeStyle';

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw new Response(null, {
      status: 302,
      headers: { Location: '/login?next=' + encodeURIComponent(new URL(request.url).pathname) },
    });
  }
  // RLS-bound reads — must run inside withSchoolId so `app.school_id`
  // is set; otherwise the runtime role's FORCE RLS policy returns zero
  // rows for every tenant table.
  return withSchoolId(session.schoolId, async (tx) => {
    const [school] = await tx
      .select({
        id: schools.id,
        name: schools.name,
        accentColor: schools.accentColor,
        plan: schools.plan,
      })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);

    let unreadCount = 0;
    try {
      const rows = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.userId, session.userId))
        .limit(1_000);
      unreadCount = rows.length;
    } catch {
      unreadCount = 0;
    }

    return {
      school: school ?? null,
      user: {
        id: session.userId,
        name: session.name,
        email: session.email,
        role: session.role,
      },
      unreadCount,
    };
  });
}

export default function AppShell(): React.ReactElement {
  const { school, user, unreadCount } = useLoaderData<typeof loader>();
  return (
    <ThemeStyle accent={school?.accentColor ?? '#3b82f6'}>
      <div className="min-h-screen bg-bg flex">
        <Sidebar role={user.role} />
        <main className="flex-1 min-w-0 flex flex-col">
          <Topbar school={school} user={user} unreadCount={unreadCount} />
          <div className="flex-1 px-md md:px-xl py-xl">
            <Outlet />
          </div>
          <TabBar />
        </main>
      </div>
    </ThemeStyle>
  );
}
