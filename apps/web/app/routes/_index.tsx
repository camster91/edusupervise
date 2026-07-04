// apps/web/app/routes/_index.tsx — public landing
//
// Phase 0 (2026-07-04): lead with the solo-teacher path. School
// admins who land here should still have an obvious entry point,
// but the loudest CTA is "Start solo" because:
//
//   - Jason's feedback (Toronto teacher): "start with Teacher lead
//     personal scheduler and expand from there"
//   - Solo signup has a much shorter time-to-value (1 teacher, 1
//     school, no admin setup) than the school-wide trial
//   - Once a solo teacher is hooked, they bring their principal to
//     /signup/join (the admin path becomes the upsell)
//
// The "Whole school" link at the bottom is the quiet path for admins
// who know they want the multi-tenant experience.
import { redirect } from 'react-router';
import type { Route } from './+types/_index';
import { getSession } from '../../server/auth.server.ts';

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) throw redirect('/app');
  return null;
}

export default function LandingPage() {
  return (
    <main id="main" className="min-h-screen bg-bg grid place-items-center px-md">
      <div className="max-w-2xl text-center">
        <h1 className="text-display md:text-[44px] font-bold text-primary tracking-tight">
          Your supervision schedule, on autopilot.
        </h1>
        <p className="mt-md text-callout text-secondary">
          Set up your personal 5-day duty cycle in two minutes. We send the
          reminders — you show up and supervise.
        </p>
        <div className="mt-xl flex items-center justify-center gap-sm">
          <a
            href="/signup?mode=solo"
            className="inline-flex items-center justify-center min-h-[var(--touch-target-min)] px-xl rounded-md font-semibold bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            Start solo — free
          </a>
          <a
            href="/login"
            className="inline-flex items-center justify-center min-h-[var(--touch-target-min)] px-xl rounded-md font-semibold bg-surface border border-border text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            Sign in
          </a>
        </div>
        <p className="mt-lg text-callout text-secondary">
          Running this for your whole school?{' '}
          <a href="/signup?mode=join" className="text-accent hover:underline font-semibold">
            Set up your school →
          </a>
        </p>
      </div>
    </main>
  );
}