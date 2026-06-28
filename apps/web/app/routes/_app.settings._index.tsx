// apps/web/app/routes/_app.settings._index.tsx — placeholder
import type { Route } from './+types/_app.settings._index';
import { getSession, requireSession, requireRole } from '../../server/auth.server.ts';

export function meta() {
  return [{ title: 'Settings — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  return null;
}

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">Settings</h2>
      <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-500">
        School config + branding + billing lands in the next sprint.
      </div>
    </div>
  );
}