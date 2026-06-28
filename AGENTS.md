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
