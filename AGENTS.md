# AGENTS.md

This file tells AI coding agents (and humans) how to work in this repo. Read it before making changes.

## What this is

EduSupervise — multi-tenant SaaS for K-12 schools to schedule teacher supervision duties (before/after school, recess, lunch, bus dismissal) and dispatch reminders to staff.

Single deployment = one school per database instance. Multi-school SaaS lives on Tier 3 (district-level tenancy).

## Stack (pinned)

| Layer | Choice | Version |
|-------|--------|---------|
| Meta-framework | React Router 7 (Remix successor) | ^7.1.0 |
| Language | TypeScript (strict) | ^5.6.0 |
| UI | React 18 + Radix UI + Tailwind 3 + lucide-react | ^18.3.0 |
| Forms | react-hook-form + zod | ^7.53 / ^3.23 |
| Data fetching | @tanstack/react-query | ^5.59 |
| ORM | Drizzle ORM | ^0.36 |
| DB | PostgreSQL 16 | — |
| Cache / queue | Redis 7 + BullMQ | ^5.21 |
| Auth | better-auth | ^1.0 |
| Validation | zod (shared schemas in `app/schemas/`) | ^3.23 |
| Email | Resend | ^4.0 |
| SMS | Twilio | ^5.3 |
| Billing | Stripe | ^17.0 |
| Logger | pino | ^9.5 |
| Tests | Vitest + Playwright | ^2.1 / ^1.48 |
| Container | Docker | — |

## Repo layout

```
edusupervise/
├── app/                    # React Router 7 app (routes, components, loaders, actions)
│   ├── routes/             # File-based routes
│   ├── components/         # UI components (shell, duties, calendar, ui/)
│   ├── lib/                # Shared client helpers (api client, format, errors)
│   ├── schemas/            # Zod schemas shared client + server
│   └── styles/
├── server/                 # Express/Fastify glue (rare — most logic is in app/)
│   ├── auth.ts             # better-auth config
│   ├── db.ts               # Drizzle client + RLS helper
│   ├── queue.ts            # BullMQ producer
│   ├── billing.ts          # Stripe webhook handlers
│   ├── email.ts            # Resend client + templates
│   └── sms.ts              # Twilio client
├── worker/                 # BullMQ worker process (separate container)
│   ├── index.ts            # Worker entrypoint
│   └── jobs/
│       └── reminders.ts
├── db/                     # Drizzle schema + migrations
│   ├── schema.ts           # All tables, RLS policies
│   ├── migrations/         # Generated SQL
│   └── seed.ts
├── tests/                  # Vitest + Playwright
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── docker/
│   ├── Dockerfile.web
│   ├── Dockerfile.worker
│   └── docker-compose.yml
├── deploy/
│   └── traefik/            # Traefik dynamic router snippet
├── docs/
│   └── superpowers/
│       └── specs/          # Design specs (this directory)
└── .harness/               # Multi-agent team config (created on demand)
```

## Conventions

- **TypeScript strict.** No `any` unless absolutely necessary and commented.
- **Zod schemas live in `app/schemas/`.** Same schema validates client form + server action.
- **All mutations go through React Router actions or server-side fetch handlers.** Never mutate from client components directly.
- **Multi-tenancy is enforced by Postgres RLS.** Every table has `school_id NOT NULL`. Every query goes through the RLS-aware Drizzle wrapper that sets `app.school_id` per request. Application code MUST NOT bypass RLS.
- **Audit log every state change.** Every mutation writes to `audit_log` in the same transaction.
- **Use `<Link>` from react-router for internal navigation.** Plain `<a>` only for external links.
- **All buttons that are icon-only need `aria-label`.** Always.
- **Secrets live in `/root/edusupervise-secrets/.env` on the VPS**, never committed.

## Commands

```bash
# Dev
pnpm install
pnpm dev                    # runs web + worker together
pnpm test                   # vitest watch
pnpm test:e2e               # playwright

# DB
pnpm db:generate            # drizzle-kit generate
pnpm db:migrate             # drizzle-kit migrate
pnpm db:seed                # demo school + admin

# Deploy
docker compose -f docker/docker-compose.yml up -d --build
```

