// apps/web/app/routes/_index.tsx — public landing
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
          Supervision duties, scheduled.
        </h1>
        <p className="mt-4 text-lg text-slate-600">
          EduSupervise lets school admins schedule teacher supervision duties on a recurring cycle and reminds staff automatically by email and SMS.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a href="/signup" className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-3 rounded-lg">Start free trial</a>
          <a href="/login" className="bg-white border border-slate-300 text-slate-700 font-medium px-6 py-3 rounded-lg hover:bg-slate-100">Sign in</a>
        </div>
      </div>
    </main>
  );
}