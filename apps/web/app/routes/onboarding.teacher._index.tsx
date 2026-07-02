// apps/web/app/routes/onboarding.teacher._index.tsx — Teacher one-screen
// welcome (HIG spec, design system section 3.4).
//
// "Welcome. Your duties this week: 3. Tomorrow at 11:30: Cafeteria. [Get started →]"
// That's it. No wizard. Drop them into Today.

import { Link, redirect, useLoaderData } from 'react-router';
import { ArrowRight, Calendar } from 'lucide-react';
import type { Route } from './+types/onboarding.teacher._index';
import { getSession } from '../../server/auth.server';

export function meta() {
  return [{ title: 'Welcome — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw redirect('/login');
  }
  return {
    name: session.name ?? '',
  };
}

export default function TeacherOnboarding() {
  const { name } = useLoaderData<typeof loader>();
  const firstName = (name || '').split(' ')[0] || 'teacher';
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-md">
      <div className="max-w-md w-full bg-surface rounded-xl border border-border shadow-elev-1 p-2xl text-center">
        <div
          aria-hidden
          className="mx-auto w-16 h-16 rounded-full bg-accent-soft grid place-items-center mb-xl"
        >
          <Calendar size={32} className="text-accent" aria-hidden />
        </div>
        <h1 className="text-title-1 text-primary font-bold">
          Welcome, {firstName}.
        </h1>
        <p className="text-callout text-secondary mt-md">
          Your duties this week: 3
        </p>
        <p className="text-body text-primary mt-md font-semibold">
          Tomorrow at 11:30 — Cafeteria
        </p>
        <Link
          to="/app/today"
          className="inline-flex items-center justify-center gap-sm h-btn-md px-xl mt-2xl rounded-md font-medium bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast"
        >
          Get started
          <ArrowRight size={18} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
