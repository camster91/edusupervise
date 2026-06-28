// tests/integration/setup.ts — vitest global setup.
//
// Reads the test env vars (DATABASE_URL, SYSTEM_DATABASE_URL, BETTER_AUTH_SECRET)
// and exports them as process.env defaults if not already set. The integration
// tests use the local Postgres set up by `setup-local-postgres.sh`.
//
// Why a setup file instead of inline env:
//   - The same env is consumed by both the auth.server.ts (better-auth) and
//     the test harness (direct DB inserts). One source of truth = no drift.
//   - Vitest's setupFiles runs before any test, so the env is hot by the
//     time the auth.server singleton first reads it.

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Repo-root .env (created by setup-local-postgres.sh output). Fall back
// to sensible defaults if not present (so `pnpm test:integration`
// "just works" on a fresh dev box after running the setup script).
loadEnv({ path: resolve(here, '../../.env.test') });
loadEnv({ path: resolve(here, '../../.env') });

const DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgres://edusupervise_runtime:testpw@localhost:5432/edusupervise',
  SYSTEM_DATABASE_URL: 'postgres://edusupervise_system:testpw@localhost:5432/edusupervise',
  OWNER_DATABASE_URL: 'postgres://edusupervise_owner:testpw@localhost:5432/edusupervise',
  SESSION_SECRET: 'integration-test-session-secret-do-not-use-in-prod-32chars-min',
  BETTER_AUTH_SECRET: 'integration-test-secret-do-not-use-in-prod-32chars-min',
  APP_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
};

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!process.env[k]) process.env[k] = v;
}