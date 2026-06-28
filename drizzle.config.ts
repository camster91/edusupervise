import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from repo root if it exists (developer convenience). Migrations
// run from the repo root in CI, so this also picks up the host's DATABASE_URL.
loadEnv({ path: resolve(process.cwd(), '.env') });

const here = dirname(fileURLToPath(import.meta.url));

/**
 * drizzle-kit config — drives `pnpm db:generate` and `pnpm db:migrate`.
 *
 * `dialect: 'postgresql'` selects the Postgres dialect. `schema` is the source
 * of truth for the schema layout; drizzle-kit reads the TS file and emits a
 * reversible SQL migration under `packages/db/migrations/`.
 *
 * The owner role is used at migration time (it owns tables and can run DDL).
 * The runtime / system roles are NOT used here — they only run app code, and
 * RLS prevents them from issuing DDL anyway.
 *
 * `DATABASE_URL` is required. If it is missing, drizzle-kit will print a
 * clear error pointing at this config file.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: resolve(here, 'packages/db/src/schema.ts'),
  out: resolve(here, 'packages/db/migrations'),
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  },
  // Verbose output helps when debugging the generated migration diffs.
  verbose: true,
  strict: true,
});
