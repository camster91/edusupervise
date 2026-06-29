// apps/web/app/root.tsx — RR7 root component with Apple-HIG design
// system shell. Wired up by the Phase 2A UI refactor.
//
// What this file owns:
//   - <html> document scaffolding: head, meta, scripts, scroll restore.
//   - Per-school design tokens via inline style on the <html> element.
//     The accent color is sourced from `loaderData`; if absent the
//     defaults from tokens.css apply.
//   - Inter font preconnect + stylesheet (Google Fonts CDN; self-host
//     via @fontsource/inter is a follow-up).
//   - Toast provider + listener so any route can call `toast(...)`
//     to surface notifications.
//   - The error boundary that catches ANY uncaught throw anywhere in
//     the route tree.
//
// Per design system spec §1 (Foundations) and §6 (File structure).

import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from 'react-router';
import { ThemeStyle, ToastListener, ToastProvider, ToastViewport } from './components';
import { accentFor } from './lib/theme';
import type { Route } from './+types/root';

import './styles/globals.css';

/**
 * Fonts + design-token preloads. Inter is loaded from Google Fonts
 * (the spec calls for self-hosting via @fontsource/inter as a follow-up
 * once the dependency lands in package.json). The preconnect hints
 * shave ~100ms off the first paint.
 */
export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
];

/**
 * Root loader — runs on every navigation and refresh. Cheap to call:
 * it doesn't touch the DB unless the route does. Its single job is to
 * supply the school accent color so the very first paint already has
 * the correct brand color (no FOUC).
 *
 * If we add a session-aware context here later, we can pull
 * `schools.accent_color` and inject it; for now we fall back to the
 * default (Apple system blue) from tokens.css.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<{
  accent: string;
  requestId: string;
}> {
  const requestId = request.headers.get('x-request-id') ?? 'root';
  const accent = accentFor(null);
  return { accent, requestId };
}

export function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-bg text-primary antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
        <ToastViewport />
      </body>
    </html>
  );
}

export default function App(): React.ReactElement {
  const { accent } = useLoaderData<typeof loader>();
  return (
    <ThemeStyle accent={accent}>
      <ToastProvider>
        <Outlet />
        <ToastListener />
      </ToastProvider>
    </ThemeStyle>
  );
}

/**
 * Default UI for uncaught errors. Renders a friendly page with a
 * "Refresh" button that triggers a full reload via
 * `window.location.reload` — RR7's `<Form>` doesn't have a recovery
 * flow here because we don't have a session context to lean on.
 *
 * Server-side errors are logged from `entry.server.tsx`'s per-request
 * pino child logger; this boundary runs in the browser and only has
 * client-side state to work with, so the message is surfaced in the
 * dev pre tag.
 */
export function ErrorBoundary({ error }: { error: unknown }): React.ReactElement {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.';
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>EduSupervise — error</title>
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-bg flex items-center justify-center px-md">
        <div className="max-w-md bg-surface rounded-xl border border-border shadow-elev-1 p-2xl text-center">
          <div className="text-display mb-md" aria-hidden>⚠️</div>
          <h1 className="text-title-2 text-primary mb-sm">
            Something went wrong
          </h1>
          <p className="text-callout text-secondary mb-lg">
            We hit an unexpected error rendering this page. The team has
            been notified — please refresh to try again.
          </p>
          {message && process.env.NODE_ENV !== 'production' && (
            <pre className="text-left text-footnote text-secondary bg-surface-2 rounded-md p-md overflow-x-auto mb-lg text-left">
              {message}
            </pre>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center h-btn-md px-xl rounded-md font-medium text-on-accent bg-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            Refresh page
          </button>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
