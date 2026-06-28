# EduSupervise

Multi-tenant SaaS for K-12 schools to schedule teacher supervision duties (before/after school, recess, lunch, bus dismissal) and dispatch reminders to staff.

Built on **React Router 7**, **PostgreSQL 16**, **Drizzle ORM**, **BullMQ**, **Resend**, **Twilio**, **Stripe**.

## Status

Tier 1 (MVP-launchable) is the active build target. Spec at [`docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md`](docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md).

## Quick links

- [Design spec](docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md) — what we're building and why
- [AGENTS.md](AGENTS.md) — conventions for AI coding agents working in this repo
- [License](LICENSE) — MIT

## Local dev (planned)

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres redis
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Deploy

Self-hosted on the EduSupervise VPS via Traefik. See `deploy/traefik/` for the dynamic router snippet.
