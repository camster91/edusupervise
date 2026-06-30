// apps/web/app/components/ExpiredDemo.tsx
//
// Full-screen "your demo expired" page. Rendered by the loader on
// every /app/* route when the school's plan='demo_expired'.
//
// Two actions:
//   - "Restart demo" → POST /app/api/demo/reset (form, CSRF-protected)
//   - "Sign up for real" → /signup

import { Form } from 'react-router';
import { Clock, Sparkles, RefreshCw, ExternalLink } from 'lucide-react';
import { useCsrfToken } from '~/lib/csrf';

export function ExpiredDemo(): React.ReactElement {
  const csrfToken = useCsrfToken();
  return (
    <div className="min-h-[60vh] grid place-items-center px-md">
      <div className="max-w-md w-full bg-surface rounded-2xl border border-border shadow-elev-2 p-2xl text-center">
        <div
          aria-hidden
          className="mx-auto w-16 h-16 rounded-full bg-warning-soft grid place-items-center mb-xl"
        >
          <Clock size={32} className="text-warning" />
        </div>
        <h1 className="text-title-1 text-primary font-bold">
          Your demo has expired.
        </h1>
        <p className="text-callout text-secondary mt-md">
          Your 30-day sandbox ended. Restart it for another 30 days, or sign up
          for real to keep your school going.
        </p>

        <Form method="post" action="/app/api/demo/reset" className="mt-2xl">
          <input type="hidden" name="csrf" value={csrfToken} />
          <button
            type="submit"
            className="w-full h-btn-md rounded-md font-semibold bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast inline-flex items-center justify-center gap-sm"
          >
            <RefreshCw size={18} aria-hidden />
            Restart demo
          </button>
        </Form>

        <a
          href="/signup"
          className="mt-md w-full h-btn-md rounded-md font-semibold bg-surface-2 text-primary border border-border hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast inline-flex items-center justify-center gap-sm"
        >
          <Sparkles size={18} aria-hidden />
          Sign up for real
          <ExternalLink size={16} aria-hidden />
        </a>
      </div>
    </div>
  );
}