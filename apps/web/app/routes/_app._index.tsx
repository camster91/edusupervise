// apps/web/app/routes/_app._index.tsx — Dashboard
// 
// Phase 2A refactor: redirects to /app/today. The old dashboard had
// stat cards + "your duties" list. The new "Today" view is the proper
// per-teacher landing surface (design system section 3.1) — the
// stat cards are now on the admin / Reports tab and the duty list is
// integrated into the Today view's chronological list.

import { redirect } from 'react-router';
import type { Route } from './+types/_app._index';

export function loader(_args: Route.LoaderArgs) {
  throw redirect('/app/today');
}

export default function DashboardIndex() {
  return null;
}
