// apps/web/app/routes/_app.settings.billing.tsx — billing settings page.
//
// Admin-only. Renders:
//   - Current plan card
//   - Pending downgrade countdown (if any)
//   - Plan upgrade buttons
//   - Manage billing button
//   - Invoices list
//
// Phase 3 §3.3 — adds a "Compare plans" view so the admin can see
// what's behind each tier before clicking upgrade. The comparison
// grid is rendered inline below the existing upgrade forms — admins
// don't leave the page to compare.
//
// Loader: GET — returns plan + pending-downgrade + invoices
// Action: dev-only convenience flags (unchanged)

import type { Route } from './+types/_app.settings.billing';
import { Form, useLoaderData, useRouteLoaderData, data } from 'react-router';
import { eq } from 'drizzle-orm';
import { schools } from '@edusupervise/db';
import { Check, X, Sparkles } from 'lucide-react';

import {
  getSession,
  requireRole,
  requireSession,
} from '../../server/auth.server';
import { getDb, withSchoolId } from '../../server/db.server';
import { readCsrfCookie, ensureCsrfCookie, validateCsrfWithFormToken } from '../../server/csrf.server';
import {
  listInvoicesForSchool,
  runDailyDowngradeFlip,
} from '../../server/billing.server';
import { upgradeToProForTesting } from '../../server/billing-fixtures.server';

export function meta() {
  return [{ title: 'Billing — EduSupervise' }];
}

interface PlanFeature {
  label: string;
  free: string | boolean;
  pro: string | boolean;
  school: string | boolean;
}

const PLAN_FEATURES: PlanFeature[] = [
  {
    label: 'Teachers',
    free: 'Up to 5',
    pro: 'Up to 50',
    school: 'Unlimited',
  },
  {
    label: 'Duties',
    free: 'Up to 50',
    pro: 'Up to 500',
    school: 'Up to 5,000',
  },
  {
    label: 'SMS reminders',
    free: false,
    pro: true,
    school: true,
  },
  {
    label: 'PDF ingestion (school-wide)',
    free: false,
    pro: true,
    school: true,
  },
  {
    label: 'Parent alerts',
    free: false,
    pro: true,
    school: true,
  },
  // Phase 3 §3.1
  {
    label: 'Group duties (3+ teachers / slot)',
    free: false,
    pro: false,
    school: true,
  },
  // Phase 3 §3.2
  {
    label: 'Recurring time-bound duties',
    free: false,
    pro: false,
    school: true,
  },
  // Phase 3 §3.4
  {
    label: 'Coverage broadcast (all eligible teachers)',
    free: false,
    pro: false,
    school: true,
  },
  {
    label: 'Bulk CSV import',
    free: false,
    pro: false,
    school: true,
  },
  {
    label: 'Custom school branding',
    free: false,
    pro: false,
    school: true,
  },
];

const PLAN_PRICING: Record<string, { price: string; tagline: string }> = {
  free: { price: '$0', tagline: 'Solo + small schools' },
  pro: { price: '$9 / mo', tagline: 'School-wide basics' },
  school: { price: '$39 / mo', tagline: 'Full admin suite' },
};

export async function loader({ request }: Route.LoaderArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const { token: csrfToken, setCookie: csrfSetCookie } = ensureCsrfCookie(request);

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
      .limit(1),
  );
  if (!school) {
    throw new Response('School not found', { status: 404 });
  }

  const invoices = await listInvoicesForSchool(session.schoolId);
  const pendingDowngrade =
    school.planDowngradePendingTo != null && school.planDowngradeEffectiveAt != null
      ? {
          pendingPlan: school.planDowngradePendingTo,
          pendingDowngradeAt:
            school.planDowngradeEffectiveAt instanceof Date
              ? school.planDowngradeEffectiveAt.toISOString()
              : String(school.planDowngradeEffectiveAt),
        }
      : null;
  return data(
    { school, invoices, pendingDowngrade, csrfToken },
    csrfSetCookie ? { headers: { 'Set-Cookie': csrfSetCookie } } : undefined,
  );
}

