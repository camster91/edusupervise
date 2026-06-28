// apps/web/app/routes.ts — RR7 route configuration.
//
// Wires the public auth routes (login, signup, forgot, reset, magic link,
// email/phone verification) plus the better-auth catch-all at /api/auth/*
// and the logout endpoint. The authenticated app shell (sidebar,
// dashboard, etc.) is added by the `frontend-shell` task.

import {
  type RouteConfig,
  index,
  route,
} from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),

  // ---- Auth (public) ----
  route('login', 'routes/login.tsx'),
  route('signup', 'routes/signup.tsx'),
  route('forgot', 'routes/forgot.tsx'),
  route('reset', 'routes/reset.tsx'),
  route('auth/magic', 'routes/auth.magic.tsx'),
  route('verify-email', 'routes/verify-email.tsx'),
  route('verify-phone', 'routes/verify-phone.tsx'),
  route('auth/logout', 'routes/auth.logout.tsx'),

  // ---- Better-auth REST API ----
  // Catch-all forwards every /api/auth/* request to better-auth's handler.
  route('api/auth/*', 'routes/api.auth.$.tsx'),
] satisfies RouteConfig;