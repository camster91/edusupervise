// apps/web/app/components/DemoBanner.tsx
//
// Sticky banner rendered at the top of every /app/* page when the
// current school has plan='demo'. Shows:
//   - "Demo mode — your school resets in N days."
//   - "Reset demo" button (form-POST to /app/api/demo/reset, CSRF)
//   - "Sign up for real" link to /signup
//
// The component is a no-op for non-demo schools (renders null).

import { Form } from 'react-router';
import { Sparkles, RefreshCw, ExternalLink } from 'lucide-react';
import { useCsrfToken } from '~/lib/csrf';

export interface DemoBannerProps {
  demoExpiresAt: string;       // ISO date string
}

export function DemoBanner({ demoExpiresAt }: DemoBannerProps): React.ReactElement | null {
  const csrfToken = useCsrfToken();
  const expires = new Date(demoExpiresAt);
  const now = new Date();
  const msLeft = expires.getTime() - now.getTime();
  if (Number.isNaN(msLeft)) return null;
  const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 3600 * 1000)));
  const hoursLeft = Math.max(0, Math.ceil((msLeft % (24 * 3600 * 1000)) / (3600 * 1000)));

  return (
    <div className="bg-warning-soft text-warning border-b border-warning/40">
      <div className="max-w-6xl mx-auto px-md py-sm flex items-center gap-md text-callout">
        <Sparkles size={18} aria-hidden className="shrink-0" />
        <p className="flex-1 min-w-0">
          <strong>Demo mode</strong> — your school resets in{' '}
          <strong>
            {daysLeft} {daysLeft === 1 ? 'day' : 'days'}
            {daysLeft === 0 && hoursLeft > 0
              ? `, ${hoursLeft} ${hoursLeft === 1 ? 'hour' : 'hours'}`
              : ''}
          </strong>
          .
        </p>
        <Form method="post" action="/app/api/demo/reset" className="inline">
          <input type="hidden" name="csrf" value={csrfToken} />
          <button
            type="submit"
            className="inline-flex items-center gap-xs px-sm py-xs rounded-md bg-warning text-on-warning hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 font-semibold text-footnote transition-colors duration-fast"
          >
            <RefreshCw size={14} aria-hidden />
            Reset demo
          </button>
        </Form>
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