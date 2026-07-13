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
  route('account/delete', 'routes/account.delete.tsx'),  // App Store 5.1.1(v) - request form
  route('account/delete/confirm', 'routes/account.delete.confirm.tsx'),  // App Store 5.1.1(v) - token consumption
  // Internal: daily cron for hard-deleting users past 30-day grace period
  route('api/admin/purge-account-deletions', 'routes/api.admin.purge-account-deletions.tsx'),  // X-Cron-Secret auth
  route('auth/magic', 'routes/auth.magic.tsx'),

  // Onboarding (Phase 2A — Apple HIG spec)
  route('onboarding/teacher', 'routes/onboarding.teacher._index.tsx'),
  route('onboarding/admin', 'routes/onboarding.admin._index.tsx'),
  // Phase 2 (2026-07-04) — PDF schedule ingestion review UI.
  route('onboarding/pdf-review', 'routes/onboarding.pdf-review._index.tsx'),
  // Phase 2 — PDF upload entry (audit B9, 2026-07-04). Without this
  // route the upload API was orphaned: no client UI called it. Now
  // /onboarding/upload-pdf is the missing front door.
  route('onboarding/upload-pdf', 'routes/onboarding.upload-pdf._index.tsx'),
  // Phase 1 — solo teacher / EA wizard.
  route('onboarding/solo', 'routes/onboarding.solo._index.tsx'),

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
    route('app/calendar/print', 'routes/_app.calendar.print.tsx'),
    // Coverage Router (Phase 2B)
    route('app/coverage', 'routes/_app.coverage._index.tsx'),
    route('app/coverage/alerts', 'routes/_app.coverage.alerts._index.tsx'),
    // Phase 3 §3.2 — recurring duties CRUD page.
    route('app/recurring', 'routes/_app.recurring._index.tsx'),
    // Other authenticated routes
    route('app/assignments', 'routes/_app.assignments._index.tsx'),
    route('app/reminders', 'routes/_app.reminders._index.tsx'),
    route('app/teachers', 'routes/_app.teachers._index.tsx'),
    route('app/settings', 'routes/_app.settings._index.tsx'),
    route('app/settings/billing', 'routes/_app.settings.billing.tsx'),
  ]),

  // Health probes (no auth). /healthz + /health share one handler
  // (DB ping + uptime) and resolve under the standard K8s/Docker
  // probe paths. /api/health stays as the legacy JSON endpoint
  // used by the docker-compose healthcheck (audit B11, 2026-07-04).
  // Explicit `id:` so each path maps to a distinct RR7 route ID,
  // not a collision from the shared file path (audit B11).
  route('healthz', 'routes/healthz.tsx', { id: 'healthz' }),
  route('health', 'routes/healthz.tsx', { id: 'health' }),
  route('api/health', 'routes/api.health.tsx'),
  // Prometheus scrape endpoint (anonymous; restrict at firewall).
  // Excludes itself from the HTTP histogram (see recordHttpRequest
  // call site in entry.server.tsx) (audit B10, 2026-07-04).
  route('metrics', 'routes/metrics.tsx'),

  // Favicon (served as SVG, silently replaces the 404)
  route('favicon.ico', 'routes/favicon[.]ico.ts'),

  // Public signup (3-card /signup page, migration 0006)
  route('api/signup/join', 'routes/api.signup.join.ts'),
  route('api/signup/solo', 'routes/api.signup.solo.ts'),
  route('api/signup/demo', 'routes/api.signup.demo.ts'),
  // Phase 1.2 — wizard final-submit endpoint.
  route('api/onboarding/solo', 'routes/api.onboarding.solo.ts'),
  // Phase 2 (2026-07-04) — PDF schedule ingestion.
  route('api/onboarding/upload-pdf', 'routes/api.onboarding.upload-pdf.ts'),
  route('api/onboarding/confirm-pdf', 'routes/api.onboarding.confirm-pdf.ts'),

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
  // Phase 3 §3.4 — broadcast coverage to all eligible teachers.
  route('api/coverage/broadcast', 'routes/api.coverage.broadcast.ts'),

  // Duty quick actions (Phase 2C — Today redesign)
  route('app/api/duty.complete', 'routes/app.api.duty.complete.ts'),

  // Reminders (Phase 2D — inline CRUD on duty cards)
  route('app/api/reminders/create', 'routes/app.api.reminders.create.ts'),
  route('app/api/reminders/toggle', 'routes/app.api.reminders.toggle.ts'),
  route('app/api/reminders/delete', 'routes/app.api.reminders.delete.ts'),

  // Parent alerts (Phase 3)
  route('api/coverage/parent-alerts', 'routes/api.coverage.parent-alerts.ts'),
  route('api/coverage/parent-alerts/send', 'routes/api.coverage.parent-alerts.send.ts'),
  route('api/coverage/parent-alerts/cancel', 'routes/api.coverage.parent-alerts.cancel.ts'),

  // Phase 3 — PDF calendar import (admin-only).
  route('admin/calendar', 'routes/admin.calendar._index.tsx'),
  route('api/admin/calendar/import', 'routes/api.admin.calendar.import.ts'),
  route('api/admin/calendar/commit', 'routes/api.admin.calendar.commit.ts'),
  // Phase 2 — admin-only debug route for firing test notifications.
  route('api/notifications/test', 'routes/api.notifications.test.ts'),
  // Public legal pages (App Store Connect URLs).
  route('privacy', 'routes/privacy.tsx'),
  route('support', 'routes/support.tsx'),
  // Public release timeline (prebuilt from git log on every build).
  route('changelog', 'routes/changelog.tsx'),
  // Phase 2 — push notification subscription registration (web + iOS).
  route('api/push/register', 'routes/api.push.register.ts'),
  route('api/push/vapid-public-key', 'routes/api.push.vapid-public-key.ts'),
] satisfies RouteConfig;
