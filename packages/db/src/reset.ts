/**
 * Dev-only reset — drops the public schema and lets the init SQL +
 * migrations rebuild it from scratch.
 *
 * ⚠️  NEVER run in production. There is no `WHERE` clause and no
 *     confirmation prompt. This exists so a developer with a busted
 *     local database can `pnpm db:reset` and get a clean state.
 *
 *   $ pnpm db:reset    # drops + migrates + seeds
 *
 * Implementation: the `db/init/` scripts create the schema (including
 * RLS) on first boot, and `db:migrate` runs the drizzle-kit migrations
 * on top. We can't easily drop individual tables because of FK
 * constraints + RLS, so we drop the whole `public` schema and re-run
 * init + migrations. Re-seeding is then a no-op for the plan_limits
 * rows (idempotent ON CONFLICT) and creates the demo school on a fresh
 * database.
 */
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(here, '../../../.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'reset: DATABASE_URL is not set. ' +
      'Export DATABASE_URL=postgres://edusupervise_owner:...@host:5432/db and retry.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'reset: refusing to run with NODE_ENV=production. ' +
        'This script drops the public schema and is for dev only.',
    );
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    console.log('reset: dropping public schema ...');
    await sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
    await sql.unsafe(`CREATE SCHEMA public`);
    // Re-grant usage on the new schema to the runtime + system roles.
    // Init script 00-create-roles.sh handles this on first boot, but
    // since we just dropped public we have to redo it here.
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO PUBLIC`);
    console.log('reset: done. Run `pnpm db:migrate` to apply migrations.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('reset: failed:', err);
  process.exit(1);
});