## When in doubt

Read `docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md` first — it's the source of truth for what we're building and why.

## Cursor Cloud specific instructions

Context for future cloud agents. The update script (`pnpm install` + `pnpm build`) runs on startup; system deps (PostgreSQL 16, Redis 7), the provisioned DB, and the local `.env` files persist in the VM snapshot, so you do NOT need to reinstall or re-provision them.

- **Real layout is a monorepo:** `apps/web` (React Router 7 SSR, dev port **3011**), `apps/worker` (BullMQ consumer, no HTTP port), and `packages/*` (`db`, `schemas`, `email`, `sms`, `billing-adapter`). The layout table earlier in this file (`app/`, `server/`, `worker/`, `db/` at root) is outdated — trust `pnpm-workspace.yaml`.
- **Workspace packages must be built before running apps.** The apps import `@edusupervise/db` etc. from each package's `dist/`, so `pnpm build` (builds `packages/*` via tsc) must run after install or the web app/tests fail with "Failed to resolve entry for package @edusupervise/db". This is why `pnpm build` is in the update script.
- **Start infra each boot (no systemd here):** `sudo pg_ctlcluster 16 main start` and `sudo redis-server --daemonize yes --appendonly yes --dir /var/lib/redis-edusupervise`. Postgres roles/db/schema/seed already exist in the snapshot; do not re-run migrations unless you dropped the DB.
- **Env is not auto-loaded in dev.** `react-router dev` (Vite) does NOT load `.env` into server `process.env`. Export it first, e.g. `set -a; . ./apps/web/.env; set +a` before `pnpm --filter @edusupervise/web dev` (and `apps/worker/.env` for the worker). Root `.env` (owner role) is auto-loaded only by the drizzle `db:*` scripts.
- **DB bootstrap is a hybrid (do NOT rely on `pnpm db:migrate` on a fresh DB).** The programmatic migrator chokes on repo bugs: `0000_init.sql` has `jobs_completed bigserial DEFAULT 0` (invalid on PG16) and `0006_signup_and_demo.sql` contains a psql `\set` directive. The working path (already applied in the snapshot): run `db/init/02-schema.sql` + `db/init/03-seed.sql` as `edusupervise_owner`, then apply `packages/db/migrations/*.sql` in order via `psql -f` (the `CREATE TABLE IF NOT EXISTS` clauses skip the buggy base statements). Result = 27 tables.
- **`pnpm db:seed` is broken under tsx** (`bcryptjs` has no named `hash` export in ESM). Demo data was seeded via SQL instead. Demo login: `admin@maple.test` / `password123` (school "Maple Elementary"). The app's own `auth.server.ts` uses the correct default import, so the running app is unaffected.
- **The dev server UI does not work in a browser over plain http (two dev-only code bugs, not env issues):** (1) `apps/web/app/root.tsx` reads `process.env.PLAUSIBLE_DOMAIN` in the `Layout` component → `ReferenceError: process is not defined` on client hydration; (2) the `__Host-edusupervise.csrf` cookie omits `Secure` in dev, so browsers/curl reject it and login returns 403. Both are fixed in the production build (Vite replaces `process.env`; `NODE_ENV=production` adds `Secure`). To exercise the UI in a browser, serve the production build (`react-router-serve ./build/server/index.js` with `NODE_ENV=production`) behind an HTTPS proxy. To drive the real dev-server handlers from the terminal, set the CSRF cookie manually (server does a double-submit compare: `Cookie: __Host-edusupervise.csrf=<t>` + form field `csrf=<t>` + an `Origin` header).
- **`pnpm lint` is broken repo-wide:** ESLint 9 requires an `eslint.config.js` flat config that does not exist anywhere in the repo. Use `pnpm --filter <pkg> typecheck` for static checking instead.
- **Providers default to `mock`** (email/SMS/billing) — no external accounts needed for local dev.
