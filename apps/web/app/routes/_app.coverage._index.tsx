// apps/web/app/routes/_app.coverage._index.tsx — Coverage requests (Phase 2A refactor)
//
// Placeholder. The full Coverage Router (Phase 2B) will live here.
// For now: a HIG-spec empty state with the right primary action.

import { Link } from 'react-router';
import { Bell, Plus } from 'lucide-react';
import { EmptyState, Button } from '../components/ui';

export function meta() {
  return [{ title: 'Coverage — EduSupervise' }];
}

export default function CoveragePage() {
  return (
    <div className="max-w-2xl mx-auto space-y-xl">
      <div>
        <h1 className="text-title-1 text-primary font-bold flex items-center gap-sm">
          <Bell size={28} aria-hidden className="text-secondary" />
          Coverage
        </h1>
        <p className="text-callout text-secondary mt-xs">
          Coverage requests and the swap board.
        </p>
      </div>

      <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
        <EmptyState
          icon={<Plus size={48} aria-hidden />}
          title="Coverage Router ships in Phase 2B"
          description="The full feature — auto-rerouting duties when a teacher calls out, integrating with Frontline/Red Rover absence webhooks, and notifying the affected parents — is the next sprint. This page is wired up and ready."
          action={{ label: 'Read the design spec', href: '/app/coverage' }}
        />
      </div>
    </div>
  );
}