export default function BillingSettingsPage() {
  const { school, invoices, pendingDowngrade, csrfToken } = useLoaderData<typeof loader>();
  const isCurrentFree = school.plan === 'free' || school.plan === 'trial';
  const isCurrentPro = school.plan === 'pro';
  const isCurrentSchool = school.plan === 'school';
  return (
    <div className="max-w-3xl mx-auto space-y-xl pb-3xl">
      <h1 className="text-title-1 text-primary font-bold">Billing</h1>

      {pendingDowngrade && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-amber-900">
            {school.plan === 'pro' || school.plan === 'school'
              ? `Pending downgrade to ${pendingDowngrade.pendingPlan}`
              : 'Plan downgrade in progress'}
          </p>
          <p className="text-sm text-amber-800 mt-1">
            Your plan switches to <b>{pendingDowngrade.pendingPlan}</b> on{' '}
            <b>{pendingDowngrade.pendingDowngradeAt.slice(0, 10)}</b>. Export your
            audit log now if you need to keep more than the {pendingDowngrade.pendingPlan}{' '}
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

      {/* Compare plans — Phase 3 §3.3 */}
      <ComparePlans currentPlan={school.plan} csrfToken={csrfToken} />

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
          <div className="text-2xl font-bold text-slate-900 capitalize flex items-center gap-2">
            {school.plan === 'school' && <Sparkles size={20} aria-hidden className="text-accent" />}
            {school.plan}
          </div>
          {trialEnds && (
            <div className="text-xs text-slate-500 mt-1">
              Trial ends {trialEnds.toISOString().slice(0, 10)}
            </div>
          )}
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
            Upgrade to Pro — $9 / mo
          </button>
        </Form>
        <Form method="post" action="/api/billing/checkout">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="plan" value="school" />
          <button
            type="submit"
            className="bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Upgrade to School — $39 / mo
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

function ComparePlans({
  currentPlan,
  csrfToken,
}: {
  currentPlan: string;
  csrfToken: string;
}): React.ReactElement {
  const isCurrent = (plan: string) => plan === currentPlan;
  const tiers: Array<'free' | 'pro' | 'school'> = ['free', 'pro', 'school'];
  return (
    <section
      className="bg-white border border-slate-200 rounded-xl p-6"
      data-testid="compare-plans"
    >
      <header className="mb-md">
        <h3 className="text-title-3 text-primary font-bold flex items-center gap-2">
          <Sparkles size={18} aria-hidden className="text-accent" />
          Compare plans
        </h3>
        <p className="text-callout text-secondary mt-xs">
          School-wide broadcast and recurring duties unlock on the School plan.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-500 text-left">
              <th className="py-2 pr-4 w-1/3">Feature</th>
              {tiers.map((t) => (
                <th key={t} className="py-2 pr-4 align-bottom">
                  <div className="flex flex-col gap-1">
                    <div className="capitalize font-semibold text-slate-900">{t}</div>
                    <div className="text-callout font-normal text-secondary">
                      {PLAN_PRICING[t]?.price ?? ''}
                    </div>
                    {isCurrent(t) ? (
                      <div className="text-caption-2 font-medium text-accent mt-0.5">
                        Current plan
                      </div>
                    ) : null}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PLAN_FEATURES.map((row) => (
              <tr key={row.label} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-slate-800">{row.label}</td>
                {tiers.map((t) => (
                  <td key={t} className="py-2 pr-4 text-slate-700">
                    <FeatureValue value={row[t]} />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-slate-200">
              <td></td>
              {tiers.map((t) => (
                <td key={t} className="py-3 pr-4">
                  {isCurrent(t) ? (
                    <span className="text-callout text-secondary">Current</span>
                  ) : t === 'free' ? (
                    <span className="text-callout text-tertiary">—</span>
                  ) : (
                    <Form method="post" action="/api/billing/checkout" className="inline">
                      <input type="hidden" name="csrf" value={csrfToken} />
                      <input type="hidden" name="plan" value={t} />
                      <button
                        type="submit"
                        className={`text-callout font-semibold rounded px-md py-1 transition-colors ${
                          t === 'school'
                            ? 'bg-slate-900 hover:bg-slate-800 text-white'
                            : 'bg-blue-600 hover:bg-blue-700 text-white'
                        }`}
                      >
                        {t === 'school' ? 'Upgrade to School' : 'Upgrade to Pro'}
                      </button>
                    </Form>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FeatureValue({ value }: { value: string | boolean }): React.ReactElement {
  if (value === true) {
    return (
      <span className="inline-flex items-center text-success">
        <Check size={14} aria-hidden />
        <span className="sr-only">Included</span>
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center text-tertiary">
        <X size={14} aria-hidden />
        <span className="sr-only">Not included</span>
      </span>
    );
  }
  return <span className="text-callout text-slate-700">{value}</span>;
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

export async function action({ request }: Route.ActionArgs) {
  const session = requireSession(await getSession(request));
  requireRole(session, ['school_admin']);
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;
  const url = new URL(request.url);
  const intent = url.searchParams.get('_action');

  if (intent === 'cron') {
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
