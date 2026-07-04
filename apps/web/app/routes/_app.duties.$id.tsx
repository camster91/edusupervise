// apps/web/app/routes/_app.duties.$id.tsx — Duty detail
import { useLoaderData, Link, Form, redirect } from 'react-router';
import type { Route } from './+types/_app.duties.$id';
import { getSession, requireSession, requireRole } from '../../server/auth.server.ts';
import {
  ensureCsrfCookie,
  readCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import { withSchoolId } from '../../server/db.server.ts';
import { duties, dutyAssignments, users } from '@edusupervise/db';
import { eq } from 'drizzle-orm';

export function meta() {
  return [{ title: 'Duty — EduSupervise' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  const data = await withSchoolId(session.schoolId, async (tx) => {
    const [duty] = await tx
      .select()
      .from(duties)
      .where(eq(duties.id, params.id))
      .limit(1);
    if (!duty) return null;
    const assignments = await tx
      .select({
        id: dutyAssignments.id,
        userId: dutyAssignments.userId,
        userName: users.name,
        userEmail: users.email,
        startDate: dutyAssignments.startDate,
        endDate: dutyAssignments.endDate,
      })
      .from(dutyAssignments)
      .innerJoin(users, eq(users.id, dutyAssignments.userId))
      .where(eq(dutyAssignments.dutyId, params.id));
    return { duty, assignments };
  });
  if (!data) throw new Response('Not found', { status: 404 });
  const { token: csrfToken } = ensureCsrfCookie(request);
  return { ...data, role: session.role, csrfToken };
}

export async function action({ request, params }: Route.ActionArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;
  const intent = form.get('intent');
  if (intent === 'assign') {
    const userId = String(form.get('userId') ?? '');
    const startDate = String(form.get('startDate') ?? '');
    // zod-validate userId as UUID (slice-1 R-11 mass-assignment gap).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return Response.json({ error: 'user_id_invalid' }, { status: 400 });
    }
    if (!userId || !startDate) return Response.json({ error: 'missing_fields' }, { status: 400 });
    await withSchoolId(session.schoolId, (tx) =>
      tx.insert(dutyAssignments).values({
        schoolId: session.schoolId,
        dutyId: params.id,
        userId,
        startDate,
        createdBy: session.userId,
      }),
    );
    return redirect(`/app/duties/${params.id}`);
  }
  if (intent === 'delete') {
    await withSchoolId(session.schoolId, (tx) =>
      tx.update(duties).set({ isActive: false }).where(eq(duties.id, params.id)),
    );
    return redirect('/app/duties');
  }
  return null;
}

export default function DutyDetail() {
  const { duty, assignments, role, csrfToken } = useLoaderData<typeof loader>();
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">Day {duty.cycleDay} duty</div>
          <h2 className="text-2xl font-bold text-slate-900 mt-1">{duty.location}</h2>
          <div className="text-sm text-slate-600 mt-1">
            {duty.startTime} – {duty.endTime} · {minutesBetween(duty.startTime, duty.endTime)} min
            {duty.requiresVest ? ' · vest' : ''}{duty.requiresRadio ? ' · radio' : ''}
          </div>
        </div>
        <Link to="/app/duties" className="text-sm text-slate-500 hover:text-slate-700">← All duties</Link>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl">
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900">Assigned teachers</h3>
          <span className="text-xs text-slate-500">{assignments.length}</span>
        </header>
        {assignments.length === 0 ? (
          <div className="px-5 py-6 text-sm text-slate-500">No teachers assigned yet.</div>
        ) : (
          <ul className="divide-y divide-slate-200">
            {assignments.map((a) => (
              <li key={a.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-slate-900">{a.userName}</div>
                  <div className="text-xs text-slate-500">{a.userEmail}</div>
                </div>
                <div className="text-xs text-slate-500">
                  From {a.startDate}{a.endDate ? ` to ${a.endDate}` : ' (open-ended)'}
                </div>
              </li>
            ))}
          </ul>
        )}
        {role === 'school_admin' && (
          <Form method="post" className="border-t border-slate-200 px-5 py-4 flex gap-2 items-end">
            <input type="hidden" name="csrf" value={csrfToken ?? ''} />
            <input type="hidden" name="intent" value="assign" />
            <label className="block flex-1">
              <span className="text-xs font-medium text-slate-700">Teacher user ID</span>
              <input name="userId" type="text" required placeholder="uuid" className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Start date</span>
              <input name="startDate" type="date" required className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm" />
            </label>
            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg text-sm">Assign</button>
          </Form>
        )}
      </section>

      {role === 'school_admin' && (
        <Form method="post" className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
          <input type="hidden" name="csrf" value={csrfToken ?? ''} />
          <div>
            <div className="font-medium text-slate-900">Deactivate duty</div>
            <div className="text-xs text-slate-500">Duty will be hidden from active lists.</div>
          </div>
          <button type="submit" name="intent" value="delete" className="text-sm text-red-600 hover:text-red-700">Deactivate</button>
        </Form>
      )}
    </div>
  );
}


function minutesBetween(start: string, end: string): number {
  const parts = (s: string): [number, number] => {
    const [h, m] = s.split(':').map(Number);
    return [h ?? 0, m ?? 0];
  };
  const [sh, sm] = parts(start);
  const [eh, em] = parts(end);
  return (eh * 60 + em) - (sh * 60 + sm);
}
