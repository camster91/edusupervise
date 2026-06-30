// apps/web/app/routes.ts — RR7 route configuration.
import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  // Public
  index('routes/_index.tsx'),
  route('signup', 'routes/signup.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  route('forgot', 'routes/forgot.tsx'),
  route('reset', 'routes/reset.tsx'),
  route('verify-email', 'routes/verify-email.tsx'),
  route('verify-phone', 'routes/verify-phone.tsx'),
  route('auth/magic', 'routes/auth.magic.tsx'),

  // Onboarding (Phase 2A — Apple HIG spec)
  route('onboarding/teacher', 'routes/onboarding.teacher._index.tsx'),
  route('onboarding/admin', 'routes/onboarding.admin._index.tsx'),

  // Authenticated app shell
  layout('routes/_app.tsx', [
    // Dashboard redirects to Today (Phase 2A)
    route('app', 'routes/_app._index.tsx'),
    // Per-teacher Today view (Phase 2A — load-bearing for Coverage Router)
    route('app/today', 'routes/_app.today._index.tsx'),
    // Roster
    route('app/duties', 'routes/_app.duties._index.tsx'),
    route('app/duties/new', 'routes/_app.duties.new.tsx'),
    route('app/duties/:id', 'routes/_app.duties.$id.tsx'),
    // Calendar
    route('app/calendar', 'routes/_app.calendar._index.tsx'),
    // Coverage Router (Phase 2B)
    route('app/coverage', 'routes/_app.coverage._index.tsx'),
    route('app/coverage/alerts', 'routes/_app.coverage.alerts._index.tsx'),
    // Other authenticated routes
    route('app/assignments', 'routes/_app.assignments._index.tsx'),
    route('app/reminders', 'routes/_app.reminders._index.tsx'),
    route('app/teachers', 'routes/_app.teachers._index.tsx'),
    route('app/settings', 'routes/_app.settings._index.tsx'),
    route('app/settings/billing', 'routes/_app.settings.billing.tsx'),
  ]),

  // Health check (no auth)
  route('api/health', 'routes/api.health.tsx'),

  // Favicon (served as SVG, silently replaces the 404)
  route('favicon.ico', 'routes/favicon[.]ico.ts'),

  // Public signup (3-card /signup page, migration 0006)
  route('api/signup/join', 'routes/api.signup.join.ts'),
  route('api/signup/solo', 'routes/api.signup.solo.ts'),
  route('api/signup/demo', 'routes/api.signup.demo.ts'),

  // Demo reset (authenticated school_admin only)
  route('app/api/demo/reset', 'routes/app.api.demo.reset.ts'),

  // Billing
  route('api/billing/checkout', 'routes/api.billing.checkout.tsx'),
  route('api/billing/portal', 'routes/api.billing.portal.tsx'),
  route('api/billing/webhook', 'routes/api.billing.webhook.tsx'),
  route('api/billing/invoices', 'routes/api.billing.invoices.tsx'),
  route(
    'api/billing/audit-export.csv',
    'routes/api.billing.audit-export[.csv].tsx',
  ),

  // Coverage Router (Phase 2B)
  route('api/coverage/absences', 'routes/api.coverage.absences.ts'),
  route('api/coverage/accept', 'routes/api.coverage.accept.ts'),
  route('api/coverage/decline', 'routes/api.coverage.decline.ts'),
  route('api/coverage/events', 'routes/api.coverage.events.ts'),

  // Parent alerts (Phase 3)
  route('api/coverage/parent-alerts', 'routes/api.coverage.parent-alerts.ts'),
  route('api/coverage/parent-alerts/send', 'routes/api.coverage.parent-alerts.send.ts'),
  route('api/coverage/parent-alerts/cancel', 'routes/api.coverage.parent-alerts.cancel.ts'),
] satisfies RouteConfig;
