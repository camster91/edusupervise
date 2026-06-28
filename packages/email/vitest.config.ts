import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    isolate: true,
  },
  // Vitest's vite-based loader wraps CommonJS modules (pino, sonic-boom) in
  // a Proxy that breaks `instanceof` checks inside pino itself. Inlining them
  // makes vite transform them as ESM and the instanceof checks work again.
  server: {
    deps: {
      inline: ['pino', 'sonic-boom', 'atomic-sleep'],
    },
  },
});