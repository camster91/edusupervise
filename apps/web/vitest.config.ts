// apps/web/vitest.config.ts — unit test config for the web app.
//
// This is the default config picked up by `pnpm test` (which runs
// `vitest run`). It targets the colocated server + route + component
// test files; integration tests live under tests/integration/ and run
// via `pnpm test:integration` (separate vitest.integration.config.ts).
//
// Why a separate config from vitest.integration.config.ts:
//   - Integration tests share a Postgres DB and run in singleFork mode.
//     We do NOT want unit tests blocked behind a Postgres spinup or
//     fighting the integration harness for connection slots.
//   - Unit tests are pure mocks / fakes / in-memory state. They should
//     run in <5s on a fresh checkout with no DATABASE_URL set.
//
// Globals: NOT enabled. We import { describe, it, expect, vi } from
// vitest explicitly so test files are grep-able + linter-friendly.

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '~': resolve(here, 'app'),
    },
  },
  test: {
    environment: 'node',
    // Pick up colocated unit tests (server/*.test.ts, app/**/*.test.tsx).
    // The integration config explicitly overrides `include` to point at
    // tests/integration/** — see vitest.integration.config.ts.
    include: [
      'server/**/*.test.ts',
      'app/**/*.test.{ts,tsx}',
    ],
    // Ignore generated types + integration test roots.
    exclude: [
      'node_modules/**',
      'dist/**',
      '.react-router/**',
      '../../tests/integration/**',
    ],
    setupFiles: [resolve(here, 'vitest.setup.ts')],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Force sequential for DB-backed module-mock unit tests so the
    // mocked @edusupervise/db state (mockReturnValueOnce queues, etc.)
    // doesn't interleave across workers. Pure-component tests are
    // fast enough that singleFork is fine.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});