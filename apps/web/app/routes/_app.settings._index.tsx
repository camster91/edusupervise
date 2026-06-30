// apps/web/app/routes/_app.settings._index.tsx — school settings
//
// Shows:
//   - School join code (for sharing with teachers — migration 0006)
//   - Copy / rename controls for the join code
//   - Plan + demo-expires-at (if applicable)
//   - Roster teaser (full roster lands in /app/settings/roster — future)
//
// Admin only (school_admin role required at the loader).

import { eq } from 'drizzle-orm';
import { useLoaderData } from 'react-router';
import { schools } from '@edusupervise/db';
import type { Route } from './+types/_app.settings._index';
import {
  getSession,
  requireSession,
  requireRole,
} from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { CopyableJoinCode } from '../components/CopyableJoinCode';

export function meta() {
  return [{ title: 'Settings — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);

  return withSchoolId(session.schoolId, async (tx) => {
    const [school] = await tx
      .select({
        id: schools.id,
        name: schools.name,
        joinCode: schools.joinCode,
        plan: schools.plan,
        demoExpiresAt: schools.demoExpiresAt,
      })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    return { school: school ?? null };
  });
}

export default function SettingsPage() {
  const { school } = useLoaderData<typeof loader>();
  if (!school) {
    return (
      <div className="space-y-4">
        <h2 className="text-title-2 text-primary font-bold">Settings</h2>
        <div className="bg-surface border border-border rounded-xl p-12 text-center text-secondary">
          School not found.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-xl max-w-2xl">
      <header>
        <h2 className="text-title-2 text-primary font-bold">Settings</h2>
        <p className="text-callout text-secondary mt-xs">
          {school.name}
        </p>
      </header>

      <CopyableJoinCode joinCode={school.joinCode} />

      {school.plan === 'demo' && school.demoExpiresAt && (
        <DemoStatusCard
          expiresAt={school.demoExpiresAt}
        />
      )}

      <section className="bg-surface border border-border rounded-xl p-xl">
        <h3 className="text-title-3 text-primary font-semibold mb-sm">
          More settings coming soon
        </h3>
        <p className="text-callout text-secondary">
          Branding, billing, and the full roster importer land in the next sprint.
        </p>
      </section>
    </div>
  );
}

function DemoStatusCard({ expiresAt }: { expiresAt: string }): React.ReactElement {
  const expires = new Date(expiresAt);
  const daysLeft = Math.max(
    0,
    Math.ceil((expires.getTime() - Date.now()) / (24 * 3600 * 1000)),
  );
  return (
    <section className="bg-warning-soft border border-warning/30 rounded-xl p-xl">
      <h3 className="text-title-3 text-warning font-semibold mb-xs">
        Demo mode active
      </h3>
      <p className="text-callout text-secondary">
        Your school flips to read-only in <strong>{daysLeft} {daysLeft === 1 ? 'day' : 'days'}</strong>.
        Click <em>Reset demo</em> in the banner above to wipe and re-seed.
      </p>
    </section>
  );
}