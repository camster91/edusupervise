// apps/web/app/routes.ts — RR7 route configuration.
//
// Placeholder routing config so the foundation Dockerfile.web can build a
// non-empty route table. The real routing config (per-section route maps
// for /app/* auth-gated routes, public routes, etc.) lands in the
// `frontend-shell` task.

import { type RouteConfig, index } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
] satisfies RouteConfig;