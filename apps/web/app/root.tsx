// apps/web/app/root.tsx — RR7 root component.
//
// This is the minimal placeholder root so the foundation Dockerfile.web can
// build. The real app shell, theme handling, error boundary, and global
// styles are wired up by the `frontend-shell` task.
//
// What this stub provides:
// - <Meta /> / <Links /> / <Scripts /> for document head + hydration
// - <Outlet /> for child routes
// - A barebones html shell (title, body) — replace with full theme in shell task

import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  // Minimal error boundary — replaced by frontend-shell task.
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>EduSupervise — error</title>
        <Meta />
        <Links />
      </head>
      <body>
        <p>Something went wrong. Refresh the page or contact your school admin.</p>
        <Scripts />
      </body>
    </html>
  );
}