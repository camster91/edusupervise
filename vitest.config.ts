import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },   // serial: tests share one DB
    },
  },
  resolve: {
    // Resolve `@edusupervise/*` workspace imports to source .ts files
    // (vitest can't follow pnpm symlinks the same way tsx/esbuild does
    // when the source is `.ts` rather than `dist/*.js`).
    alias: {
      "@edusupervise/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      "@edusupervise/db/schema": new URL("./packages/db/src/schema.ts", import.meta.url).pathname,
      "@edusupervise/db/client": new URL("./packages/db/src/client.ts", import.meta.url).pathname,
      "@edusupervise/db/rls": new URL("./packages/db/src/rls.ts", import.meta.url).pathname,
      "@edusupervise/db/cycle-math": new URL("./packages/db/src/cycle-math.ts", import.meta.url).pathname,
      "@edusupervise/schemas": new URL("./packages/schemas/src/index.ts", import.meta.url).pathname,
      "@edusupervise/schemas/auth": new URL("./packages/schemas/src/auth.ts", import.meta.url).pathname,
      "~": new URL("./apps/web/app", import.meta.url).pathname,
    },
  },
  server: {
    deps: {
      // Inline these CJS modules so vite transforms them as ESM instead of
      // leaving them as Proxies. better-auth's transitive dep tree
      // (`bcryptjs`, `better-call`, `defu`, `nanoid`) needs the same
      // treatment that the provider-adapter packages use for pino /
      // twilio.
      inline: [
        "bcryptjs",
        "better-call",
        "defu",
        "nanoid",
        "zod",
        "zod-to-json-schema",
        // better-auth itself is published as ESM but its runtime deps
        // (especially `better-auth/dist/api/*` files that import `nano`
        // for nanoid) trip over the Proxy wrap without explicit inlining.
        "better-auth",
        "@better-auth/core",
        "@better-auth/drizzle-adapter",
        "@better-fetch/fetch",
        "cookie",
        "jose",
      ],
    },
  },
});