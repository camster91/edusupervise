// GET /app/api/today — stable JSON transport for the shared Today data.
// The web page and mobile endpoint both call server/today.server.ts, so a
// query or response-shape change cannot land in only one client.

import type { Route } from './+types/app.api.today';
import { getSession } from '../../server/auth.server';
import { logger } from '../../server/logger.server';
import { loadTodayData } from '../../server/today.server';

export function loader({ request }: Route.LoaderArgs) {
  const accept = request.headers.get('accept') ?? '';
  if (!accept.includes('application/json')) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/app/today' },
    });
  }

  return loaderJson(request);
}

async function loaderJson(request: Request) {
  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const data = await loadTodayData(session);
    return Response.json(data, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    logger.error(
      { err, schoolId: session.schoolId, userId: session.userId },
      'app.api.today: loader failed',
    );
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
