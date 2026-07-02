// apps/web/app/routes/_app.tsx — authenticated layout shell (Apple HIG).
//
// Design system section 3.2:
//   - iPad / desktop: Sidebar (left rail) + main column with Topbar
//   - iPhone: no sidebar; main column with Topbar + TabBar (bottom)
//   - School theme is applied via the per-school `--color-accent`
//     override on a ThemeStyle wrapper.
//
// Demo mode (migration 0006):
//   - When `schools.plan='demo'`, render <DemoBanner /> above the shell
//     so users always see "X days left" + a "Reset demo" button.
//   - When `schools.plan='demo_expired'`, render <ExpiredDemo />
//     instead of the Outlet — the school is read-only until reset.

import { Outlet, data, useLoaderData } from 'react-router';
import { eq } from 'drizzle-orm';
import { schools, notifications } from '@edusupervise/db';
import type { Route } from './+types/_app';
import { getSession } from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { ensureCsrfCookie } from '../../server/csrf.server';
import { Sidebar, Topbar, TabBar } from '../components/shell';
import { ThemeStyle } from '../components/ThemeStyle';
import { DemoBanner } from '../components/DemoBanner';
import { ExpiredDemo } from '../components/ExpiredDemo';

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
  const loaderData = await withSchoolId(session.schoolId, async (tx) => {
    const [school] = await tx
      .select({
        id: schools.id,
        name: schools.name,
        accentColor: schools.accentColor,
        plan: schools.plan,
        demoExpiresAt: schools.demoExpiresAt,
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

  // Also expose the CSRF token from the request cookie so child
  // components (DemoBanner, settings forms) can include it in
  // hidden form fields. ensureCsrfCookie reads the existing cookie
  // or mints a fresh one and returns both the token and the
  // Set-Cookie header value. Using RR7's data() wrapper keeps the
  // loader-data shape consistent across visits — the previous
  // pattern returned a plain object when the cookie was present
  // and a Response-with-Set-Cookie when it wasn't, which broke
  // RR7's loader shape inference on every child route and triggered
  // React #418/#425 hydration warnings.
  const { token, setCookie } = ensureCsrfCookie(request);
  const csrfHeaders: HeadersInit | undefined = setCookie
    ? { 'Set-Cookie': setCookie }
    : undefined;
  return data(
    { ...loaderData, csrfToken: token },
    csrfHeaders ? { headers: csrfHeaders } : undefined,
  );
}

export default function AppShell(): React.ReactElement {
  const { school, user, unreadCount, csrfToken } = useLoaderData<typeof loader>();
  const isDemo = school?.plan === 'demo';
  const isExpired = school?.plan === 'demo_expired';

  return (
    <ThemeStyle accent={school?.accentColor ?? '#3b82f6'}>
      <div className="min-h-screen bg-bg flex flex-col">
        {isDemo && school?.demoExpiresAt && (
          <DemoBanner demoExpiresAt={school.demoExpiresAt} csrfToken={csrfToken} />
        )}
        <div className="flex-1 min-h-screen flex">
          <Sidebar role={user.role} />
          <main className="flex-1 min-w-0 flex flex-col">
            <Topbar school={school} user={user} unreadCount={unreadCount} csrfToken={csrfToken} />
            <div className="flex-1 px-md md:px-xl py-xl">
              {isExpired ? <ExpiredDemo /> : <Outlet />}
            </div>
            <TabBar />
          </main>
        </div>
      </div>
    </ThemeStyle>
  );
}