// apps/web/app/components/DemoBanner.tsx
//
// Sticky banner rendered at the top of every /app/* page when the
// current school has plan='demo'. Shows:
//   - "Demo mode — your school resets in N days."
//   - "Reset demo" button (form-POST to /app/api/demo/reset, CSRF)
//   - "Sign up for real" link to /signup
//
// "Reset demo" is destructive — it wipes ALL tenant data and re-seeds.
// Added a confirm modal (track-1 follow-up, 2026-06-30) so accidental
// clicks don't nuke hours of teacher data.

import { useState } from 'react';
import { useClientNow } from '../../lib/useClientNow';
import { Form } from 'react-router';
import { Sparkles, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';

export interface DemoBannerProps {
  demoExpiresAt: string;  // ISO-8601 from server       // ISO date string
  /**
   * CSRF token to write into the reset form's hidden field. Caller
   * MUST pass this from loader data (read server-side from the
   * request cookie). We can't read the `__Host-` cookie from JS.
   */
  csrfToken: string;
}

export function DemoBanner({ demoExpiresAt, csrfToken }: DemoBannerProps): React.ReactElement | null {
  const expires = new Date(demoExpiresAt);
  const now = useClientNow();
  const msLeft = expires.getTime() - (now?.getTime() ?? 0);
  if (Number.isNaN(msLeft)) return null;
  const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 3600 * 1000)));
  const hoursLeft = Math.max(0, Math.ceil((msLeft % (24 * 3600 * 1000)) / (3600 * 1000)));

  return (
    <div className="bg-warning-soft text-warning border-b border-warning/40">
      <div className="max-w-6xl mx-auto px-md py-sm flex items-center gap-sm md:gap-md text-callout">
        <Sparkles size={18} aria-hidden className="shrink-0 hidden sm:block" />
        <p className="flex-1 min-w-0 truncate">
          <strong>Demo mode</strong>
          <span className="hidden sm:inline"> — your school resets in{' '}</span>
          <strong>
            {daysLeft} {daysLeft === 1 ? 'day' : 'days'}
            {daysLeft === 0 && hoursLeft > 0
              ? `, ${hoursLeft} ${hoursLeft === 1 ? 'hour' : 'hours'}`
              : ''}
          </strong>
          <span className="hidden sm:inline">.</span>
        </p>
        <ResetDemoButton csrfToken={csrfToken} />
        <a
          href="/signup"
          className="hidden md:inline-flex items-center gap-xs text-footnote font-semibold text-warning hover:underline"
        >
          Real signup
          <ExternalLink size={14} aria-hidden />
        </a>
      </div>
    </div>
  );
}

/**
 * "Reset demo" — destructive button. Opens a confirm modal before
 * submitting. The form posts to /app/api/demo/reset, which wipes all
 * tenant data for the current school and re-seeds Sunrise Elementary.
 *
 * Why a confirm modal (vs single-click): track-1 walkthrough found
 * that a single-click reset is too easy to hit by accident. Wiping a
 * working demo school because the admin clicked the wrong button is
 * a real footgun.
 */
function ResetDemoButton({ csrfToken }: { csrfToken: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-xs px-sm py-xs rounded-md bg-warning text-on-warning hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 font-semibold text-footnote transition-colors duration-fast"
      >
        <RefreshCw size={14} aria-hidden />
        Reset demo
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-demo-title"
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center px-md"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-w-md w-full bg-surface rounded-2xl border border-border shadow-elev-2 p-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              aria-hidden
              className="mx-auto w-12 h-12 rounded-full bg-warning-soft grid place-items-center mb-md"
            >
              <AlertTriangle size={24} className="text-warning" />
            </div>
            <h2
              id="reset-demo-title"
              className="text-title-2 text-primary font-bold text-center mb-sm"
            >
              Reset demo school?
            </h2>
            <p className="text-callout text-secondary text-center mb-lg">
              This <strong>wipes all current demo data</strong> — every teacher,
              duty, coverage event, parent alert — and re-seeds Sunrise Elementary
              from scratch. Cannot be undone.
            </p>
            <Form
              method="post"
              action="/app/api/demo/reset"
              className="space-y-sm"
            >
              <input type="hidden" name="csrf" value={csrfToken} />
              <div className="flex flex-col-reverse sm:flex-row gap-sm">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 h-btn-md rounded-md font-medium bg-surface-2 text-primary border border-border hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 h-btn-md rounded-md font-semibold bg-warning text-on-warning hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 transition-colors duration-fast inline-flex items-center justify-center gap-sm"
                >
                  <RefreshCw size={16} aria-hidden />
                  Yes, reset everything
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </>
  );
}