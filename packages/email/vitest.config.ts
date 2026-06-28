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
  // Inlining these CJS modules makes vite transform them as ESM instead of
  // leaving them as Proxies. Pino 9.x's `opts instanceof SonicBoom` branch
  // throws when SonicBoom arrives Proxy-wrapped (Node 24 + vite SSR loader +
  // pnpm symlinked tree). With pino replaced by a tiny in-package JSON logger
  // this is now mostly belt-and-suspenders, but keep the inline list so the
  // tests don't trip on pino's transitive CJS deps if they're re-introduced.
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
      ],
    },
  },
});