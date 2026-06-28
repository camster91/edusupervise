// tests/integration/setup.ts — shared test setup for integration tests.
//
// Spins up a fresh schema in the test database before each test file.
// We rely on the user pre-creating the database and running the init
// scripts (see /scripts/setup-test-db.sh in the deliverable notes).
//
// Vitest loads this once per test file. The singleFork pool option in
// vitest.config.ts ensures tests in a single run share one DB state —
// we wipe the tenant tables (but not the better-auth global tables)
// between tests so they start clean.

import { afterAll, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://edusupervise_runtime:edusupervise_runtime@localhost:5432/edusupervise_auth_rls_test';

let sqlConn: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  sqlConn = postgres(TEST_DATABASE_URL, { max: 5 });
});

afterAll(async () => {
  if (sqlConn) {
    await sqlConn.end({ timeout: 5 });
    sqlConn = null;
  }
});

beforeEach(async () => {
  if (!sqlConn) throw new Error('sqlConn not initialized');
  // Wipe every tenant table + the better-auth session/account/verification
  // tables so each test starts clean. Order: child tables before parents.
  // CASCADE handles FKs.
  await sqlConn.unsafe(`
    TRUNCATE TABLE
      reminder_log, reminders, duty_assignments, duties, cycle_calendar,
      notifications, push_subscriptions, audit_log, users, schools,
      outbox, worker_heartbeats, stripe_events,
      auth_session, auth_account, auth_verification
    RESTART IDENTITY CASCADE;
  `);
});

/** Test helper: get the shared test connection. */
export function getTestSql(): ReturnType<typeof postgres> {
  if (!sqlConn) throw new Error('getTestSql before beforeAll');
  return sqlConn;
}

// Re-export sql for downstream tests that want raw queries.
export { sql };
export { TEST_DATABASE_URL };