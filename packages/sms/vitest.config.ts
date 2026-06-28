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
  // leaving them as Proxies. The Twilio SDK transitively requires `semver`
  // and does `new SemVer(...)` at module-load time; the Proxy wrap on
  // `semver` makes the constructor symbol uncallable. Same issue
  // (`instanceof` + `new Constructor()` with wrapped CJS modules) applies
  // to pino's transitive CJS deps — kept on the list defensively.
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
        'twilio',
        'semver',
        'axios',
        'dayjs',
        'jsonwebtoken',
        'qs',
        'scmp',
        'xmlbuilder',
        'https-proxy-agent',
      ],
    },
  },
});
