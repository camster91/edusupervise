// apps/web/app/routes/_app.calendar._index.tsx — placeholder
import type { Route } from './+types/_app.calendar._index';
import { getSession, requireSession } from '~/server/auth.server';

export function meta() {
  return [{ title: 'Calendar — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireSession(await getSession(request));
  return null;
}

export default function CalendarPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">Calendar</h2>
      <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-500">
        Monthly grid view coming soon. For now, see <a href="/app/duties" className="text-blue-600 hover:underline">duties</a> and the dashboard.
      </div>
    </div>
  );
}