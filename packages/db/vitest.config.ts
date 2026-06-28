import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    isolate: true,
  },
  // The cycle-math module is pure (no node:net / node:fs imports) so the
  // default vite transform works fine — no `server.deps.inline` overrides
  // needed here. Keep this block as a documented no-op for future readers.
  server: {
    deps: {
      inline: [],
    },
  },
});
