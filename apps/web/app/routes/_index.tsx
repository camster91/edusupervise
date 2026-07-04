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
    <main className="min-h-screen bg-slate-50 grid place-items-center px-4">
      <div className="max-w-2xl text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-slate-900 tracking-tight">
          Your supervision schedule, on autopilot.
        </h1>
        <p className="mt-4 text-lg text-slate-600">
          Set up your personal 5-day duty cycle in two minutes. We send the
          reminders — you show up and supervise.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a href="/signup?mode=solo" className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-3 rounded-lg">
            Start solo — free
          </a>
          <a href="/login" className="bg-white border border-slate-300 text-slate-700 font-medium px-6 py-3 rounded-lg hover:bg-slate-100">
            Sign in
          </a>
        </div>
        <p className="mt-6 text-sm text-slate-500">
          Running this for your whole school?{' '}
          <a href="/signup?mode=join" className="text-blue-600 hover:underline font-medium">
            Set up your school →
          </a>
        </p>
      </div>
    </main>
  );
}