// apps/web/app/routes/_app.settings.billing.tsx — billing settings page.
//
// Admin-only. Renders:
//   - Current plan card
//   - Pending downgrade countdown (if any) — with the audit-export
//     button visible during grace (per spec section 6: "Export your
//     audit log now").
//   - Plan upgrade buttons (POST to /api/billing/checkout)
//   - Manage billing button (POST to /api/billing/portal)
//   - Invoices list (loader pulls from /api/billing/invoices handler logic)
//
// Loader: GET — returns plan + pending-downgrade + invoices
// Action: never — this page is read-only; mutations go to /api/billing/*

import type { Route } from './+types/_app.settings.billing';
import { Form, useLoaderData } from 'react-router';
import { eq } from 'drizzle-orm';
import { schools } from '@edusupervise/db';

import {
  getSession,
  requireRole,
  requireSession,
} from '../../server/auth.server';
import { getDb, withSchoolId } from '../../server/db.server';
import { readCsrfCookie, validateCsrfWithFormToken } from '../../server/csrf.server';
import {
  listInvoicesForSchool,
  runDailyDowngradeFlip,
} from '../../server/billing.server';
import {
  downgradeBannerPropsFor,
} from '../components/billing/DowngradeBanner';
import {
  upgradeToProForTesting,
} from '../../server/billing-fixtures.server';

export function meta() {
  return [{ title: 'Billing — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const csrfToken = readCsrfCookie(request);

  // Schools row lookup MUST go through the runtime role context
  // with `app.school_id` set — otherwise RLS filters it out and
  // the loader 404s. schools are tenant-owned; setting
  // app.school_id = session.schoolId before reading is safe.
  const [school] = await withSchoolId(session.schoolId, async (tx) =>
    tx
      .select({
        id: schools.id,
        plan: schools.plan,
        planDowngradePendingTo: schools.planDowngradePendingTo,
        planDowngradeEffectiveAt: schools.planDowngradeEffectiveAt,
        trialEndsAt: schools.trialEndsAt,
      })
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1)
  );
  if (!school) {
    throw new Response('School not found', { status: 404 });
  }

  const invoices = await listInvoicesForSchool(session.schoolId);
  const downgrade = downgradeBannerPropsFor(school);
  return { school, invoices, downgrade, csrfToken };
}

export default function BillingSettingsPage() {
  const { school, invoices, downgrade, csrfToken } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-900">Billing</h2>

      {downgrade && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-amber-900">
            {school.plan === 'pro' || school.plan === 'school'
              ? `Pending downgrade to ${downgrade.pendingPlan}`
              : 'Plan downgrade in progress'}
          </p>
          <p className="text-sm text-amber-800 mt-1">
            Your plan switches to <b>{downgrade.pendingPlan}</b> on{' '}
            <b>{downgrade.pendingDowngradeAt.slice(0, 10)}</b>. Export your
            audit log now if you need to keep more than the {downgrade.pendingPlan}{' '}
            retention window allows.
          </p>
          <a
            href="/api/billing/audit-export.csv"
            className="mt-3 inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
            download
          >
            ↓ Export audit log (CSV)
          </a>
        </div>
      )}

      <PlanCard school={school} />

      <PlanUpgradeForm csrfToken={csrfToken} />

      <PortalButton csrfToken={csrfToken} />

      <InvoicesList invoices={invoices} />

      <TestDevTools />
    </div>
  );
}

function PlanCard({
  school,
}: {
  school: {
    plan: string;
    trialEndsAt: Date | string | null;
  };
}) {
  const trialEnds =
    school.trialEndsAt instanceof Date
      ? school.trialEndsAt
      : school.trialEndsAt
        ? new Date(school.trialEndsAt)
        : null;
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Current plan
          </div>
          <div className="text-2xl font-bold text-slate-900 capitalize">
            {school.plan}
          </div>
          {trialEnds && (
            <div className="text-xs text-slate-500 mt-1">
              Trial ends {trialEnds.toISOString().slice(0, 10)}
            </div>
          )}
        </div>
        <div className="text-right text-xs text-slate-500 leading-relaxed">
          <div>
            <b className="text-slate-700">Free</b> = 3 teachers, 10 duties, no SMS
          </div>
          <div>
            <b className="text-slate-700">Pro</b> = 50 teachers, 500 duties, SMS ✓
          </div>
          <div>
            <b className="text-slate-700">School</b> = 500 / 5,000 / SMS ✓
          </div>
        </div>
      </div>
    </section>
  );
}

function PlanUpgradeForm({ csrfToken }: { csrfToken: string }) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <h3 className="text-sm font-semibold text-slate-900">Upgrade plan</h3>
      <p className="text-xs text-slate-500 mt-1">
        We&apos;ll redirect you to Stripe Checkout to complete payment. In mock
        mode the redirect target is a stub URL.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Form method="post" action="/api/billing/checkout">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="plan" value="pro" />
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Upgrade to Pro
          </button>
        </Form>
        <Form method="post" action="/api/billing/checkout">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="plan" value="school" />
          <button
            type="submit"
            className="bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Upgrade to School
          </button>
        </Form>
      </div>
    </section>
  );
}

