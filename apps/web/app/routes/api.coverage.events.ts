// apps/web/app/routes/api.coverage.events.ts — List open coverage events
// for the current school.
//
// Authenticated. Returns the same shape as the page loader
// (listCoverage() output).

import { json } from '@react-router/node';
import type { Route } from './+types/api.coverage.events';
import { getSession, requireSession } from '../../server/auth.server';
import { listCoverage } from '../../server/coverage.server';

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  const url = new URL(request.url);
  const forTeacherId = url.searchParams.get('teacherId') ?? undefined;
  const events = await listCoverage({
    schoolId: session.schoolId,
    forTeacherId,
  });
  return json({ events });
}
