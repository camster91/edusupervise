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

import { useEffect, useState } from 'react';
import { Outlet, data, useLoaderData } from 'react-router';
import { and, count, eq, isNull } from 'drizzle-orm';
import { schools, notifications } from '@edusupervise/db';
import type { Route } from './+types/_app';
import { getSession } from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { ensureCsrfCookie } from '../../server/csrf.server';
import { Sidebar, Topbar, TabBar } from '../components/shell';
import { ThemeStyle } from '../components/ThemeStyle';
import { DemoBanner } from '../components/DemoBanner';
import { ExpiredDemo } from '../components/ExpiredDemo';
import { registerWebPush, getCapacitor } from '../lib/push';

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
      const [row] = await tx
        .select({ value: count() })
        .from(notifications)
        .where(and(
          eq(notifications.userId, session.userId),
          isNull(notifications.readAt),
        ));
      unreadCount = row?.value ?? 0;
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

  // Push subscription registration is gated behind a localStorage flag.
  // We do NOT auto-prompt Notification.requestPermission() on first
  // visit — that violates Apple HIG's "Request Permission" guidance
  // (request after the user has done something that the permission
  // enables, not before they have context for why notifications are
  // needed). The Profile → Notifications surface exposes a manual
  // "Enable duty reminders" toggle that calls registerWebPush on
  // explicit user action. Audited 2026-07-09.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (getCapacitor()) return; // iOS app takes the APNs path
    const promptedKey = 'edu.push.prompted';
    if (window.localStorage.getItem(promptedKey) === 'true') return;
    // First-time visitors see no prompt. They discover the toggle
    // in Profile → Notifications (or via an in-app nudge after they
    // configure a duty that benefits from push).
  }, []);

  // Surface a banner if notifications are blocked, so users understand
  // why push isn't reaching them.
  const [pushBlocked, setPushBlocked] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'denied') {
      setPushBlocked(true);
    }
  }, []);

  return (
    <ThemeStyle accent={school?.accentColor ?? '#3b82f6'}>
      <div className="min-h-screen bg-bg flex flex-col">
        {pushBlocked ? (
          <div
            role="status"
            className="bg-surface border-b border-border px-md py-xs text-sm text-secondary"
          >
            Notifications are blocked in your browser. Enable them in
            your browser settings to receive duty reminders.
          </div>
        ) : null}
        {isDemo && school?.demoExpiresAt && (
          <DemoBanner demoExpiresAt={school.demoExpiresAt.toISOString()} csrfToken={csrfToken} />
        )}
        <div className="flex-1 min-h-screen flex">
          <Sidebar role={user.role} />
          <main className="flex-1 min-w-0 flex flex-col">
            <Topbar school={school!} user={user} unreadCount={unreadCount} csrfToken={csrfToken} />
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