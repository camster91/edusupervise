// apps/web/app/routes.ts — RR7 route configuration.
import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  // Public
  index('routes/_index.tsx'),
  route('signup', 'routes/signup.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),

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
  ]),

  // Health check (no auth)
  route('api/health', 'routes/api.health.tsx'),
] satisfies RouteConfig;