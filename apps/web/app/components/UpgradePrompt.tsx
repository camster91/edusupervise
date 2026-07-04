// apps/web/app/components/UpgradePrompt.tsx — modal shown when a free
// (or under-tier) school admin tries a gated feature.
//
// Phase 3 §3.3 — billing wall UX. The wall is value-aligned: the
// modal names the feature the admin was trying, the plan tier they
// need, and the per-month price. No nag, no guilt. Single primary CTA
// goes to /app/settings/billing (or directly to /api/billing/checkout
// when a `plan` is provided).
//
// Two entry modes:
//   1. Controlled by the parent — `<UpgradePrompt open={...} onOpenChange=...} reason={...} />`.
//      Caller decides when to dismiss (e.g. after they navigated).
//   2. Singleton helper — `useUpgradePrompt()` returns a hook that
//      fetches the body, decodes the JSON, and renders the modal.
//      Components subscribe via `triggerUpgradePrompt(bodyJson)`.
//
// The reason body shape (matches plan-enforcement.server.ts →
// buildFeatureGateResponse):
//   {
//     error: 'plan_feature_locked' | 'plan_limit_exceeded',
//     feature?: 'coverage.broadcast' | 'recurring.duties' | ...,
//     featureLabel?: string,
//     limit?: string,
//     current?: number,
//     max?: number,
//     currentPlan?: 'free' | 'pro' | 'school' | ...,
//     minimumPlan?: 'school',
//     cta?: string,
//     upgrade_url: '/app/settings/billing'
//   }

import * as React from 'react';
import { Sparkles, X as CloseIcon, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogHeader,
  DialogFooter,
} from './ui/Dialog';
import { Button } from './ui/Button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpgradeReason = {
  error: 'plan_feature_locked' | 'plan_limit_exceeded';
  feature?: string;
  featureLabel?: string;
  limit?: string;
  current?: number;
  max?: number;
  currentPlan?: string;
  minimumPlan?: string;
  cta?: string;
  upgrade_url?: string;
};

/** Tier prices. Keep in sync with billing-fixtures / billing-adapter. */
const PLAN_PRICES: Record<string, string> = {
  pro: '$9 / month',
  school: '$39 / month',
};

function tierPrice(plan: string | undefined): string | null {
  if (!plan) return null;
  return PLAN_PRICES[plan] ?? null;
}

// ---------------------------------------------------------------------------
// Single-shot modal
// ---------------------------------------------------------------------------

export interface UpgradePromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: UpgradeReason | null;
  /** Optional: which plan the upgrade should land on (else routes to /settings/billing). */
  upgradePlan?: 'pro' | 'school';
}

export function UpgradePrompt({
  open,
  onOpenChange,
  reason,
  upgradePlan,
}: UpgradePromptProps): React.ReactElement | null {
  if (!reason) return null;

  const isFeatureGate = reason.error === 'plan_feature_locked';
  const headline = isFeatureGate
    ? (reason.featureLabel ?? 'This feature')
    : `You've hit the ${reason.limit ?? 'plan'} limit`;
  const subhead = isFeatureGate
    ? (reason.cta ?? `Upgrade to ${reason.minimumPlan ?? 'school'} to unlock this.`)
    : `Your plan allows up to ${reason.max ?? '?'} ${reason.limit ?? ''}. Upgrade to add more.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2 text-accent">
            <Sparkles size={20} aria-hidden />
            <span className="text-footnote uppercase tracking-wide font-semibold">
              {isFeatureGate ? 'Paid feature' : 'Plan limit reached'}
            </span>
          </div>
          <DialogTitle className="text-xl">{headline}</DialogTitle>
          <DialogDescription>{subhead}</DialogDescription>
        </DialogHeader>

        {isFeatureGate && reason.minimumPlan && (
          <TierSummary plan={reason.minimumPlan} />
        )}

        {!isFeatureGate && (
          <LimitSummary
            current={reason.current ?? 0}
            max={reason.max ?? 0}
            label={reason.limit ?? 'item'}
          />
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            size="md"
            onClick={() => onOpenChange(false)}
          >
            Not now
          </Button>
          <Button variant="primary" size="md" asChild>
            <a
              href={upgradePlan ? `/api/billing/checkout?plan=${upgradePlan}` : '/app/settings/billing'}
              data-method="post"
              data-csrf={reason.upgrade_url ? 'auto' : undefined}
            >
              {upgradePlan
                ? `Upgrade to ${capitalize(upgradePlan)}${tierPrice(upgradePlan) ? ` — ${tierPrice(upgradePlan)}` : ''}`
                : 'Compare plans'}
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TierSummary({ plan }: { plan: string }): React.ReactElement {
  const features: Record<string, string[]> = {
    school: [
      'Unlimited teachers + duties',
      'Group duties (3+ teachers per slot)',
      'Recurring time-bound duties',
      'Coverage broadcast (all eligible teachers)',
      'Parent alerts + bulk CSV import',
      'Custom school branding',
      'SMS included',
    ],
    pro: [
      'Up to 50 teachers',
      'Parent alerts',
      'PDF ingestion for the school',
      'SMS included',
    ],
  };
  const list = features[plan] ?? [];
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-md py-sm">
      <div className="flex items-baseline justify-between">
        <div className="text-callout font-semibold capitalize">{plan}</div>
        {tierPrice(plan) && (
          <div className="text-callout text-secondary tabular">{tierPrice(plan)}</div>
        )}
      </div>
      <ul className="mt-xs space-y-1" role="list">
        {list.map((f) => (
          <li key={f} className="flex items-start gap-xs text-footnote text-secondary">
            <Check size={14} aria-hidden className="mt-0.5 text-success" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LimitSummary({
  current,
  max,
  label,
}: {
  current: number;
  max: number;
  label: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-warning bg-warning-soft px-md py-sm">
      <div className="text-callout font-semibold text-warning">
        {current} / {max} {label}
      </div>
      <p className="text-footnote text-secondary mt-xs">
        Upgrade your plan to keep adding {label}.
      </p>
    </div>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// useUpgradePrompt — soft singleton for fetch-driven flows
// ---------------------------------------------------------------------------

/**
 * Soft singleton. One modal per page. Components call
 * `triggerUpgradePrompt(jsonBody)` from a 403 response. The hook
 * decodes the body, opens the modal, and renders it.
 *
 * For server-driven flows (RR7 `throw new Response(body, { status: 403 })`),
 * the route's errorElement catches and renders the same modal.
 */
let _listener: ((json: unknown) => void) | null = null;
export function triggerUpgradePrompt(body: unknown): void {
  if (_listener) _listener(body);
}

export function useUpgradePrompt(): {
  reason: UpgradeReason | null;
  clear: () => void;
} {
  const [reason, setReason] = React.useState<UpgradeReason | null>(null);

  React.useEffect(() => {
    _listener = (body: unknown) => {
      try {
        const parsed =
          typeof body === 'string' ? JSON.parse(body) : body;
        setReason(parsed as UpgradeReason);
      } catch {
        setReason({
          error: 'plan_feature_locked',
          upgrade_url: '/app/settings/billing',
        });
      }
    };
    return () => {
      _listener = null;
    };
  }, []);

  return {
    reason,
    clear: () => setReason(null),
  };
}

/** Default export = the controlled modal. The hook is a separate named export. */
export default UpgradePrompt;
