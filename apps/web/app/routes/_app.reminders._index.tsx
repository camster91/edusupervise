// apps/web/app/routes/_app.reminders._index.tsx — placeholder
import type { Route } from './+types/_app.reminders._index';
import { getSession, requireSession } from '../../server/auth.server.ts';

export function meta() {
  return [{ title: 'Reminders — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireSession(await getSession(request));
  return null;
}

export default function RemindersPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-primary">Reminders</h2>
      <div className="bg-surface border border-border rounded-xl p-12 text-center text-tertiary">
        Reminder configuration UI lands in the next sprint. The worker + queue infrastructure is in place to dispatch them once configured.
      </div>
    </div>
  );
}