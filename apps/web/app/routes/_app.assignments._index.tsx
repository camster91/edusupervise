// apps/web/app/routes/_app.assignments._index.tsx — placeholder
import type { Route } from './+types/_app.assignments._index';
import { getSession, requireSession } from '../../server/auth.server.ts';

export function meta() {
  return [{ title: 'Assignments — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireSession(await getSession(request));
  return null;
}

export default function AssignmentsPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-primary">Assignments</h2>
      <div className="bg-surface border border-border rounded-xl p-12 text-center text-tertiary">
        Use the duty detail page to assign teachers. A dedicated roster view is on the Tier 2 roadmap.
      </div>
    </div>
  );
}