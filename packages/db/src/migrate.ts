/**
 * migrate.ts — programmatic migration runner for EduSupervise.
 *
 * Replaces the manual `psql -f ...` workflow that was used before
 * 2026-06-30 (audit slice-6 RED-1: `migrate.ts missing`). Now deploys
 * can run `pnpm --filter @edusupervise/db db:migrate` from any host
 * that has DATABASE_URL pointing at the target Postgres, and the
 * migrator applies every SQL file in `packages/db/migrations/`
 * that hasn't already been applied.
 *
 * Idempotent: drizzle tracks applied migrations in
 * `__drizzle_migrations`. Running twice = no-op for already-applied
 * entries; only NEW migrations run.
 *
 * Safe in production: this script never drops, truncates, or
 * otherwise mutates existing data — it only runs additive DDL.
 * (Migrations that need to drop + recreate a column should be
 * authored as multi-step migrations, not as single destructive
 * statements, so a failed migration leaves the schema in a
 * recoverable state.)
 *
 *   $ DATABASE_URL=postgres://owner:...@host:5432/db pnpm db:migrate
 *
 * Drizzle's migrator requires the migrations folder to contain a
 * `meta/_journal.json` listing every SQL file by tag. The journal
 * must be kept in sync with the migration files — when adding a new
 * migration, run `pnpm db:generate` (drizzle-kit) which updates both
 * the SQL file and the journal atomically.
 */
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Load .env from repo root if it exists (dev convenience). In prod,
// DATABASE_URL is injected by the platform — we don't require the file.
try {
  loadEnv({ path: resolve(here, '../../../.env') });
} catch {
  // dotenv throws if file doesn't exist; that's fine in prod.
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'migrate: DATABASE_URL is not set. ' +
      'Export DATABASE_URL=postgres://edusupervise_owner:...@host:5432/db and retry.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const sql = postgres(databaseUrl!, { max: 1 });
  const db = drizzle(sql);

  const migrationsFolder = resolve(here, '../migrations');
  console.log(`migrate: applying pending migrations from ${migrationsFolder}`);

  try {
    await migrate(db, { migrationsFolder });
    console.log('migrate: done.');
  } catch (err) {
    console.error('migrate: failed:', err);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();