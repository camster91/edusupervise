# EduSupervise repository guide

**Last audited against source:** 2026-07-22

Read this before changing the repository. Package manifests, CI, schema, and
route registrations are authoritative when this guide and code disagree.

## Product and architecture

EduSupervise schedules K-12 supervision duties, coverage, recurring duties,
and reminders. It is a pnpm workspace with four runtime areas:

- `apps/web`: React Router 7 SSR web app and HTTP/resource routes.
- `apps/worker`: BullMQ reminder and notification worker.
- `apps/mobile`: Expo 52 / React Native companion app.
- `packages/*`: shared DB, schemas, email, SMS, billing, and push packages.

PostgreSQL 16 is the system of record; Redis 7 backs queues/cache. Production
runs Docker Compose behind Traefik. The current web stack is React Router
`~7.18`, React 18, TypeScript 5.6 strict mode, Drizzle `~0.45`, Zod 4,
Tailwind 3, Vitest, and Playwright.

## Current layout

```text
apps/
  web/
    app/routes.ts             explicit route registration
    app/routes/               pages, loaders, actions, resource routes
    app/components/           web UI
    server/                   auth, RLS DB wrappers, services
  worker/src/                 BullMQ process and jobs
  mobile/app/                 Expo Router screens
  mobile/src/                 hooks, components, API/auth helpers
packages/
  db/src/                     Drizzle schema, clients, RLS context helpers
  db/migrations/              generated/applied SQL migrations
  schemas/                    shared validation and job contracts
  email/ sms/ billing-adapter/ push/
db/init/                      fresh-database bootstrap SQL
db/cron/                      nightly SQL jobs
tests/
  e2e/                        Playwright flows
  integration/                DB-backed integration tests
docker/                       Compose and web/worker Dockerfiles
deploy/                       install, backup, health and Traefik assets
docs/                         specs, runbooks, audits
```

## Commands that actually exist

Run from the repository root unless a filter is shown.

```bash
pnpm install --frozen-lockfile
pnpm dev                         # web + worker
pnpm --filter @edusupervise/mobile start

pnpm lint
pnpm typecheck
pnpm test                        # workspace unit tests, non-watch
pnpm test:e2e
pnpm build

pnpm --filter @edusupervise/web test
pnpm --filter @edusupervise/web test:integration
pnpm --filter @edusupervise/web typecheck
pnpm --filter @edusupervise/web build

pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:reset

docker compose -f docker/docker-compose.yml up -d --build
```

CI runs, in order: frozen install, lint, root typecheck, root tests, root build.
Integration and E2E suites require their documented database/runtime setup and
are not part of the default unit-test command.

## Security and data invariants

- Never trust a school/user ID from URL or request JSON for authorization.
  Tenant identity comes from the authenticated session.
- Normal tenant queries run through `withSchool`, `withSchoolId`, or `withUser`
  in `apps/web/server/db.server.ts`. Runtime Postgres uses FORCE RLS.
- `getSystemClient` / the system DB role bypasses RLS. Use it only for explicit
  cross-tenant bootstrap, auth lookup, worker, or operational paths; keep the
  school predicate visible in every tenant-scoped system query.
- Mutations must validate CSRF and input, enforce role/ownership, and write the
  audit row in the same transaction as the state change.
- Session and CSRF cookie names/attributes are centralized in auth/CSRF server
  modules. In production they use `__Host-` rules; do not hardcode cookie names.
- Resource routes return least-privilege projections. Do not expose school-wide
  rows to a teacher/mobile client when the client only needs that user's data.
- Secrets live outside git (`EDUSUPERVISE_SECRETS_DIR`, production default
  `/root/edusupervise-secrets/.env`). Never copy real values into fixtures,
  docs, Compose, or client-visible `EXPO_PUBLIC_*` variables.
- Date-only school concepts are `YYYY-MM-DD` calendar values. Derive "today"
  in the school's IANA timezone and add calendar components, never 86,400,000
  milliseconds and never `toISOString().slice(0, 10)` for local dates.

## Engineering conventions

- TypeScript is strict. Avoid `any`; parse external input as `unknown` and
  validate it with the shared schemas in `packages/schemas` where applicable.
- Keep server-only logic under `apps/web/server`; routes should authenticate,
  delegate, and select the appropriate transport response.
- Shared response/data logic belongs in one server module. For example, web and
  mobile Today routes both use `server/today.server.ts` rather than duplicate
  queries.
- Register new web routes in `apps/web/app/routes.ts` and regenerate route types
  via the web typecheck before declaring the route complete.
- Internal navigation uses React Router `Link`; icon-only controls need an
  accessible name; preserve loading, error, and empty states.
- DB changes require schema plus migration review. Do not hand-edit generated
  metadata casually; verify fresh-DB bootstrap and existing-DB migration paths.
- Add a focused regression test for every bug fix, then run the narrow test and
  the relevant package gates. Report unrelated dirty-tree failures honestly.

## Source-of-truth reading order

1. The affected package's `package.json` and tests.
2. `apps/web/app/routes.ts`, route, and delegated server module.
3. `packages/db/src/schema.ts`, migrations, and RLS helpers for data changes.
4. The relevant file under `docs/superpowers/specs/` for product intent.
5. `docs/runbooks/` and `docker/docker-compose.yml` for operations.

Preserve unrelated work in a dirty tree: no reset, broad stash, checkout-over,
or opportunistic formatting of files outside the task.
