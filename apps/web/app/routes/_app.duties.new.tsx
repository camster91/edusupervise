// apps/web/app/routes/_app.duties.new.tsx — Create duty (admin only)
import { Form, redirect, useActionData, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.duties.new';
import { getSession, requireRole, requireSession } from '../../server/auth.server.ts';
import { readCsrfCookie, validateCsrfWithFormToken } from '../../server/csrf.server.ts';
import { withSchoolId } from '../../server/db.server.ts';
import { duties } from '@edusupervise/db';

export function meta() {
  return [{ title: 'New duty — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  // Hand the cookie value to the form so the <Form> can include a hidden
  // CSRF input that the action's validateCsrfWithFormToken() checks.
  return { csrfToken: readCsrfCookie(request) };
}

export async function action({ request }: Route.ActionArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const form = await request.formData();
  // Validate CSRF BEFORE processing — readFormCsrfToken extracts the
  // hidden `<input name="csrf">` value and compares it (constant-time)
  // against the cookie.
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;
  const cycleDay = Number(form.get('cycleDay'));
  const startTime = String(form.get('startTime') ?? '');
  const endTime = String(form.get('endTime') ?? '');
  const location = String(form.get('location') ?? '').trim();
  // `duration` is captured by the form for UX but the `duties` schema
  // does NOT have a `duration` column (slice-2 RED-5) — duration is
  // computed from start_time / end_time downstream. Drop it from the
  // insert rather than crash at runtime.
  const requiresVest = form.get('requiresVest') === 'on';
  const requiresRadio = form.get('requiresRadio') === 'on';
  if (!Number.isFinite(cycleDay) || cycleDay < 1 || cycleDay > 10) {
    return Response.json({ error: 'cycle_day_invalid' }, { status: 400 });
  }
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return Response.json({ error: 'time_invalid' }, { status: 400 });
  }
  if (endTime <= startTime) {
    return Response.json({ error: 'end_before_start' }, { status: 400 });
  }
  if (!location) {
    return Response.json({ error: 'location_required' }, { status: 400 });
  }
  const [duty] = await withSchoolId(session.schoolId, (tx) =>
    tx.insert(duties).values({
      schoolId: session.schoolId,
      cycleDay,
      startTime,
      endTime,
      location,
      requiresVest,
      requiresRadio,
      createdBy: session.userId,
    }).returning(),
  );
  if (!duty) throw new Response('Failed to create duty', { status: 500 });
  return redirect(`/app/duties/${duty.id}`);
}

export default function NewDuty() {
  const data = useActionData() as { error?: string } | undefined;
  const { csrfToken } = useLoaderData<typeof loader>();
  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold text-slate-900 mb-6">New duty</h2>
      <Form method="post" className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        {/* CSRF double-submit: hidden input echoing the cookie value
            that validateCsrfWithFormToken checks against. */}
        <input type="hidden" name="csrf" value={csrfToken ?? ''} />
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Cycle day</span>
            <select name="cycleDay" required className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => <option key={d} value={d}>Day {d}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Duration (minutes)</span>
            <input type="number" name="durationHint" min="5" max="240" defaultValue={20} className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg" />
            <span className="text-xs text-slate-500 mt-1 block">Computed from start/end; UX hint only.</span>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Start time</span>
            <input type="time" name="startTime" required className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">End time</span>
            <input type="time" name="endTime" required className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg" />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Location</span>
          <input type="text" name="location" required placeholder="Main Entrance" className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg" />
        </label>
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="requiresVest" className="rounded" /> Requires vest
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="requiresRadio" className="rounded" /> Requires radio
          </label>
        </div>
        {data?.error && <p className="text-sm text-red-600">{data.error}</p>}
        <div className="flex gap-2">
          <button type="submit" className="bg-accent hover:bg-accent-hover text-on-accent font-medium px-4 py-2 rounded-lg">Create duty</button>
          <a href="/app/duties" className="bg-white border border-slate-300 text-slate-700 font-medium px-4 py-2 rounded-lg hover:bg-slate-50">Cancel</a>
        </div>
      </Form>
    </div>
  );
}