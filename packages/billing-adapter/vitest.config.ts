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
  // Inline these CJS modules so vite transforms them as ESM instead of
  // leaving them as Proxies. The Stripe SDK + axios + many transitive deps
  // are CJS; on Node 24 + vite SSR loader their default exports sometimes
  // arrive as Proxies whose `[Symbol.hasInstance]` is not callable, which
  // breaks both pino's `instanceof SonicBoom` check (defensive) and any
  // `new SomeConstructor()` calls inside the SDKs at module-load time.
  server: {
    deps: {
      inline: [
        'pino',
        'sonic-boom',
        'atomic-sleep',
        'pino-std-serializers',
        'pino-abstract-transport',
        'thread-stream',
        'on-exit-leak-free',
        'quick-format-unescaped',
        'safe-stable-stringify',
        '@pinojs/redact',
        'process-warning',
        'real-require',
        'stripe',
        'semver',
        'qs',
        '@types/node',
      ],
    },
  },
});