function PortalButton({ csrfToken }: { csrfToken: string }) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <h3 className="text-sm font-semibold text-slate-900">Manage subscription</h3>
      <p className="text-xs text-slate-500 mt-1">
        Update your card, change billing email, or cancel your subscription via the
        Stripe Customer Portal.
      </p>
      <Form method="post" action="/api/billing/portal" className="mt-4">
        <input type="hidden" name="csrf" value={csrfToken} />
        <button
          type="submit"
          className="bg-white border border-slate-300 hover:bg-slate-50 text-slate-900 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Open billing portal →
        </button>
      </Form>
    </section>
  );
}

function InvoicesList({
  invoices,
}: {
  invoices: Array<{
    id: string;
    amountDue: number;
    amountPaid: number;
    currency: string;
    status: string;
    created: number;
    hostedInvoiceUrl: string | null;
    number: string | null;
  }>;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <h3 className="text-sm font-semibold text-slate-900">Invoices</h3>
      {invoices.length === 0 ? (
        <p className="text-xs text-slate-500 mt-2">No invoices yet.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500 text-left">
            <tr>
              <th className="py-1.5 pr-4">Number</th>
              <th className="py-1.5 pr-4">Date</th>
              <th className="py-1.5 pr-4">Amount</th>
              <th className="py-1.5 pr-4">Status</th>
              <th className="py-1.5 pr-4"></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-mono text-xs text-slate-700">
                  {inv.number ?? inv.id.slice(0, 14)}
                </td>
                <td className="py-2 pr-4 text-slate-700">
                  {new Date(inv.created * 1000).toISOString().slice(0, 10)}
                </td>
                <td className="py-2 pr-4 text-slate-700">
                  {(inv.amountDue / 100).toFixed(2)} {inv.currency.toUpperCase()}
                </td>
                <td className="py-2 pr-4">
                  <span
                    className={
                      inv.status === 'paid'
                        ? 'bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full'
                        : 'bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full'
                    }
                  >
                    {inv.status}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  {inv.hostedInvoiceUrl && (
                    <a
                      href={inv.hostedInvoiceUrl}
                      className="text-blue-600 hover:underline text-xs"
                      target="_blank"
                      rel="noreferrer"
                    >
                      View
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Test-only inline controls:
 *   - "Trigger daily downgrade cron" runs the synchronous flip in
 *     the same process. Only visible when NODE_ENV !== 'production'.
 *   - "Force-set plan to Pro" (mock checkout fixture) — calls the
 *     fixture helper that uses the system role to bypass RLS and
 *     set plan = pro without going through Stripe. Test infrastructure
 *     will replace this with the real plan-limit / checkout flow.
 */
function TestDevTools() {
  const csrfApp = useRouteLoaderData('routes/_app') as { csrfToken?: string } | undefined;
  const csrfToken = csrfApp?.csrfToken ?? '';
  if (process.env.NODE_ENV === 'production') return null;
  return (
    <section className="bg-slate-50 border border-slate-200 border-dashed rounded-xl p-4 text-xs text-slate-700">
      <div className="font-semibold text-slate-900 mb-1">Developer tools</div>
      <p className="text-slate-600 mb-3">
        Hidden in production. Used by integration tests and local
        development to bypass Stripe for the plan-flip flow.
      </p>
      <div className="flex flex-wrap gap-2">
        <Form method="post" action="/app/settings/billing?_action=cron">
          <input type="hidden" name="csrf" value={csrfToken ?? ''} />
          <button type="submit" className="bg-slate-200 hover:bg-slate-300 px-3 py-1 rounded text-xs">
            Run nightly cron now
          </button>
        </Form>
        <Form method="post" action="/app/settings/billing?_action=upgrade_pro">
          <input type="hidden" name="csrf" value={csrfToken ?? ''} />
          <button type="submit" className="bg-slate-200 hover:bg-slate-300 px-3 py-1 rounded text-xs">
            Force-set plan to Pro (test only)
          </button>
        </Form>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dev-only POST action handlers (test/dev convenience).
// Production code should never reach this branch — it's gated by
// NODE_ENV in TestDevTools.
// ---------------------------------------------------------------------------

export async function action({ request }: Route.ActionArgs) {
  // even in dev, only school_admin can hit this
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;
  const url = new URL(request.url);
  const intent = url.searchParams.get('_action');

  if (intent === 'cron') {
    // synchronous cron run for local development. Real prod cron
    // hits db/cron/plan-downgrade.sql directly via the alpine
    // container.
    if (process.env.NODE_ENV === 'production') {
      return Response.json({ error: 'dev_only' }, { status: 400 });
    }
    await runDailyDowngradeFlip();
    return new Response(null, { status: 303, headers: { Location: '/app/settings/billing' } });
  }

  if (intent === 'upgrade_pro') {
    if (process.env.NODE_ENV === 'production') {
      return Response.json({ error: 'dev_only' }, { status: 400 });
    }
    await upgradeToProForTesting(session.schoolId);
    return new Response(null, { status: 303, headers: { Location: '/app/settings/billing' } });
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 });
}

// Suppress unused import warning for `desc` (kept for future
// date-sorted audit-log use cases).
