// apps/web/vitest.integration.config.ts — integration test config for web app.
//
// Points at tests/integration/**/*.test.ts with the global setup that
// reads DATABASE_URL etc. Runs serially (single fork) because the
// integration tests share one Postgres database — they would race
// on TRUNCATE between tests if multiple forks were spawned.
//
// Verify: pnpm test:integration

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '~': new URL('./app/', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['../../tests/integration/**/*.test.ts'],
    setupFiles: ['../../tests/integration/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // Filter our the repo-root unit tests (cycle-math, etc.) — those
    // run via `pnpm test` from the repo root, not from apps/web.
  },
});