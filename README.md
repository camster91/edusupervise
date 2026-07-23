# EduSupervise

EduSupervise is a K-12 supervision platform for scheduling teacher and
educational-assistant duties, coordinating coverage, and dispatching reminders.
It includes a React Router web app, BullMQ worker, and Expo mobile companion.

## Repository status

The repository is an active pnpm monorepo, not a planned scaffold. Product
intent lives in
[`docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md`](docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md),
but current manifests, route registrations, schema, tests, and runbooks are the
source of truth for implemented behavior.

## Stack

- React Router 7 SSR, React 18, TypeScript strict mode
- Expo 52 / React Native mobile companion
- PostgreSQL 16, Drizzle ORM, FORCE RLS tenant isolation
- Redis 7 and BullMQ workers
- Resend, Twilio, Stripe, and Expo Push adapters
- Vitest unit/integration tests and Playwright E2E tests
- Docker Compose deployment behind Traefik

## Workspace

```text
apps/web       web UI, routes, server services
apps/worker    reminder/notification worker
apps/mobile    Expo Router mobile app
packages/      DB, schemas, email, SMS, billing, push
 db/           bootstrap and cron SQL
 docker/       production-like local/host stack
 deploy/       install, backup, health, Traefik assets
 docs/         specs, audits, runbooks
```

See [AGENTS.md](AGENTS.md) for the audited layout, security invariants, and
contribution workflow.

## Local development

Requirements: Node 20+, pnpm 9+, Docker, and the environment values required by
the web/worker packages.

```bash
pnpm install --frozen-lockfile
docker compose -f docker/docker-compose.yml up -d postgres redis
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The root `dev` command starts web and worker. Start mobile separately:

```bash
pnpm --filter @edusupervise/mobile start
```

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Focused web commands:

```bash
pnpm --filter @edusupervise/web test
pnpm --filter @edusupervise/web test:integration
pnpm --filter @edusupervise/web typecheck
pnpm --filter @edusupervise/web build
```

The integration and E2E suites need their documented database/runtime setup;
unit tests do not.

## Database

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:reset
```

Tenant reads and writes must use the RLS-aware wrappers in
`apps/web/server/db.server.ts`. Do not use the system/BYPASSRLS client as a
shortcut for request-path queries.

## Deployment

Production topology is defined by `docker/docker-compose.yml` and deployment
assets under `deploy/`. Secrets are loaded from the external
`EDUSUPERVISE_SECRETS_DIR` (production default:
`/root/edusupervise-secrets`) and must never be committed.

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Use the runbooks under `docs/runbooks/` for production operations rather than
treating the Compose command alone as a complete deploy procedure.

## Documentation

- [Agent/contributor guide](AGENTS.md)
- [Product rebuild spec](docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md)
- [Current comprehensive review](docs/audits/2026-07-22-comprehensive-review.md)
- [License](LICENSE) — MIT
