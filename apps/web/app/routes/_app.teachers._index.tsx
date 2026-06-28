// apps/web/app/routes/_app.teachers._index.tsx — placeholder
import type { Route } from './+types/_app.teachers._index';
import { getSession, requireSession, requireRole } from '../server/auth.server';

export function meta() {
  return [{ title: 'Teachers — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  return null;
}

export default function TeachersPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">Teachers</h2>
      <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-500">
        Teacher roster + invite + CSV import lands in the next sprint.
      </div>
    </div>
  );
}