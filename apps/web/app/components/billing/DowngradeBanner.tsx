// apps/web/app/components/billing/DowngradeBanner.tsx
//
// Banner rendered at the top of every admin page WHILE the school has
// a destructive downgrade pending. Shows a countdown to the
// `plan_downgrade_effective_at` date and a one-click "Export audit
// log" link to /api/billing/audit-export.csv.
//
// Wired into apps/web/app/routes/_app.tsx (the authenticated layout).
//
// No interactivity — pure SSR component. SSR-recomputed on each page
// load from the loader-supplied `pendingDowngradeAt` timestamp so
// the countdown is "as of page load" (we don't trust the client
// clock for billing decisions).

import { Link } from 'react-router';
import { useClientNow } from '../../../lib/useClientNow';

export interface DowngradeBannerProps {
  /** ISO-8601 string of `plan_downgrade_effective_at`. */
  pendingDowngradeAt: string;
  /** Plan we're about to drop to (typically `'free'`). */
  pendingPlan: string;
  /** Current plan (e.g. `'pro'`). Used in the body. */
  currentPlan: string;
}

export function DowngradeBanner({
  pendingDowngradeAt,
  pendingPlan,
  currentPlan,
}: DowngradeBannerProps) {
  const when = new Date(pendingDowngradeAt);
  const isoDate = when.toISOString().slice(0, 10);
  const daysLeft = useDaysUntil(when);
  return (
    <div
      role="alert"
      aria-live="polite"
      className="bg-amber-50 border-b border-amber-200 px-6 py-3 flex items-start gap-3"
      data-testid="downgrade-banner"
    >
      <span aria-hidden className="text-amber-600 text-lg leading-none mt-0.5">
        ⚠
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-900">
          Your {currentPlan} subscription has ended. Data retention will be reduced on{' '}
          {isoDate} ({daysLeft} day{daysLeft === 1 ? '' : 's'} from now).
        </p>
        <p className="text-sm text-amber-800 mt-0.5">
          We&apos;ll switch the plan to <b>{pendingPlan}</b> on that date. Export your
          audit log now if you need it beyond the new retention window.
        </p>
      </div>
      <a
        href="/api/billing/audit-export.csv"
        className="shrink-0 inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
        download
        aria-label="Export audit log as CSV"
      >
        ↓ Export audit log (CSV)
      </a>
    </div>
  );
}

function useDaysUntil(when: Date): number {
  const clientNow = useClientNow();
  const ms =
    clientNow !== null ? when.getTime() - clientNow.getTime() : Number.POSITIVE_INFINITY;
  if (ms <= 0) return 0;
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Convenience helper for loaders: build a serializable banner props bag
 * from a school row. Returns null if there's no pending downgrade.
 */
export function downgradeBannerPropsFor(school: {
  planDowngradePendingTo: string | null;
  planDowngradeEffectiveAt: Date | string | null;
  plan: string;
}): DowngradeBannerProps | null {
  if (
    !school.planDowngradePendingTo ||
    !school.planDowngradeEffectiveAt
  ) {
    return null;
  }
  const iso =
    school.planDowngradeEffectiveAt instanceof Date
      ? school.planDowngradeEffectiveAt.toISOString()
      : new Date(school.planDowngradeEffectiveAt).toISOString();
  return {
    pendingDowngradeAt: iso,
    pendingPlan: school.planDowngradePendingTo,
    currentPlan: school.plan,
  };
}

// Re-export Link for callers that prefer it
export { Link };
