// apps/web/app/routes.ts — RR7 route configuration.
//
// Public auth flows (login, signup, forgot, reset, magic, verify-*).
// API actions (auth.signup, auth.login, auth.logout, auth.forgot,
// auth.reset, auth.magic, auth.verify-email, auth.verify-phone). The
// better-auth catch-all /api/auth/* lives at api.auth.$.tsx.
//
// The actual app shell (/_app.tsx, /_app.* subroutes) is wired in the
// `frontend-shell` task; this file is concerned with public auth only.

import {
  type RouteConfig,
  index,
  route,
} from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),

  // Public auth UI
  route('login', 'routes/login.tsx'),
  route('signup', 'routes/signup.tsx'),
  route('forgot', 'routes/forgot.tsx'),
  route('reset', 'routes/reset.tsx'),
  route('verify-email', 'routes/verify-email.tsx'),
  route('verify-phone', 'routes/verify-phone.tsx'),

  // Auth actions
  route('auth/signup', 'routes/auth.signup.tsx'),
  route('auth/login', 'routes/auth.login.tsx'),
  route('auth/logout', 'routes/auth.logout.tsx'),
  route('auth/forgot', 'routes/auth.forgot.tsx'),
  route('auth/reset', 'routes/auth.reset.tsx'),
  route('auth/magic', 'routes/auth.magic.tsx'),
  route('auth/verify-email', 'routes/auth.verify-email.tsx'),
  route('auth/verify-phone', 'routes/auth.verify-phone.tsx'),

  // Better-auth catch-all (OAuth callbacks, sign-in endpoints, etc.)
  route('api/auth/*', 'routes/api.auth.$.tsx'),
] satisfies RouteConfig;