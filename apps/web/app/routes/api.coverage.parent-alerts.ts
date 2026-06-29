// apps/web/app/routes/api.coverage.parent-alerts.ts — List parent alerts
// (Phase 3).
//
// Authenticated. Returns the alerts for the current school. Supports
// filtering by status (draft, queued, sent, failed, cancelled).

import { json } from 'react-router';
import type { Route } from './+types/api.coverage.parent-alerts';
import { getSession, requireSession } from '../../server/auth.server';
import { listAlerts, type ParentAlertStatus } from '../../server/parent-alerts.server';

const VALID_STATUSES: ParentAlertStatus[] = ['draft', 'queued', 'sent', 'failed', 'cancelled'];

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const status: ParentAlertStatus | undefined = statusParam && (VALID_STATUSES as string[]).includes(statusParam)
    ? (statusParam as ParentAlertStatus)
    : undefined;
  const limit = Number(url.searchParams.get('limit') ?? '200');
  const alerts = await listAlerts({
    schoolId: session.schoolId,
    status,
    limit: Number.isFinite(limit) ? limit : 200,
  });
  return json({ alerts });
}
