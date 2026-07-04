// apps/web/vitest.setup.ts — global setup for unit tests.
//
// Goals:
//   1. Load env from .env.test / .env so tests that DON'T mock every
//      env var (e.g. logger.server reads LOG_LEVEL) don't crash on
//      undefined. Integration tests do this in their own setup.ts;
//      we duplicate the defaults here so unit tests are independent.
//   2. Set NODE_ENV='test' so modules that branch on it (verify-phone
//      in particular) hit their dev fallback unless the test
//      explicitly opts in to production behaviour.
//   3. Silence logger.server — we don't want pino dumping JSON in
//      test output.
//
// Why not just rely on vitest's setupFiles:
//   - The integration config uses a different setupFiles entry. Keeping
//     a unit-test-specific setup avoids accidental cross-contamination
//     (integration tests need real DATABASE_URL; unit tests don't).

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(here, '../../.env.test') });
loadEnv({ path: resolve(here, '../../.env') });

const DEFAULTS: Record<string, string> = {
  // Placeholder values are fine — tests that need real DB calls
  // mock @edusupervise/db entirely. Tests that read these env vars
  // (verify-phone, reminders) get the placeholder and branch on
  // NODE_ENV instead.
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  SYSTEM_DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  SESSION_SECRET: 'unit-test-session-secret-32chars-min-padding-aaaa',
  BETTER_AUTH_SECRET: 'unit-test-secret-32chars-min-padding-aaaaaaaa',
  APP_URL: 'http://localhost:3011',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
};

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!process.env[k]) process.env[k] = v;
}