// apps/web/app/routes/_app.settings._index.tsx — school settings
//
// Shows:
//   - School name (with rename form)
//   - School join code (for sharing with teachers — migration 0006)
//   - Copy / rename controls for the join code
//   - Plan + demo-expires-at (if applicable)
//   - Roster teaser (full roster lands in /app/settings/roster — future)
//
// Admin only (school_admin role required at the loader + action).

import { eq, sql } from 'drizzle-orm';
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Save } from 'lucide-react';
import { schools } from '@edusupervise/db';
import type { Route } from './+types/_app.settings._index';
import {
  getSession,
  requireSession,
  requireRole,
} from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { CopyableJoinCode } from '../components/CopyableJoinCode';
import {
  mintCsrfCookie,
  readCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import { recordAudit, AUDIT } from '../../server/audit.server';
import { logger } from '../../server/logger.server';

export function meta() {
  return [{ title: 'Settings — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);

  const data = await withSchoolId(session.schoolId, async (tx) => {
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

  // Read CSRF token from the request cookie so the rename form's
  // hidden field gets a real value via loader data. Mints + sets
  // Set-Cookie when missing (first visit), matching the pattern
  // in /signup, /login, /_app loaders.
  const existing = readCsrfCookie(request);
  if (existing) return { ...data, csrfToken: existing };
  const { token, setCookie } = mintCsrfCookie();
  return new Response(
    JSON.stringify({ ...data, csrfToken: token }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': setCookie },
    },
  );
}

interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function action({ request }: Route.ActionArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);

  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  const intent = String(form.get('intent') ?? '');
  if (intent === 'rename_school') {
    const newName = String(form.get('name') ?? '').trim();
    if (newName.length < 2 || newName.length > 80) {
      return Response.json(
        { ok: false, error: 'School name must be 2–80 characters.' } satisfies ActionResult,
        { status: 400 },
      );
    }
    await withSchoolId(session.schoolId, async (tx) => {
      await tx
        .update(schools)
        .set({
          name: newName,
          updatedAt: sql`${new Date().toISOString()}::timestamptz`,
        })
        .where(eq(schools.id, session.schoolId));
    });
    logger.info(
      { userId: session.userId, schoolId: session.schoolId, newName },
      'settings: renamed school',
    );
    await recordAudit({
      schoolId: session.schoolId,
      userId: session.userId,
      action: AUDIT.SCHOOL_RENAME,
      targetType: 'school',
      targetId: session.schoolId,
      metadata: { newName },
    });
    return Response.json({ ok: true } satisfies ActionResult);
  }

  return Response.json(
    { ok: false, error: 'Unknown action.' } satisfies ActionResult,
    { status: 400 },
  );
}

export default function SettingsPage() {
  const { school, csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionResult | undefined;
  const nav = useNavigation();
  const submitting =
    nav.state !== 'idle' &&
    nav.formData?.get('intent') === 'rename_school';

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
      </header>

      <RenameSchoolCard
        currentName={school.name}
        csrfToken={csrfToken}
        submitting={!!submitting}
        actionData={actionData}
      />

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

function RenameSchoolCard({
  currentName,
  csrfToken,
  submitting,
  actionData,
}: {
  currentName: string;
  csrfToken: string;
  submitting: boolean;
  actionData: ActionResult | undefined;
}): React.ReactElement {
  return (
    <section className="bg-surface border border-border rounded-xl p-xl">
      <h3 className="text-title-3 text-primary font-semibold mb-sm">
        School name
      </h3>
      <p className="text-callout text-secondary mb-md">
        The name that teachers see when they sign up at{' '}
        <code className="font-mono text-body">/signup</code> and that shows up
        in their notifications.
      </p>
      <Form method="post" className="space-y-sm">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="rename_school" />
        <label className="block">
          <span className="sr-only">School name</span>
          <input
            type="text"
            name="name"
            defaultValue={currentName}
            required
            minLength={2}
            maxLength={80}
            className="w-full h-input px-md bg-surface border border-border rounded-md text-body text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors duration-fast"
          />
        </label>
        {actionData?.error && (
          <p
            role="alert"
            className="text-callout text-danger rounded-md bg-danger-soft px-md py-sm"
          >
            {actionData.error}
          </p>
        )}
        {actionData?.ok && (
          <p
            role="status"
            className="text-callout text-success rounded-md bg-success-soft px-md py-sm"
          >
            Saved.
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="h-btn-md px-xl rounded-md font-semibold bg-accent text-on-accent hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast inline-flex items-center gap-sm"
        >
          <Save size={16} aria-hidden />
          {submitting ? 'Saving…' : 'Save name'}
        </button>
      </Form>
    </section>
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