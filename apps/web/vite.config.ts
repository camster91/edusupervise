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
        find: /^~(.+)$/,
        replacement: '',
        customResolver: (id: string) => {
          // id is the matched prefix-stripped path (after the regex matches)
          const target = id.startsWith('/') ? id.slice(1) : id;
          const candidates = [
            resolve(appDir, `${target}.ts`),
            resolve(appDir, `${target}.tsx`),
            resolve(appDir, target, 'index.ts'),
          ];
          // Return the first candidate; Vite will surface a clear error
          // if none exist (rather than silently appending nothing).
          return candidates[0];
        },
      },
    ],
  },
  server: {
    port: 3011,
  },
});