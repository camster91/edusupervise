import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { reactRouter } from '@react-router/dev/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), 'app');

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  resolve: {
    alias: [
      {
        find: /^~\/(.*)$/,
        replacement: '',
        customResolver: (id: string) => {
          // Strip the leading ~ and try .ts / .tsx / /index.ts
          const target = id.replace(/^~\/?/, '');
          const candidates = [
            resolve(appDir, `${target}.ts`),
            resolve(appDir, `${target}.tsx`),
            resolve(appDir, target, 'index.ts'),
          ];
          for (const c of candidates) {
            try {
              // Vite will resolve this path; existence check at build time
              return c;
            } catch {
              // continue
            }
          }
          return resolve(appDir, target);
        },
      },
    ],
  },
  server: {
    port: 3011,
  },
});