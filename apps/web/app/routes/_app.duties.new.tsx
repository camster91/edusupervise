// apps/web/app/routes/_app.duties.new.tsx — Create duty (admin only)
import { Form, redirect, useActionData } from 'react-router';
import type { Route } from './+types/_app.duties.new';
import { getSession, requireRole, requireSession } from '../../server/auth.server.ts';
import { withSchoolContext } from '../../server/db.server.ts';
import { duties } from '@edusupervise/db';

export function meta() {
  return [{ title: 'New duty — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const form = await request.formData();
  const cycleDay = Number(form.get('cycleDay'));
  const startTime = String(form.get('startTime') ?? '');
  const endTime = String(form.get('endTime') ?? '');
  const location = String(form.get('location') ?? '').trim();
  const duration = Number(form.get('duration'));
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
  if (!Number.isFinite(duration) || duration <= 0) {
    return Response.json({ error: 'duration_invalid' }, { status: 400 });
  }
  const [duty] = await withSchoolContext(session.schoolId, (tx) =>
    tx.insert(duties).values({
      cycleDay,
      startTime,
      endTime,
      location,
      duration,
      requiresVest,
      requiresRadio,
      createdBy: session.userId,
    }).returning(),
  );
  return redirect(`/app/duties/${duty.id}`);
}

export default function NewDuty() {
  const data = useActionData() as { error?: string } | undefined;
  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold text-slate-900 mb-6">New duty</h2>
      <Form method="post" className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Cycle day</span>
            <select name="cycleDay" required className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => <option key={d} value={d}>Day {d}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Duration (minutes)</span>
            <input type="number" name="duration" min="5" max="240" defaultValue={20} required className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg" />
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
          <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg">Create duty</button>
          <a href="/app/duties" className="bg-white border border-slate-300 text-slate-700 font-medium px-4 py-2 rounded-lg hover:bg-slate-50">Cancel</a>
        </div>
      </Form>
    </div>
  );
}