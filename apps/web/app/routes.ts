// apps/web/app/routes.ts — RR7 route configuration.
import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  // Public
  index('routes/_index.tsx'),
  route('signup', 'routes/signup.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),

  // Password reset + magic link + verifications
  // (spec section 5: tokens in URL fragment, consumed via POST)
  route('forgot', 'routes/forgot.tsx'),
  route('reset', 'routes/reset.tsx'),
  route('auth/magic', 'routes/auth.magic.tsx'),
  route('verify-email', 'routes/verify-email.tsx'),
  route('verify-phone', 'routes/verify-phone.tsx'),

  // Authenticated app shell
  layout('routes/_app.tsx', [
    route('app', 'routes/_app._index.tsx'),
    route('app/duties', 'routes/_app.duties._index.tsx'),
    route('app/duties/new', 'routes/_app.duties.new.tsx'),
    route('app/duties/:id', 'routes/_app.duties.$id.tsx'),
    route('app/calendar', 'routes/_app.calendar._index.tsx'),
    route('app/assignments', 'routes/_app.assignments._index.tsx'),
    route('app/reminders', 'routes/_app.reminders._index.tsx'),
    route('app/teachers', 'routes/_app.teachers._index.tsx'),
    route('app/settings', 'routes/_app.settings._index.tsx'),
    route('app/settings/billing', 'routes/_app.settings.billing.tsx'),
  ]),

  // Health check (no auth)
  route('api/health', 'routes/api.health.tsx'),

  // Billing — spec section 6
  route('api/billing/checkout', 'routes/api.billing.checkout.tsx'),
  route('api/billing/portal', 'routes/api.billing.portal.tsx'),
  route('api/billing/webhook', 'routes/api.billing.webhook.tsx'),
  route('api/billing/invoices', 'routes/api.billing.invoices.tsx'),
  // Audit-export CSV: the `[.csv]` filename escape becomes a literal
  // `.csv` in the URL (RR7 file-based routing convention).
  route(
    'api/billing/audit-export.csv',
    'routes/api.billing.audit-export[.csv].tsx',
  ),
] satisfies RouteConfig;